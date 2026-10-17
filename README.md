# Clipper.AI — YouTube Shorts Generator

A focused application that turns a long-form YouTube video into polished vertical clips. It downloads the source, transcribes it locally, asks an OpenAI model to identify the strongest moments, reframes each segment to 9:16, burns in word-level captions, and lets the user review and download the results.

> **Local-first project:** this repository is designed to be cloned and run on a developer workstation. It is not a one-click Vercel deployment because video processing depends on a long-running Python service, local Whisper model weights, FFmpeg, yt-dlp, writable disk storage, and ideally GPU acceleration. The public repository is fully reproducible; the demonstration runs locally.

## What it demonstrates

- A streamed, long-running media pipeline built with Next.js route handlers
- Local speech-to-text with Faster-Whisper and word timestamps
- Structured AI output for viral-moment selection and social metadata
- Dynamic face-aware reframing for single- and two-speaker video
- FFmpeg rendering, ASS subtitle generation, caching, retries, and cleanup
- A responsive dashboard with live per-stage and per-clip progress

## Pipeline

```text
YouTube URL
   ↓  yt-dlp
16 kHz audio
   ↓  Faster-Whisper
Word-level transcript
   ↓  OpenAI structured selection
1–3 high-retention moments
   ↓  yt-dlp + YuNet/OpenCV + FFmpeg
9:16 clips with burned-in captions
   ↓
Review, download, or optionally send to n8n
```

## Tech stack

Next.js 16, React 19, TypeScript, Tailwind CSS 4, FFmpeg/FFprobe, yt-dlp, Faster-Whisper, PyTorch, OpenCV YuNet, and the OpenAI Chat Completions API.

## Prerequisites

- Node.js 20.19 or newer
- Python 3.10 or 3.11
- An OpenAI API key
- An NVIDIA GPU is recommended for Faster-Whisper; CPU works but is slower
- FFmpeg on `PATH` for the Python face-tracking service. The Next.js renderer includes its own FFmpeg binary.

## How to use it locally

The application runs as two local processes: a Python AI/media service on port `5000` and a Next.js dashboard on port `3010`. Keep both terminals open while generating clips.

### Windows one-click setup and startup

For the first run, double-click [`setup-local.bat`](./setup-local.bat). It installs the Node dependencies, creates `.venv`, installs the Python packages, downloads the local models, creates `.env.local`, and opens that file in Notepad. Add your real `OPENAI_API_KEY`, save, and close Notepad.

