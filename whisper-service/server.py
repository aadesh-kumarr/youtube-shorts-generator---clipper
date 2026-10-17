from flask import Flask, request, jsonify
from flask_cors import CORS
from faster_whisper import WhisperModel, BatchedInferencePipeline, decode_audio
import torch
import os
import shutil
import cv2
import numpy as np
import subprocess
import sys
import tempfile
import time
import gc
import threading

# Force UTF-8 for stdout and stderr to prevent UnicodeEncodeError in Windows cmd/powershell
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Ensure FFmpeg path is visible
if not shutil.which("ffmpeg"):
    winget_ffmpeg_path = os.path.expanduser(r"~\AppData\Local\Microsoft\WinGet\Packages")
    for root, dirs, files in os.walk(winget_ffmpeg_path):
        if "ffmpeg.exe" in files:
            os.environ["PATH"] += os.pathsep + root
            break

# ── Face detection: OpenCV YuNet ──────────────────────────────────────────
# MediaPipe's legacy `mp.solutions.face_detection` API was removed in 0.10.30+
# and 1.x, and the Tasks replacement only ships a SHORT-RANGE model which cannot
# see the small faces in a wide podcast two-shot (~4% of frame width).
# YuNet handles those reliably and ships as a 230 KB ONNX model.
#
# Measured on real footage (1920x1080 podcast, score_threshold=0.7):
#   wide two-shot  → 2 faces at cx≈0.26 / cx≈0.77, 0% miss
#   single close-up → 1 face, never a false second face
FACE_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'models', 'face_detection_yunet_2023mar.onnx')

# Faces smaller than this fraction of frame width are ignored (posters, background people).
# Wide two-shot faces measure ~0.038, so this must stay below that.
MIN_FACE_REL_WIDTH = 0.030

# Detection runs on a downscaled copy of the frame. Measured on real footage:
# 1920x1080 → 19 detections/s, 960x540 → 47/s, with IDENTICAL face counts and
# dual-speaker decisions. Coordinates are normalised, so the rest of the pipeline
# is unaffected. A 4%-wide face is still 38 px at this scale — plenty for YuNet.
DETECT_SCALE = 0.5


def _make_face_detector(frame_w, frame_h, min_confidence=0.7):
    """Creates an OpenCV YuNet detector sized for the DOWNSCALED detection frame.
    Returns (detector, detect_w, detect_h)."""
    if not os.path.exists(FACE_MODEL_PATH):
        raise FileNotFoundError(
            f"Face detection model missing at {FACE_MODEL_PATH}. Download it from "
            "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/"
            "face_detection_yunet_2023mar.onnx"
        )
    dw = max(320, int(frame_w * DETECT_SCALE))
    dh = max(180, int(frame_h * DETECT_SCALE))
    detector = cv2.FaceDetectorYN.create(
        FACE_MODEL_PATH, "", (dw, dh),
        score_threshold=min_confidence,
        nms_threshold=0.3,
        top_k=10,
    )
    return detector, dw, dh


def _detect_faces_relative(detector, frame_bgr, detect_w, detect_h):
    """Detects on a downscaled frame and returns faces as RELATIVE (0-1) coordinates."""
    small = cv2.resize(frame_bgr, (detect_w, detect_h))
    _, raw = detector.detect(small)
    faces = []
    if raw is not None:
        for f in raw:
            x, y, fw, fh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
            faces.append({
                'cx': (x + fw / 2) / detect_w,
                'cy': (y + fh / 2) / detect_h,
                'w': fw / detect_w,
                'h': fh / detect_h,
            })
    return faces


def _deduplicate_faces(raw_faces):
    """Remove duplicate detections of the same face.
    Two bboxes whose centers are within 30% of frame width are the same person —
    keep only the larger one. Stops MediaPipe double-detecting one person."""
    deduped = []
    for face in sorted(raw_faces, key=lambda f: -f['w']):  # largest first
        duplicate = False
        for kept in deduped:
            if abs(face['cx'] - kept['cx']) < 0.30:  # within 30% → same person
                duplicate = True
                break
        if not duplicate:
            deduped.append(face)
    return deduped


