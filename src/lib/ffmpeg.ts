import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Agent } from 'undici';
import { hhmmssToSeconds } from './ai-hooks';
import { CONFIG } from './config';

// Set the binary paths from node_modules
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * Escapes backslashes and colons for the FFmpeg subtitles filter.
 * To make it cross-platform and robust on Windows, we convert the path
 * to a relative path from the current working directory, which removes
 * any drive letters (e.g. D:) and colons entirely.
 */
function escapeSubtitlesPath(filePath: string): string {
  // Get path relative to the process current working directory
  const relativePath = path.relative(process.cwd(), filePath);
  // Replace backslashes with forward slashes for FFmpeg compatibility
  return relativePath.replace(/\\/g, '/');
}

/**
 * The subtitles filter argument, with a font directory when one is configured.
 *
 * Without fontsdir libass can only use fonts installed system-wide, so a font
 * shipped with the project is invisible to it and the style silently falls back.
 */
function subtitlesFilter(assPath: string): string {
  const escaped = escapeSubtitlesPath(assPath);
  if (!CONFIG.CAPTION_FONTS_DIR) return `subtitles='${escaped}'`;
  const dir = CONFIG.CAPTION_FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');
  return `subtitles='${escaped}':fontsdir='${dir}'`;
}

export type WatermarkMode = 'off' | 'crop' | 'delogo';

export interface WatermarkMaskOptions {
  mode?: WatermarkMode;
  /** "x,y,w,h" as fractions of the frame. */
  region?: string;
}

function parseRegion(region: string): { x: number; y: number; w: number; h: number } | null {
  const parts = region.split(',').map(v => parseFloat(v.trim()));
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null;
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return null;
  return { x, y, w, h };
}

/**
 * Removes the source channel's watermark from a segment.
 *
 * Runs BEFORE the face tracker rather than on the finished 9:16 render: by the
 * time the tracker has cropped and scaled, the logo has moved to a position that
 * depends on where the faces were, so there is no fixed region left to target.
 *
 * Returns the path to use downstream — the original path when masking is off or
 * the region cannot be parsed, so a bad setting degrades to "unchanged" rather
 * than to a failed render.
 */
