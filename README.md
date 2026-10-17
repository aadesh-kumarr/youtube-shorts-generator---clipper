# Clipper.AI — YouTube Shorts Generator

A focused, portfolio-ready application that turns a long-form YouTube video into polished vertical clips. It downloads the source, transcribes it locally, asks an OpenAI model to identify the strongest moments, reframes each segment to 9:16, burns in word-level captions, and lets the user review and download the results.

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

## Quick start

1. Install the web app dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env.local
   ```

   On PowerShell, use `Copy-Item .env.example .env.local`. Add your `OPENAI_API_KEY` to `.env.local`.

3. Set up the local transcription/reframing service:

   ```bash
   python -m venv .venv
   # Windows: .venv\Scripts\activate
   # macOS/Linux: source .venv/bin/activate
   pip install -r whisper-service/requirements.txt
   python whisper-service/download_models.py
   python whisper-service/server.py
   ```

4. In a second terminal, start the web app:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3010](http://localhost:3010), paste a YouTube URL, choose a crop layout, and generate the clips.

The first run downloads the Whisper model and the yt-dlp executable, so it takes longer than later runs.

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

## License

Released under the MIT License. See [LICENSE](./LICENSE).