def _validate_video(input_path, timeout=20):
    """Rejects truncated/corrupt files BEFORE handing them to OpenCV.

    cv2.VideoCapture.read() can spin forever on a partially-written MP4 —
    isOpened() still returns True, but decoding never yields a frame and the
    thread burns a full core indefinitely. Flask worker threads cannot be
    killed, so one bad file permanently costs a core until the server restarts.
    ffprobe fails fast and gives us a real error message instead.
    """
    if not os.path.exists(input_path):
        raise Exception(f"Input video not found: {input_path}")

    size = os.path.getsize(input_path)
    if size < 100 * 1024:  # a real segment is megabytes; anything tiny is a failed download
        raise Exception(f"Input video is only {size} bytes — download likely failed: {input_path}")

    try:
        probe = subprocess.run(
            ['ffprobe', '-v', 'error',
             '-select_streams', 'v:0',
             '-show_entries', 'stream=codec_name,width,height',
             '-of', 'default=noprint_wrappers=1:nokey=1',
             input_path],
            capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"ffprobe timed out on {input_path} — file is unreadable")
    except FileNotFoundError:
        print("[Face Tracker] ffprobe not on PATH; skipping pre-flight validation.")
        return

    out = probe.stdout.decode(errors='replace').split()
    if probe.returncode != 0 or len(out) < 3:
        err = probe.stderr.decode(errors='replace')[-200:].strip()
        raise Exception(f"No decodable video stream in {os.path.basename(input_path)}: {err or 'unknown'}")