export function maskSourceWatermark(
  inputVideoPath: string,
  outputVideoPath: string,
  options: WatermarkMaskOptions = {}
): Promise<string> {
  return new Promise((resolve) => {
    const mode = options.mode ?? CONFIG.WATERMARK_MODE;
    if (mode === 'off') return resolve(inputVideoPath);

    const region = parseRegion(options.region ?? CONFIG.WATERMARK_REGION);
    if (!region) {
      console.warn(
        `[ffmpeg] Watermark region "${options.region ?? CONFIG.WATERMARK_REGION}" is not a valid ` +
        `"x,y,w,h" fraction set. Leaving the frame unmasked.`
      );
      return resolve(inputVideoPath);
    }

    let filter: string;
    if (mode === 'crop') {
      // Take off the smallest edge strip that swallows the region. Only the edge
      // the mark actually touches is trimmed, so a corner logo costs one strip.
      const fromTop = region.y;
      const fromBottom = 1 - (region.y + region.h);
      const fromLeft = region.x;
      const fromRight = 1 - (region.x + region.w);
      const nearest = Math.min(fromTop, fromBottom, fromLeft, fromRight);

      if (nearest === fromTop) {
        const cut = region.y + region.h;
        filter = `crop=iw:ih*${(1 - cut).toFixed(4)}:0:ih*${cut.toFixed(4)}`;
      } else if (nearest === fromBottom) {
        filter = `crop=iw:ih*${region.y.toFixed(4)}:0:0`;
      } else if (nearest === fromLeft) {
        const cut = region.x + region.w;
        filter = `crop=iw*${(1 - cut).toFixed(4)}:ih:iw*${cut.toFixed(4)}:0`;
      } else {
        filter = `crop=iw*${region.x.toFixed(4)}:ih:0:0`;
      }
    } else {
      // delogo needs a ring of surrounding pixels to interpolate from, so the
      // box is inset by a pixel on every side it would otherwise sit flush with.
      const x = `max(1\\,iw*${region.x.toFixed(4)})`;
      const y = `max(1\\,ih*${region.y.toFixed(4)})`;
      const w = `min(iw*${region.w.toFixed(4)}\\,iw-${x}-1)`;
      const h = `min(ih*${region.h.toFixed(4)}\\,ih-${y}-1)`;
      filter = `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
    }

    console.log(`[ffmpeg] Masking source watermark (${mode}): ${filter}`);

    ffmpeg(inputVideoPath)
      .videoFilters([filter])
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        // Near-lossless: this is an intermediate the tracker and the real encode
        // both read, so it must not add a generation of loss of its own.
        '-crf 16',
        '-c:a copy',
        '-y',
      ])
      .on('end', () => {
        console.log(`[ffmpeg] Watermark mask applied: ${outputVideoPath}`);
        resolve(outputVideoPath);
      })
      .on('error', (err) => {
        // The clip is more important than the mask. Carry on with the original.
        console.error(`[ffmpeg] Watermark masking failed (${err.message}); using the unmasked segment.`);
        resolve(inputVideoPath);
      })
      .save(outputVideoPath);
  });
}

/**
 * Renders a vertical 9:16 clip with burned-in subtitles.
 * Optionally trims the input video if startTime and endTime are provided.
 *
 * @param inputVideoPath - Path to the source MP4 video
 * @param assPath - Path to the generated ASS subtitles file
 * @param outputVideoPath - Destination path for the rendered vertical clip
 * @param startTime - Optional start time for precision cutting
 * @param endTime - Optional end time for precision cutting
 * @param onProgress - Optional callback for tracking encoding progress percentage
 */
export function renderVerticalClipWithSubtitles(
  inputVideoPath: string,
  assPath: string,
  outputVideoPath: string,
  startTime?: string,
  endTime?: string,
  onProgress?: (percent: number) => void,
  cropLayout?: 'center' | 'left' | 'right' | 'stacked'
): Promise<{ videoPath: string; actualLayout: string; faceTrackingFailed: boolean; faceTrackingError: string }> {
  return new Promise(async (resolve, reject) => {
    // Ensure output directory exists
    const outputDir = path.dirname(outputVideoPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const subsFilter = subtitlesFilter(assPath);
    console.log(`[ffmpeg] Input video path: ${inputVideoPath}`);
    console.log(`[ffmpeg] Subtitle path: ${assPath}`);
    console.log(`[ffmpeg] Subtitle filter: ${subsFilter}`);
    console.log(`[ffmpeg] Output video path: ${outputVideoPath}`);
    console.log(`[ffmpeg] Selected crop layout: ${cropLayout || 'center'}`);

    let finalInputVideoPath = inputVideoPath;
    let skipCroppingInFfmpeg = false;
    let actualLayoutUsed = cropLayout || 'center';
    let faceTrackingFailed = false;
    let faceTrackingError = '';

    // Automated Face Tracking reframer using the python backend
    if (!cropLayout || cropLayout === 'center' || cropLayout === 'stacked') {
      console.log(`[ffmpeg] Querying Python face tracker for auto-reframing: ${inputVideoPath} (layout: ${cropLayout || 'center'})`);
      try {
        const croppedSegmentPath = path.join(
          process.cwd(),
          'tmp',
          `face_focused_${path.basename(inputVideoPath)}`
        );

        const response = await fetch(`${CONFIG.WHISPER_BACKEND_URL}/crop_face`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input_path: inputVideoPath,
            output_path: croppedSegmentPath,
            layout: cropLayout || 'center'
          }),
          dispatcher: new Agent({
            headersTimeout: 10 * 60 * 1000, // 10 minutes
            bodyTimeout: 10 * 60 * 1000,    // 10 minutes
          }),
        } as any);

        const data = await response.json().catch(() => ({}));
        if (response.ok && data.success) {
          console.log(`[ffmpeg] Python face tracking crop succeeded: ${croppedSegmentPath}`);
          finalInputVideoPath = croppedSegmentPath;
          skipCroppingInFfmpeg = true;
          actualLayoutUsed = data.actual_layout || actualLayoutUsed;
        } else {
          faceTrackingFailed = true;
          faceTrackingError = data.error || `HTTP ${response.status}`;
          console.error(
            `[ffmpeg] ❌ FACE TRACKING FAILED: ${faceTrackingError}\n` +
            `[ffmpeg]    Dynamic 1-face/2-face layout is UNAVAILABLE. Falling back to a safe center crop.`
          );
        }
      } catch (err: any) {
        faceTrackingFailed = true;
        faceTrackingError = err.message || String(err);
        console.error(
          `[ffmpeg] ❌ FACE TRACKING SERVER UNREACHABLE: ${faceTrackingError}\n` +
          `[ffmpeg]    Dynamic 1-face/2-face layout is UNAVAILABLE. Falling back to a safe center crop.`
        );
      }
    }

    // Split-screen requires per-frame face data. Without the tracker, a static
    // left/right split would show the SAME person in both panels whenever they
    // sit near the middle of the frame — so degrade to a center crop instead.
    if (faceTrackingFailed && (!cropLayout || cropLayout === 'stacked' || cropLayout === 'center')) {
      cropLayout = 'center';
      actualLayoutUsed = 'center';
    }

    let command = ffmpeg(finalInputVideoPath);

    if (startTime) {
      command = command.seekInput(startTime);
    }
    if (endTime && startTime) {
      const startSec = hhmmssToSeconds(startTime);
      const endSec = hhmmssToSeconds(endTime);
      const duration = endSec - startSec;
      command = command.duration(duration);
    }

    // Apply layout-specific filters
    if (skipCroppingInFfmpeg) {
      // Already cropped to 9:16 vertical (or stacked) by Python, just standardize scale and burn subtitles
      command = command.videoFilters([
        'scale=1080:1920',
        subsFilter
      ]);
    } else if (cropLayout === 'stacked') {
      // Static split-screen fallback (no face data available).
      // IMPORTANT: each panel takes EXACTLY half the frame width so the two panels
      // never overlap. A 9:8 crop is ih*(9/8) wide — two of those (2430px on a 1920px
      // frame) would overlap in the middle and show the same person twice.
      // Instead: panel = iw/2 wide, cropped to 9:8 aspect (h = iw*4/9), vertically centered.
      command = command.complexFilter(
        `[0:v]crop=iw/2:iw*4/9:0:(ih-iw*4/9)/2,scale=1080:960[top];` +
        `[0:v]crop=iw/2:iw*4/9:iw/2:(ih-iw*4/9)/2,scale=1080:960[bottom];` +
        `[top][bottom]vstack=inputs=2,${subsFilter}`
      );
    } else {
      let cropFilter = 'crop=ih*(9/16):ih'; // default center crop
      if (cropLayout === 'left') {
        cropFilter = 'crop=ih*(9/16):ih:0:0';
      } else if (cropLayout === 'right') {
        cropFilter = 'crop=ih*(9/16):ih:iw-ih*(9/16):0';
      }

      command = command.videoFilters([
        cropFilter,
        'scale=1080:1920',
        subsFilter
      ]);
    }

    command
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-y' // Overwrite output file if exists
      ])
      .on('start', (commandLine) => {
        console.log(`[ffmpeg] Spawned process command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          const roundedPercent = Math.min(100, Math.max(0, parseFloat(progress.percent.toFixed(1))));
          console.log(`[ffmpeg] Render progress: ${roundedPercent}%`);
          if (onProgress) {
            onProgress(roundedPercent);
          }
        }
      })
      .on('end', () => {
        console.log(`[ffmpeg] Render finished successfully: ${outputVideoPath}`);
        // Clean up temporary face-focused file if created
        if (skipCroppingInFfmpeg && fs.existsSync(/* turbopackIgnore: true */ finalInputVideoPath)) {
          try {
            fs.unlinkSync(finalInputVideoPath);
          } catch (e) {
            console.error('[ffmpeg] Failed to delete temporary face-focused video:', e);
          }
        }
        resolve({ videoPath: outputVideoPath, actualLayout: actualLayoutUsed, faceTrackingFailed, faceTrackingError });
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[ffmpeg] Error rendering video: ${err.message}`);
        console.error(`[ffmpeg] ffmpeg stdout: ${stdout || '(none)'}`);
        console.error(`[ffmpeg] ffmpeg stderr: ${stderr || '(none)'}`);
        // Clean up temporary face-focused file if created
        if (skipCroppingInFfmpeg && fs.existsSync(/* turbopackIgnore: true */ finalInputVideoPath)) {
          try {
            fs.unlinkSync(finalInputVideoPath);
          } catch (e) {
            console.error('[ffmpeg] Failed to delete temporary face-focused video on error:', e);
          }
        }
        reject(new Error(`FFmpeg rendering failed: ${err.message}. Details: ${stderr || 'No stderr output'}`));
      })
      .save(outputVideoPath);
  });
}

/**
 * Duration of a media file in seconds, via ffprobe.
 */
function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const duration = Number(data?.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error(`ffprobe reported no usable duration for ${filePath}`));
      }
      resolve(duration);
    });
  });
}

/**
 * Re-encodes a clip down to fit inside `targetBytes`, for upload over a webhook
 * that caps request size.
 *
 * Clips come off the renderer at CRF 22 with no rate cap, which on high-motion
 * interview footage lands around 10-16 Mbps — a 45 second short can weigh 60 MB.
 * That is fine on disk and far past what n8n accepts in one request, so the
 * upload copy is rate-capped rather than quality-capped.
 *
 * Returns the original path untouched when the file already fits, so the common
 * case costs nothing. Otherwise returns a path inside the OS temp dir that the
 * caller is responsible for deleting.
 */
export async function compressForUpload(
  inputPath: string,
  targetBytes: number
): Promise<{ path: string; isTemporary: boolean }> {
  const originalBytes = fs.statSync(inputPath).size;
  if (originalBytes <= targetBytes) {
    return { path: inputPath, isTemporary: false };
  }

  const durationSec = await probeDurationSec(inputPath);

  // Leave 8% for the container, and give audio a fixed slice before splitting
  // the rest to video — a starved audio track is far more noticeable than a
  // softer picture. Speech survives 64k AAC, so squeezed clips spend less there.
  const totalKbps = Math.floor((targetBytes * 8 * 0.92) / 1000 / durationSec);
  const audioKbps = totalKbps < 700 ? 64 : 96;

  // 400 kbps is the floor where H.264 still resolves a talking head. Below that
  // the budget simply cannot be met at this duration, and the caller is told.
  const videoKbps = Math.max(400, totalKbps - audioKbps);

  // Resolution follows the bitrate: a 1080x1920 frame breaks up on motion under
  // roughly 1.2 Mbps, and a sharp smaller frame reads better on a phone than a
  // smeared large one.
  const scaleFilter =
    videoKbps < 700 ? 'scale=540:960' : videoKbps < 1200 ? 'scale=720:1280' : 'scale=1080:1920';

  const outputPath = path.join(
    os.tmpdir(),
    `clip-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
  );

  console.log(
    `[ffmpeg] Compressing ${path.basename(inputPath)} for upload: ` +
      `${(originalBytes / 1024 / 1024).toFixed(1)} MB -> target ${(targetBytes / 1024 / 1024).toFixed(1)} MB ` +
      `(${durationSec.toFixed(1)}s, ${videoKbps} kbps video, ${scaleFilter.split('=')[1]})`
  );

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters([scaleFilter])
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        `-b:v ${videoKbps}k`,
        `-maxrate ${Math.floor(videoKbps * 1.35)}k`,
        `-bufsize ${videoKbps * 2}k`,
        '-c:a aac',
        `-b:a ${audioKbps}k`,
        '-movflags +faststart',
        '-y',
      ])
      .on('error', (err) => reject(new Error(`Upload compression failed for ${inputPath}: ${err.message}`)))
      .on('end', () => resolve())
      .save(outputPath);
  });

  const compressedBytes = fs.statSync(outputPath).size;
  console.log(
    `[ffmpeg] Upload copy ready: ${(compressedBytes / 1024 / 1024).toFixed(1)} MB ` +
      `(${Math.round((1 - compressedBytes / originalBytes) * 100)}% smaller).`
  );

  // The bitrate floor wins over the budget, so a long clip can still come out
  // over target. Say so here rather than letting it surface as a bare 413.
  if (compressedBytes > targetBytes) {
    console.warn(
      `[ffmpeg] Upload copy is still ${(compressedBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(targetBytes / 1024 / 1024).toFixed(1)} MB budget: ${durationSec.toFixed(0)}s of video cannot fit ` +
        `without dropping below the ${videoKbps} kbps floor. Use N8N_CLIP_WEBHOOK_MODE=per-clip, ` +
        `raise the limit on the n8n side, or cut shorter clips.`
    );
  }

  return { path: outputPath, isTemporary: true };
}

export default ffmpeg;


