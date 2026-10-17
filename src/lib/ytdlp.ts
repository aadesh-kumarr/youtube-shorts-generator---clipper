import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const execFileAsync = promisify(execFile);

/**
 * Ensures yt-dlp binary is available in <project_root>/bin directory.
 * Auto-downloads the binary if missing to prevent Windows path issues in Next.js.
 */
async function getYtDlpPath(): Promise<string> {
  const binDir = path.join(process.cwd(), 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const isWin = process.platform === 'win32';
  const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const binaryPath = path.join(binDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.log('[yt-dlp] Downloading yt-dlp executable binary...');
    const url = isWin
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download yt-dlp binary: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(binaryPath, Buffer.from(arrayBuffer));

    if (!isWin) {
      fs.chmodSync(binaryPath, '755');
    }
    console.log('[yt-dlp] yt-dlp binary downloaded successfully.');
  }

  return binaryPath;
}

/**
 * Cookie strategy
 * ───────────────
 * YouTube rotates the session tokens (__Secure-1PSIDTS / 3PSIDTS, SIDCC, ...)
 * every few hours. A static exported cookies.txt therefore goes stale quickly,
 * which is why it has to be re-exported by hand again and again.
 *
 * yt-dlp writes refreshed tokens back into whatever file it is given, so we keep
 * a PERSISTENT working jar that yt-dlp is allowed to update. The user's original
 * export is treated as a read-only seed and is never modified.
 *
 *   cookies.txt            → seed (yours, never written to)
 *   tmp/cookies_session.txt → working jar (yt-dlp refreshes this every run)
 *
 * Re-seeding happens automatically whenever you drop in a newer cookies.txt.
 */
const COOKIE_JAR_PATH = () => path.join(process.cwd(), 'tmp', 'cookies_session.txt');

function getSeedCookiePath(): string | null {
  const cookiesFileEnv = process.env.YT_DLP_COOKIES_FILE;
  if (cookiesFileEnv) {
    const absPath = path.isAbsolute(cookiesFileEnv)
      ? cookiesFileEnv
      : path.join(/* turbopackIgnore: true */ process.cwd(), cookiesFileEnv);
    if (fs.existsSync(/* turbopackIgnore: true */ absPath)) return absPath;
    console.warn(`[yt-dlp] YT_DLP_COOKIES_FILE set but not found at: ${absPath}`);
  }
  const defaultPath = path.join(process.cwd(), 'cookies.txt');
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

/** Creates/refreshes the working jar from the seed when the seed is newer. */
function ensureCookieJar(): string | null {
  const seed = getSeedCookiePath();
  if (!seed) return null;

  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const jar = COOKIE_JAR_PATH();
  const needsSeed =
    !fs.existsSync(jar) ||
    fs.statSync(seed).mtimeMs > fs.statSync(jar).mtimeMs;

  if (needsSeed) {
    fs.copyFileSync(seed, jar);
    console.log(`[yt-dlp] Seeded cookie jar from ${path.basename(seed)}`);
  }
  return jar;
}

// Whether live browser-cookie extraction actually works on this machine.
// Probed once per server process by prepareCookies(), then cached.
let browserCookieStatus: 'unknown' | 'ok' | 'failed' = 'unknown';

/**
 * @param allowWriteback  true  → yt-dlp uses the jar directly and may refresh it.
 *                               Only safe for a single, non-concurrent call.
 *                        false → yt-dlp gets a throwaway copy. Safe for parallel
 *                               downloads, but no token refresh happens.
 */
function getCookieArgs(allowWriteback = false): string[] {
  const browser = process.env.YT_DLP_COOKIES_FROM_BROWSER;
  if (browser && browserCookieStatus !== 'failed') {
    return ['--cookies-from-browser', browser];
  }

  const jar = ensureCookieJar();
  if (!jar) return [];

  if (allowWriteback) return ['--cookies', jar];

  const scratch = path.join(process.cwd(), 'tmp', `cookies_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.copyFileSync(jar, scratch);
  return ['--cookies', scratch];
}

function cleanupScratchCookie(cookieArgs: string[]): void {
  const p = cookieArgs[1];
  if (p && p.includes('cookies_tmp_')) {
    try { fs.unlinkSync(p); } catch { /* best-effort scratch cleanup */ }
  }
}

async function ytDlpProbe(youtubeUrl: string, cookieArgs: string[]): Promise<void> {
  const ytDlpBinary = await getYtDlpPath();
  await execFileAsync(ytDlpBinary, [
    youtubeUrl,
    '--simulate',
    '--skip-download',
    '--no-warnings',
    '--js-runtimes', 'node',
    ...cookieArgs,
  ], { maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Prepares authentication before the parallel segment downloads. Run ONCE per pipeline.
 *
 * - If a browser profile is configured, verifies live extraction actually works.
 *   On Windows this can fail (Chrome/Edge App-Bound Encryption, or a locked
 *   cookie DB while the browser is open), so a failure permanently switches this
 *   process over to the cookie-jar file instead of breaking every download.
 * - Otherwise refreshes the persistent jar so YouTube's rotating session tokens
 *   get written back, which is what stops cookies.txt from going stale.
 *
 * Never throws — authentication problems surface at download time with a real error.
 */
export async function prepareCookies(youtubeUrl: string): Promise<'browser' | 'jar' | 'none'> {
  const browser = process.env.YT_DLP_COOKIES_FROM_BROWSER;

  if (browser && browserCookieStatus !== 'failed') {
    if (browserCookieStatus === 'ok') return 'browser';
    try {
      await ytDlpProbe(youtubeUrl, ['--cookies-from-browser', browser]);
      browserCookieStatus = 'ok';
      console.log(`[yt-dlp] Live browser cookies OK (${browser}) — no cookies.txt maintenance needed.`);
      return 'browser';
    } catch (err: any) {
      browserCookieStatus = 'failed';
      const msg = (err.stderr || err.message || '').toString().slice(0, 300);
      console.warn(
        `[yt-dlp] Browser cookie extraction failed (${browser}); falling back to cookie jar.\n` +
        `[yt-dlp]   ${msg.replace(/\s+/g, ' ').trim()}`
      );
    }
  }

  const jar = ensureCookieJar();
  if (!jar) {
    console.warn('[yt-dlp] No cookies configured — YouTube will likely reject the download.');
    return 'none';
  }

  try {
    await ytDlpProbe(youtubeUrl, ['--cookies', jar]);
    console.log('[yt-dlp] Cookie jar refreshed — session tokens rotated.');
  } catch (err: any) {
    console.warn(`[yt-dlp] Cookie jar refresh failed (continuing anyway): ${(err.message || '').slice(0, 200)}`);
  }
  return 'jar';
}

/**
 * Downloads the audio stream from a YouTube URL as 16 kHz mono PCM WAV,
 * ready to hand straight to Whisper.
 * @param youtubeUrl - Full YouTube video URL
 * @returns Path to the downloaded WAV file
 */
export async function downloadAudio(youtubeUrl: string): Promise<string> {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // WAV, not MP3. This file exists only to be handed to Whisper and is deleted
  // minutes later, so there is nothing to gain from compressing it -- and the
  // old `-ab 48k` was feeding the recogniser audible codec artifacts on top of
  // already-noisy podcast audio. 16 kHz mono PCM is exactly what Whisper
  // resamples to internally.
  const outputFilePath = path.join(tmpDir, `input_audio_${Date.now()}.wav`);
  const ytDlpBinary = await getYtDlpPath();
  const ffmpegDir = path.dirname(ffmpegInstaller.path);

  console.log(`[yt-dlp] Extracting audio from: ${youtubeUrl}`);

  const cookieArgs = getCookieArgs();
  const args = [
    youtubeUrl,
    '--extract-audio',
    '--audio-format', 'wav',
    '--postprocessor-args', 'ExtractAudio:-ac 1 -ar 16000 -acodec pcm_s16le',
    '--output', outputFilePath,
    '--ffmpeg-location', ffmpegDir,
    '--no-warnings',
    '--prefer-free-formats',
    '--js-runtimes', 'node',
    ...cookieArgs,
  ];

  try {
    await execFileAsync(ytDlpBinary, args, { maxBuffer: 200 * 1024 * 1024 });
  } finally {
    cleanupScratchCookie(cookieArgs);
  }

  console.log(`[yt-dlp] Audio saved successfully at: ${outputFilePath}`);
  return outputFilePath;
}

/**
 * Downloads a specific segment of the video
 * @param youtubeUrl - Full YouTube video URL
 * @param startTime - Segment start time in HH:MM:SS format
 * @param endTime - Segment end time in HH:MM:SS format
 * @param outputFilename - Filename to save under tmp/
 * @returns Path to the downloaded video segment
 */
export async function downloadVideoSegment(
  youtubeUrl: string,
  startTime: string,
  endTime: string,
  outputFilename: string
): Promise<string> {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const outputFilePath = path.join(tmpDir, outputFilename);
  const ytDlpBinary = await getYtDlpPath();
  const ffmpegDir = path.dirname(ffmpegInstaller.path);

  console.log(`[yt-dlp] Downloading video segment ${startTime} - ${endTime} from: ${youtubeUrl}`);

  const cookieArgs = getCookieArgs();
  const args = [
    youtubeUrl,
    '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]',
    '--download-sections', `*${startTime}-${endTime}`,
    '--output', outputFilePath,
    '--ffmpeg-location', ffmpegDir,
    '--no-warnings',
    '--force-overwrites',
    '--js-runtimes', 'node',
    '--downloader-args', 'ffmpeg:-user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"',
    ...cookieArgs,
  ];

  try {
    await execFileAsync(ytDlpBinary, args, { maxBuffer: 200 * 1024 * 1024 });
  } finally {
    cleanupScratchCookie(cookieArgs);
  }

  // Fail loudly here rather than shipping a broken file downstream: a truncated
  // or audio-only segment makes OpenCV spin forever on the first frame read.
  await assertHasVideoStream(outputFilePath);

  console.log(`[yt-dlp] Video segment saved successfully at: ${outputFilePath}`);
  return outputFilePath;
}

/**
 * Verifies a downloaded segment actually contains a decodable video stream.
 * YouTube sometimes serves HLS-only formats that yield an audio-only or
 * truncated file while yt-dlp still reports success.
 */
async function assertHasVideoStream(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Segment download produced no file: ${path.basename(filePath)}`);
  }
  const size = fs.statSync(filePath).size;
  if (size < 100 * 1024) {
    throw new Error(
      `Segment ${path.basename(filePath)} is only ${size} bytes — the video stream failed to download ` +
      `(YouTube likely served an HLS-only format). Check cookies/auth.`
    );
  }

  try {
    const { stdout } = await execFileAsync(ffprobeInstaller.path, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { maxBuffer: 4 * 1024 * 1024 });

    const fields = stdout.trim().split(/\s+/).filter(Boolean);
    if (fields.length < 3) {
      throw new Error(
        `Segment ${path.basename(filePath)} has no video stream (audio-only download).`
      );
    }
  } catch (err: any) {
    if (err?.message?.includes('no video stream')) throw err;
    // ffprobe itself failed — surface it rather than proceeding with a suspect file
    throw new Error(`Could not verify segment ${path.basename(filePath)}: ${err.message}`);
  }
}