def crop_video_face_tracking(input_path, output_path, layout='center'):
    """Dynamic face-tracking crop with per-frame layout switching.
    layout='stacked'  → prefer split-screen when 2 confirmed separate faces detected;
                        automatically falls back to full-screen when only 1 face is visible.
    layout='center'   → always full-screen, follow primary face horizontally.
    Layout can change mid-clip as many times as needed."""

    print(f"\n--- [Face Tracker] Starting dynamic reframing ({layout}) for: {input_path} ---")

    _validate_video(input_path)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open input video: {input_path}")

    ret, first_frame = cap.read()
    if not ret:
        cap.release()
        raise Exception("Failed to read first frame")

    H, W, _ = first_frame.shape
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0 or np.isnan(fps):
        fps = 30.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    face_detection, det_w, det_h = _make_face_detector(W, H, min_confidence=0.7)

    t_start = time.time()
    ffmpeg_proc = None
    ffmpeg_err = None

    try:

        # ── Crop dimensions ────────────────────────────────────────────────
        # Full-screen (9:16): full height, 9/16 width
        fs_crop_h = H
        fs_crop_w = int(H * 9 / 16)
        if fs_crop_w % 2: fs_crop_w -= 1

        # Split panel (9:8 each, stacked → 9:16 total): 75% height per panel
        sp_crop_h = int(H * 0.75)
        sp_crop_w = int(sp_crop_h * 9 / 8)
        if sp_crop_w % 2: sp_crop_w -= 1
        if sp_crop_h % 2: sp_crop_h -= 1

        # ── Smooth-camera state (exponential moving average) ───────────────
        alpha = 0.04          # smoothing factor (lower = smoother but more lag)
        dead_zone = 35        # pixels — ignore tiny movements

        # Full-screen camera position
        x_fs = max(0, min(W - fs_crop_w, (W - fs_crop_w) // 2))

        # Split-screen camera positions (left panel = top, right panel = bottom)
        x_left  = max(0, min(W - sp_crop_w, int(W * 0.25 - sp_crop_w // 2)))
        y_left  = max(0, min(H - sp_crop_h, (H - sp_crop_h) // 2))
        x_right = max(0, min(W - sp_crop_w, int(W * 0.75 - sp_crop_w // 2)))
        y_right = max(0, min(H - sp_crop_h, (H - sp_crop_h) // 2))

        # ── Layout hysteresis ─────────────────────────────────────────────
        # Rolling window: True = this frame confirmed dual speaker
        WINDOW      = 15   # frames to look back
        TO_SPLIT    = 9    # dual frames needed to switch → split  (60%)
        TO_CENTER   = 5    # dual frames threshold below which → back to center (33%)
        dual_history = []
        current_layout = 'center'  # always start full-screen; switch only on evidence
        split_frames_used = 0
        total_frames = 0

        # ── FFmpeg pipe ───────────────────────────────────────────────────
        # NOTE: stderr must NOT be a pipe we only read at the end. FFmpeg writes
        # progress to stderr; once the OS pipe buffer (~64 KB) fills, FFmpeg blocks
        # on write, stops draining stdin, and this loop blocks writing frames —
        # a deadlock where both processes wait on each other forever.
        # Writing stderr to a temp file can never block.
        ffmpeg_cmd = [
            'ffmpeg', '-y',
            '-loglevel', 'error', '-nostats',
            '-f', 'rawvideo', '-pix_fmt', 'bgr24',
            '-s', '1080x1920', '-r', str(fps),
            '-i', 'pipe:0',
            '-i', input_path,
            '-map', '0:v', '-map', '1:a?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '22',
            '-c:a', 'aac',
            output_path
        ]
        ffmpeg_err = tempfile.TemporaryFile()
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd, stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=ffmpeg_err,
        )

        frame_idx = 0
        cached_faces = []   # list of deduped face dicts from last detection run

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            h, w = frame.shape[:2]

            # ── Face detection (every 3rd frame for performance) ──────────
            if frame_idx % 3 == 0:
                detected = _detect_faces_relative(face_detection, frame, det_w, det_h)
                # Skip tiny faces (posters/background) and detections near the very bottom
                raw = [f for f in detected
                       if f['w'] >= MIN_FACE_REL_WIDTH and f['cy'] < 0.85]
                cached_faces = _deduplicate_faces(raw)

            faces = cached_faces

            # ── Dual-speaker check ────────────────────────────────────────
            # Conditions for a genuine 2-person shot:
            # 1. At least 2 faces after deduplication
            # 2. One face on each half of the frame
            # 3. The two face centers must be at least 30% of frame width apart
            #    (prevents same person detected at slightly different positions being counted as 2)
            is_dual = False
            if len(faces) >= 2:
                left_faces  = [f for f in faces if f['cx'] < 0.5]
                right_faces = [f for f in faces if f['cx'] >= 0.5]
                if left_faces and right_faces:
                    lf_cx = max(left_faces,  key=lambda f: f['w'])['cx']
                    rf_cx = max(right_faces, key=lambda f: f['w'])['cx']
                    # Require genuine separation between the two speakers
                    if (rf_cx - lf_cx) >= 0.30:
                        is_dual = True

            dual_history.append(is_dual)
            if len(dual_history) > WINDOW:
                dual_history.pop(0)

            dual_count = sum(dual_history)

            # ── Hysteresis layout decision ────────────────────────────────
            if layout == 'stacked':
                if current_layout == 'center':
                    # Need strong evidence before switching to split
                    if dual_count >= TO_SPLIT:
                        current_layout = 'stacked'
                        print(f"[Face Tracker] Frame {frame_idx}: switching → SPLIT ({dual_count}/{len(dual_history)} dual frames)")
                else:  # currently stacked
                    # Switch back to full-screen if dual evidence drops
                    if dual_count < TO_CENTER:
                        current_layout = 'center'
                        print(f"[Face Tracker] Frame {frame_idx}: switching → FULLSCREEN ({dual_count}/{len(dual_history)} dual frames)")
            # layout='center' → current_layout stays 'center' always

            # ── Render frame ──────────────────────────────────────────────
            if current_layout == 'stacked' and is_dual:
                # Pick the best face from each half (largest = most prominent speaker)
                left_faces  = [f for f in faces if f['cx'] < 0.5]
                right_faces = [f for f in faces if f['cx'] >= 0.5]
                lf = max(left_faces,  key=lambda f: f['w'])
                rf = max(right_faces, key=lambda f: f['w'])

                # Target crop positions centered on each face
                lx_t = int(lf['cx'] * w) - sp_crop_w // 2
                ly_t = int(lf['cy'] * h) - sp_crop_h // 2
                rx_t = int(rf['cx'] * w) - sp_crop_w // 2
                ry_t = int(rf['cy'] * h) - sp_crop_h // 2

                # Clamp
                lx_t = max(0, min(w - sp_crop_w, lx_t))
                ly_t = max(0, min(h - sp_crop_h, ly_t))
                rx_t = max(0, min(w - sp_crop_w, rx_t))
                ry_t = max(0, min(h - sp_crop_h, ry_t))

                # Dead-zone + smooth
                if abs(lx_t - x_left)  < dead_zone: lx_t = x_left
                if abs(ly_t - y_left)  < dead_zone: ly_t = y_left
                if abs(rx_t - x_right) < dead_zone: rx_t = x_right
                if abs(ry_t - y_right) < dead_zone: ry_t = y_right

                x_left  = int(alpha * lx_t + (1 - alpha) * x_left)
                y_left  = int(alpha * ly_t + (1 - alpha) * y_left)
                x_right = int(alpha * rx_t + (1 - alpha) * x_right)
                y_right = int(alpha * ry_t + (1 - alpha) * y_right)

                x_left  = max(0, min(w - sp_crop_w, x_left))
                y_left  = max(0, min(h - sp_crop_h, y_left))
                x_right = max(0, min(w - sp_crop_w, x_right))
                y_right = max(0, min(h - sp_crop_h, y_right))

                lc = frame[y_left:y_left + sp_crop_h, x_left:x_left + sp_crop_w]
                rc = frame[y_right:y_right + sp_crop_h, x_right:x_right + sp_crop_w]

                if lc.shape[:2] != (sp_crop_h, sp_crop_w):
                    lc = cv2.resize(lc, (sp_crop_w, sp_crop_h)) if lc.size > 0 else np.zeros((sp_crop_h, sp_crop_w, 3), np.uint8)
                if rc.shape[:2] != (sp_crop_h, sp_crop_w):
                    rc = cv2.resize(rc, (sp_crop_w, sp_crop_h)) if rc.size > 0 else np.zeros((sp_crop_h, sp_crop_w, 3), np.uint8)

                top = cv2.resize(lc, (1080, 960))
                bot = cv2.resize(rc, (1080, 960))
                output_frame = np.vstack((top, bot))
                split_frames_used += 1

            else:
                # Full-screen: track primary face horizontally
                x_fs_t = (w - fs_crop_w) // 2   # default center
                if faces:
                    primary = sorted(faces, key=lambda f: -f['w'])[0]  # largest face = primary speaker
                    x_fs_t = int(primary['cx'] * w) - fs_crop_w // 2
                    x_fs_t = max(0, min(w - fs_crop_w, x_fs_t))

                if abs(x_fs_t - x_fs) < dead_zone:
                    x_fs_t = x_fs
                x_fs = int(alpha * x_fs_t + (1 - alpha) * x_fs)
                x_fs = max(0, min(w - fs_crop_w, x_fs))

                crop = frame[0:fs_crop_h, x_fs:x_fs + fs_crop_w]
                if crop.shape[:2] != (fs_crop_h, fs_crop_w):
                    crop = cv2.resize(crop, (fs_crop_w, fs_crop_h)) if crop.size > 0 else np.zeros((fs_crop_h, fs_crop_w, 3), np.uint8)

                output_frame = cv2.resize(crop, (1080, 1920))

            ffmpeg_proc.stdin.write(output_frame.tobytes())
            frame_idx += 1
            total_frames += 1

            # Progress heartbeat so a stall is visible in the server log
            if frame_idx % 100 == 0:
                elapsed = time.time() - t_start
                print(f"[Face Tracker] {frame_idx} frames | {frame_idx / max(elapsed, 0.001):.1f} fps "
                      f"| layout={current_layout} | split so far={split_frames_used}", flush=True)

        ffmpeg_proc.stdin.close()
        ffmpeg_proc.wait()
        if ffmpeg_proc.returncode != 0:
            ffmpeg_err.seek(0)
            err_text = ffmpeg_err.read().decode(errors='replace')[-800:]
            ffmpeg_err.close()
            print(f"[Face Tracker Error] FFmpeg encoding failed:\n{err_text}")
            raise Exception(f"FFmpeg pipe encoding failed: {err_text[-300:]}")
        ffmpeg_err.close()

        actual = 'stacked' if split_frames_used > total_frames * 0.3 else 'center'
        split_pct = (split_frames_used / total_frames * 100) if total_frames else 0
        print(f"[Face Tracker] Done in {time.time() - t_start:.1f}s. {total_frames} frames | "
              f"{split_frames_used} split ({split_pct:.0f}%) | actual_layout={actual}\n", flush=True)
        return actual

    finally:
        cap.release()
        # Never leave a stuck ffmpeg behind on error
        if ffmpeg_proc is not None and ffmpeg_proc.poll() is None:
            try:
                ffmpeg_proc.stdin.close()
            except Exception:
                pass
            try:
                ffmpeg_proc.kill()
            except Exception:
                pass
        if ffmpeg_err is not None:
            try:
                ffmpeg_err.close()
            except Exception:
                pass


app = Flask(__name__)
CORS(app)

# Auto-detect CUDA GPU, fallback to CPU
device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "int8_float16" if device == "cuda" else "int8"
print(f"Using device: {device.upper()}")
print(f"Compute type: {compute_type.upper()}")

if device == "cuda":
    print(f"GPU Model: {torch.cuda.get_device_name(0)}")

# large-v3-turbo is a distilled model: roughly 4x faster, but it gives up most of
# that speed advantage as accuracy on non-English audio. The Hindi/Hinglish
# sources this pipeline runs on were coming back with consistently mangled proper
# nouns, so the default is the full model. Set WHISPER_MODEL=large-v3-turbo to
# trade back for speed on English-only material.
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3")

# Proper nouns Whisper reliably mangles on this content. faster-whisper feeds
# `hotwords` to the decoder as a bias, which is the supported remedy for named
# entities -- doubly needed here because condition_on_previous_text=False leaves
# the model no conversational context to infer them from.
DEFAULT_HOTWORDS = os.environ.get("WHISPER_HOTWORDS", "").strip()

# Languages this pipeline is allowed to produce.
#
# Whisper routinely tags Hindustani speech as Urdu -- spoken Hindi and Urdu are
# near-identical, and the model resolves the ambiguity by script. Left to detect
# freely it emits Arabic script, which is unreadable to the Hindi audience these
# clips are cut for, and the metadata pass then dutifully writes its titles and
# captions in Urdu to match the transcript.
ALLOWED_LANGUAGES = [
    code.strip().lower()
    for code in os.environ.get("WHISPER_ALLOWED_LANGUAGES", "hi,en").split(",")
    if code.strip()
]

# Detections that are really the allowed language wearing another script or a
# closely related label. Mapped rather than trusted.
LANGUAGE_COERCIONS = {
    "ur": "hi",   # the common one: same speech, Arabic script
    "pa": "hi",
    "mr": "hi",
    "ne": "hi",
    "sa": "hi",
    "gu": "hi",
    "bh": "hi",
    "fa": "hi",   # turns up on Urdu-leaning audio
}


def coerce_language(detected):
    """Maps a detected language onto the allowlist.

    Returns None when there is nothing to pin, which leaves Whisper to decide.
    """
    if not ALLOWED_LANGUAGES:
        return detected
    if not detected:
        return ALLOWED_LANGUAGES[0]

    detected = detected.lower()
    if detected in ALLOWED_LANGUAGES:
        return detected

    mapped = LANGUAGE_COERCIONS.get(detected)
    if mapped and mapped in ALLOWED_LANGUAGES:
        print(f"[Whisper Backend] Detected '{detected}' -- forcing '{mapped}' "
              f"(allowlist: {','.join(ALLOWED_LANGUAGES)})")
        return mapped

    fallback = ALLOWED_LANGUAGES[0]
    print(f"[Whisper Backend] Detected '{detected}', which is not allowed. "
          f"Falling back to '{fallback}'.")
    return fallback


model = None
base_model = None
whisper_model_lock = threading.RLock()

def load_whisper_model():
    """Loads faster-whisper model into VRAM on demand with BatchedInferencePipeline for 2-4x GPU throughput."""
    global model, base_model
    with whisper_model_lock:
        if model is None:
            print(f"\n[Whisper Backend] Loading Faster-Whisper ({MODEL_SIZE}) into VRAM ({device.upper()} / {compute_type})...")
            try:
                base = WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)
            except Exception as e:
                print(f"[Whisper Backend] Failed to load {MODEL_SIZE} ({e}). Falling back to 'large-v3'...")
                base = WhisperModel("large-v3", device=device, compute_type=compute_type)
            base_model = base
            model = BatchedInferencePipeline(model=base)
            print("[Whisper Backend] Whisper model loaded into VRAM successfully (BatchedInferencePipeline)!\n")
        return model

def unload_whisper_model():
    """Frees whisper model from VRAM to make room for LLM / FFmpeg."""
    global model, base_model
    with whisper_model_lock:
        if model is not None:
            print("\n[Whisper Backend] Unloading Whisper model from VRAM...")
            del model
            model = None
            base_model = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
            print("[Whisper Backend] VRAM freed successfully!\n")

@app.route('/load', methods=['POST', 'GET'])
def load():
    load_whisper_model()
    return jsonify({'success': True, 'message': 'Whisper model loaded into VRAM.'})

@app.route('/unload', methods=['POST', 'GET'])
def unload():
    unload_whisper_model()
    return jsonify({'success': True, 'message': 'Whisper model unloaded from VRAM.'})

@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    suffix = os.path.splitext(file.filename)[1] or '.wav'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temp_path = tmp.name
    tmp.close()
    file.save(temp_path)

    # Faster-Whisper and its CUDA allocations are shared process globals. A
    # second threaded Flask request must not load or unload them mid-inference.
    if not whisper_model_lock.acquire(blocking=False):
        os.remove(temp_path)
        return jsonify({'error': 'Whisper is busy processing another request'}), 429

    # Language is pinned by the caller rather than auto-detected. Left to detect,
    # Whisper picks one language per file and then still code-switches inside it --
    # which is how clips cut from a single Hindi source came back some in
    # Devanagari and some transliterated into Latin. Send "auto" for the old behaviour.
    language = (request.form.get('language') or '').strip() or None
    if language in ('auto', 'detect'):
        language = None

    if language:
        language = coerce_language(language)

    initial_prompt = (request.form.get('initial_prompt') or '').strip() or None
    hotwords = (request.form.get('hotwords') or '').strip() or DEFAULT_HOTWORDS or None

    print("")
    print(f"--- [Whisper Backend] Starting GPU Transcription for: {file.filename} ---")
    print(f"[Whisper Backend] language={language or 'auto-detect'} | "
          f"hotwords={'yes' if hotwords else 'no'} | "
          f"initial_prompt={'yes' if initial_prompt else 'no'}")

    try:
        whisper = load_whisper_model()

        # Detect first, then pin. Detection reads only the opening seconds, so
        # this is cheap -- and pinning the coerced result is what stops the
        # transcript coming back in the wrong script.
        if language is None and ALLOWED_LANGUAGES:
            try:
                detected, probability, _ = base_model.detect_language(
                    audio=decode_audio(temp_path, sampling_rate=16000)
                )
                print(f"[Whisper Backend] Language detection: {detected} "
                      f"({probability:.2f})")
                language = coerce_language(detected)
            except Exception as detect_err:
                print(f"[Whisper Backend] Language detection failed "
                      f"({detect_err}); leaving Whisper to decide.")

        # Robust anti-hallucination transcription parameters
        # beam_size=5 avoids greedy repetitive traps
        # repetition_penalty=1.2 and no_repeat_ngram_size=3 stops looping phrases
        # compression_ratio_threshold=2.4 automatically discards repetitive loops
        # temperature fallback handles quiet or ambiguous audio gracefully
        segments, info = whisper.transcribe(
            temp_path,
            batch_size=16,
            # Pinned by the caller; None falls back to auto-detect.
            language=language,
            # Stated explicitly. Left unset, the model drifts into translating
            # Hindi into English partway through a file.
            task="transcribe",
            initial_prompt=initial_prompt,
            hotwords=hotwords,
            beam_size=5,
            best_of=5,
            temperature=[0.0, 0.2, 0.4],
            repetition_penalty=1.2,
            no_repeat_ngram_size=3,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=400,
                speech_pad_ms=200,
                threshold=0.5
            ),
            condition_on_previous_text=False,
        )

        print(f"[Whisper Backend] Detected language: {info.language} (probability: {info.language_probability:.2f})")

        words = []
        segment_texts = []
        for segment in segments:
            clean_text = segment.text.strip()
            # Skip empty or glitchy single-character repetition artifacts
            if not clean_text or clean_text == "..." or clean_text == "":
                continue

            segment_texts.append(clean_text)
            try:
                print(f"[{segment.start:.2f}s -> {segment.end:.2f}s] {clean_text}")
            except Exception:
                pass
            if segment.words:
                for w in segment.words:
                    word_clean = w.word.strip()
                    if word_clean and word_clean != "":
                        words.append({
                            "word": word_clean,
                            "start": float(w.start),
                            "end": float(w.end)
                        })

        full_text = "".join(segment_texts).strip()
        print(f"--- [Whisper Backend] Completed {len(words)} words on GPU! ---\n")

        # Automatically unload from VRAM immediately after transcription completes
        unload_whisper_model()

        return jsonify({
            'text': full_text,
            'words': words
        })

    except Exception as e:
        print(f"[Error] Transcription failed: {str(e)}")
        unload_whisper_model()
        return jsonify({'error': str(e)}), 500

    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        whisper_model_lock.release()

@app.route('/crop_face', methods=['POST'])
def crop_face():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing JSON body'}), 400
        
    input_path = data.get('input_path')
    output_path = data.get('output_path')
    layout = data.get('layout', 'center')
    
    if not input_path or not output_path:
        return jsonify({'error': 'input_path and output_path are required'}), 400
        
    if not os.path.exists(input_path):
        return jsonify({'error': f'Input file not found: {input_path}'}), 404
        
    try:
        actual_layout = crop_video_face_tracking(input_path, output_path, layout)
        return jsonify({
            'success': True,
            'message': 'Face tracking vertical crop completed successfully.',
            'output_path': output_path,
            'actual_layout': actual_layout
        })
    except Exception as e:
        print(f"[Error] Face tracking crop failed: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, threaded=True)