After setup, double-click [`start-local.bat`](./start-local.bat) whenever you want to use the project. It validates the installation, opens the Whisper service and Next.js dashboard in two labeled terminal windows, then opens [http://localhost:3010](http://localhost:3010) in your browser.

To stop the application, press `Ctrl+C` in both service windows or close both windows. You only need to run `setup-local.bat` again when dependencies change or an earlier setup did not finish.

The remaining steps below show the same process manually and are useful for macOS/Linux or troubleshooting.

### 1. Clone and enter the repository

```bash
git clone YOUR_REPOSITORY_URL
cd youtube-shorts-generator
```

If you downloaded a ZIP, extract it and open a terminal inside the extracted folder instead.

### 2. Install the web dependencies

```bash
npm install
```

The web pipeline downloads packaged FFmpeg/FFprobe binaries. The Python face-tracking service also expects `ffmpeg` and `ffprobe` on the system `PATH`.

### 3. Create and edit `.env.local`

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS/Linux:

```bash
cp .env.example .env.local
```

Open `.env.local` and replace `sk-your-key-here` with your OpenAI API key. The minimum configuration is:

```dotenv
OPENAI_API_KEY="your-real-key"
OPENAI_MODEL="gpt-5.4-mini"
WHISPER_BACKEND_URL="http://127.0.0.1:5000"
WHISPER_MODEL="large-v3"
```

Do not commit `.env.local`. Every supported option is documented in [`.env.example`](./.env.example).

### 4. Create the Python environment and download models

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r whisper-service\requirements.txt
python whisper-service\download_models.py
```

macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r whisper-service/requirements.txt
python whisper-service/download_models.py
```

The downloader fetches Faster-Whisper and the YuNet face detector. `large-v3` requires several gigabytes of disk space and performs best on an NVIDIA GPU. For a lighter English-only demo, set `WHISPER_MODEL="large-v3-turbo"` before downloading.

### 5. Start Whisper and face tracking

Windows PowerShell—the helper reads `WHISPER_*` settings from `.env.local`:

```powershell
.\start-whisper.ps1
```

macOS/Linux:

```bash
export WHISPER_MODEL=large-v3
export WHISPER_ALLOWED_LANGUAGES=hi,en
python whisper-service/server.py
```

Leave this terminal running. A healthy service listens on `http://127.0.0.1:5000`.

### 6. Start the dashboard in a second terminal

```bash
npm run dev
```

Open [http://localhost:3010](http://localhost:3010). The Whisper indicator should turn green.

### 7. Generate Shorts

1. Paste a public YouTube video URL.
2. Choose **Dynamic Split** for interviews or **Force Center** for a single speaker.
3. Leave both caches enabled for faster repeat runs.
4. Select **Generate Shorts** and keep both terminals open.
5. Review the chosen moments and generated social metadata.
6. Preview or download each MP4 from the dashboard.
7. Open **AI System Prompts** to demonstrate the exact instructions used by both AI stages.

Generated files are stored in `public/output/`; intermediate files and caches are stored in `tmp/`. Both are ignored by Git.

### YouTube cookies when a download is blocked

If yt-dlp reports a sign-in, bot-check, age, or regional restriction, add one of these options to `.env.local`:

```dotenv
YT_DLP_COOKIES_FROM_BROWSER="chrome"
```

Or use a Netscape-format cookie export saved inside the project:

```dotenv
YT_DLP_COOKIES_FILE="cookies.txt"
```

Never commit `cookies.txt`; it contains authenticated browser session data.

### Common problems

| Symptom | What to check |
| --- | --- |
| Whisper shows offline | Confirm `start-whisper.ps1` or `server.py` is running on port `5000`. |
| CUDA or out-of-memory error | Use `large-v3-turbo`, close other GPU applications, or run on CPU more slowly. |
| Face tracking uses center crop | Run `download_models.py`, verify the YuNet model exists, and ensure FFmpeg is on `PATH`. |
| YouTube download is rejected | Configure browser cookies or `cookies.txt` as described above. |
| OpenAI authentication fails | Check `OPENAI_API_KEY` and restart Next.js after editing `.env.local`. |
| The first run appears slow | Models, yt-dlp, and source media are downloaded on demand; cached runs are faster. |

## Configuration

All supported settings are documented in [`.env.example`](./.env.example). The only required secret is `OPENAI_API_KEY`.

YouTube sometimes requires authentication for age-restricted, private, or rate-limited videos. You can set `YT_DLP_COOKIES_FROM_BROWSER=chrome`, or export a Netscape-format `cookies.txt` and set `YT_DLP_COOKIES_FILE=cookies.txt`. Cookie files are ignored by Git and must never be committed.

The n8n webhook is optional. Leave `N8N_CLIP_WEBHOOK_URL` empty if you only want generation and downloads.

## Project structure

```text
src/app/                         Dashboard and route handlers
src/lib/clipper-pipeline.ts      Pipeline orchestration and caching
src/lib/ytdlp.ts                 Audio and segment downloads
src/lib/whisper.ts               Local transcription client
src/lib/ai-hooks.ts              Transcript chunking and moment selection
src/lib/ffmpeg.ts                Reframing, watermark handling, and encoding
src/lib/subtitles.ts             Word-level ASS captions
prompts/clipper.md               Version-controlled AI instructions
whisper-service/                 Faster-Whisper and YuNet/OpenCV service
setup-local.bat                  One-time Windows dependency/model setup
start-local.bat                  One-click Windows launcher for both services
```

Runtime files are written to `tmp/`, `public/workspace/`, and `public/output/`. They are excluded from version control.

## API

- `POST /api/clipper/process` — runs the pipeline and streams newline-delimited JSON progress events
- `GET /api/clipper/models/status` — reports whether local Whisper and OpenAI configuration are available
- `POST /api/clipper/publish` — optionally sends reviewed clips to a configured n8n webhook
- `GET /api/prompts` — exposes the exact version-controlled AI system prompts shown in the dashboard

## Before publishing your fork

Run these checks from this directory:

```bash
npm run lint
npm run typecheck
npm run build
git grep -n -I -E "(sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)"
```

Only publish source videos and generated clips you have the right to use. Follow YouTube's terms and the copyright rules that apply to your use case.

## Sharing the project

Ready-to-edit launch copy for LinkedIn and Reddit is available in [`SOCIAL_POSTS.md`](./SOCIAL_POSTS.md). Replace the repository and demo-video placeholders before publishing.

## License

Released under the MIT License. See [LICENSE](./LICENSE).
