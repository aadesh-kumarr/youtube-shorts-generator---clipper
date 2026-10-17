"""Download the models used by the local transcription and reframing service."""

from pathlib import Path
import os
import urllib.request

from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parent
FACE_MODEL = ROOT / "models" / "face_detection_yunet_2023mar.onnx"
FACE_MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/"
    "face_detection_yunet_2023mar.onnx"
)


def download_face_model() -> None:
    FACE_MODEL.parent.mkdir(parents=True, exist_ok=True)
    if FACE_MODEL.exists():
        print(f"YuNet model already exists: {FACE_MODEL}")
        return
    print("Downloading the YuNet face detector...")
    urllib.request.urlretrieve(FACE_MODEL_URL, FACE_MODEL)
    print(f"Saved: {FACE_MODEL}")


def download_whisper_model() -> None:
    model_name = os.environ.get("WHISPER_MODEL", "large-v3")
    print(f"Downloading Faster-Whisper model: {model_name}")
    # CPU initialization makes the setup script usable without CUDA. The server
    # selects the best available device when it actually loads the model.
    WhisperModel(model_name, device="cpu", compute_type="int8")
    print(f"Faster-Whisper model is ready: {model_name}")


if __name__ == "__main__":
    download_face_model()
    download_whisper_model()
