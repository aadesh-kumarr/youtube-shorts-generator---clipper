import path from 'path';
import fs from 'fs';
import { downloadAudio, downloadVideoSegment, prepareCookies } from '@/lib/ytdlp';
import { transcribeAudio, WordTimestamp } from '@/lib/whisper';
import { extractViralHooks, hhmmssToSeconds } from '@/lib/ai-hooks';
import { generateAssSubtitles } from '@/lib/subtitles';
import { renderVerticalClipWithSubtitles, maskSourceWatermark, WatermarkMode } from '@/lib/ffmpeg';
import { cleanupFiles } from '@/lib/storage';
import { WebhookClipInput, sendClipsToPublishingWebhook, FAIL_PIPELINE_ON_WEBHOOK_FAILURE } from '@/lib/webhook';
import { generateClipMetadata } from '@/lib/clipMetadata';

export type ProgressFn = (step: string, data?: Record<string, any>) => void;

export interface ClipperOptions {
  url: string;
  cropLayout?: 'center' | 'stacked';
  /** Skip the Whisper transcript cache (forces a re-transcribe). */
  bypassCache?: boolean;
  /**
   * ISO language code pinned for transcription ("hi", "en", ...). Omitted or
   * "auto" leaves Whisper to detect it.
   */
  language?: string;
  /** Proper nouns to bias the recogniser toward, comma separated. */
  hotwords?: string;
  /**
   * How to deal with the source channel's watermark: 'off', 'crop' or 'delogo'.
   * Falls back to CLIP_WATERMARK_MODE.
   */
  watermarkMode?: WatermarkMode;
  /** "x,y,w,h" as fractions of the frame. Falls back to CLIP_WATERMARK_REGION. */
  watermarkRegion?: string;
  /** Skip the AI hooks cache (forces re-analysis). */
  bypassHooksCache?: boolean;
  /**
   * Dispatch the finished clips to the N8N publishing webhook.
   * OFF by default — the dashboard deliberately lets you review clips first.
   * Turn it on only for unattended automation runs.
   */
  publish?: boolean;
  onProgress?: ProgressFn;
}

export interface RenderedClip {
  /** The published title. Written by the metadata pass, not the selector. */
  title: string;
  start_time: string;
  end_time: string;
  viral_score: number;
  /** The selector's internal justification. Shown to the reviewer, never posted. */
  reason_for_clip: string;
  /** Published caption. */
  caption: string;
  /** Bare tags, no '#'. */
  hashtags: string[];
  videoUrl: string;
  transcript: string;
  cropLayout: string;
}

export interface ClipperResult {
  videoid: string;
  clips: RenderedClip[];
  webhookClips: WebhookClipInput[];
  /** 'pending' when publishing was not requested. */
  webhookStatus: 'pending' | 'sent' | 'skipped' | 'failed';
  webhookMessage: string;
}

/**
 * Suffix distinguishing transcripts produced under different recogniser settings.
 *
 * The version prefix is not decoration. The backend default moved from
 * large-v3-turbo to large-v3 and now pins a language, so every transcript cached
 * before that was produced by a different recogniser. Keyed on video id alone,
 * a re-run would replay the old words and the change would look like it did
 * nothing at all.
 *
 * v3: language coercion now pins Hindi where Whisper had been labelling Hindustani
 * speech as Urdu, so every transcript cached before it is in the wrong script.
 */
const TRANSCRIPTION_CACHE_VERSION = 'v3';

function transcriptionCacheKey(opts: { language?: string; hotwords?: string }): string {
  const parts = [opts.language || '', opts.hotwords || ''].join('|');
  if (parts === '|') return `_${TRANSCRIPTION_CACHE_VERSION}`;
  let hash = 0;
  for (let i = 0; i < parts.length; i++) {
    hash = (hash * 31 + parts.charCodeAt(i)) | 0;
  }
  return `_${TRANSCRIPTION_CACHE_VERSION}_${(hash >>> 0).toString(36)}`;
}

export function initDirectories(): void {
  for (const dir of [
    path.join(process.cwd(), 'tmp'),
    path.join(process.cwd(), 'public', 'output'),
  ]) {
    if (!fs.existsSync(/* turbopackIgnore: true */ dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function extractYoutubeVideoId(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
    if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2];
    const v = parsed.searchParams.get('v');
    if (v) return v;
  } catch {
    // fall through to the regex below
  }
  const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
  return (match && match[2].length === 11) ? match[2] : `video_${Date.now()}`;
}

/** True for anything that looks like a YouTube video link. */
export function isValidYoutubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.length > 1;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      return Boolean(u.searchParams.get('v')) || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/');
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Tracks intermediate files so a failure anywhere can delete whatever is still
 * on disk.
 *
 * The phases below each create scratch files and some delete their own as soon
 * as they are done with them, so the set has to be both added to and removed
 * from. Holding it in one place keeps the phases from having to hand a mutable
 * array back and forth.
 */
function createScratchTracker() {
  let files: string[] = [];
  return {
    add(...paths: string[]) {
      files.push(...paths);
    },
    /** Deletes now and stops tracking — for scratch a phase has finished with. */
    release(paths: string[]) {
      cleanupFiles(paths);
      files = files.filter((p) => !paths.includes(p));
    },
    cleanupAll() {
      if (files.length === 0) return;
      try {
        cleanupFiles(files);
      } catch (e) {
        console.error('[clipper] Cleanup failed after error:', e);
      }
    },
  };
}

type ScratchTracker = ReturnType<typeof createScratchTracker>;

/**
 * Word timestamps for the video, from disk cache when the recogniser settings
 * match. Returns the downloaded audio path only when it had to fetch one, so
 * the caller knows whether there is anything to clean up.
 */
async function resolveTranscript(
  opts: ClipperOptions,
  videoid: string,
  asrKey: string,
  scratch: ScratchTracker,
  sendProgress: ProgressFn
): Promise<{ transcription: any; audioPath: string | null }> {
  const cachePath = path.join(process.cwd(), 'tmp', `transcription_${videoid}${asrKey}.json`);

  if (!opts.bypassCache && fs.existsSync(cachePath)) {
    console.log(`[clipper] Found cached transcription for Video ID: ${videoid}`);
    sendProgress('transcribing', {
      cached: true,
      activeModel: null,
      modelName: 'Cache Hit',
      modelAction: 'Using cached word timestamps (Whisper bypassed)',
    });
    return { transcription: JSON.parse(fs.readFileSync(cachePath, 'utf-8')), audioPath: null };
  }

  console.log('[clipper] Step 1: Downloading audio...');
  sendProgress('downloading-audio', {
    activeModel: 'yt-dlp',
    modelName: 'yt-dlp Stream Downloader',
    modelAction: 'Extracting audio track from YouTube...',
  });
  const audioPath = await downloadAudio(opts.url);
  if (audioPath) scratch.add(audioPath);

  console.log('[clipper] Step 2: Transcribing audio...');
  sendProgress('transcribing', {
    activeModel: 'whisper',
    modelName: 'Faster-Whisper (large-v3)',
    modelAction: '⚡ Loading Whisper into GPU VRAM & transcribing audio...',
  });
  const transcription = await transcribeAudio(audioPath!, {
    language: opts.language,
    hotwords: opts.hotwords,
  });

  sendProgress('whisper-unloaded', {
    activeModel: null,
    modelName: 'Faster-Whisper (large-v3)',
    modelAction: '🧹 Whisper unloaded from VRAM (GPU memory 100% freed)',
  });

  if (!transcription.words || transcription.words.length === 0) {
    throw new Error('Whisper transcription failed to produce word timestamps.');
  }
  fs.writeFileSync(cachePath, JSON.stringify(transcription), 'utf-8');
  return { transcription, audioPath };
}

/**
 * The clip selection, from disk cache when allowed.
 *
 * Versioned: clip selection moved to unit ids, head-to-head ranking and zone
 * spread, so v1 picks are not comparable and must not be replayed.
 */
async function resolveHooks(
  opts: ClipperOptions,
  videoid: string,
  asrKey: string,
  words: WordTimestamp[],
  sendProgress: ProgressFn
): Promise<any[]> {
  const hooksCachePath = path.join(process.cwd(), 'tmp', `hooks_${videoid}${asrKey}_v2.json`);

  if (!opts.bypassCache && !opts.bypassHooksCache && fs.existsSync(hooksCachePath)) {
    console.log(`[clipper] Found cached hooks for Video ID: ${videoid}`);
    sendProgress('extracting-hooks', {
      cached: true,
      activeModel: null,
      modelAction: '⚡ Using cached AI hooks (OpenAI bypassed)',
    });
    const cached = JSON.parse(fs.readFileSync(hooksCachePath, 'utf-8'));
    sendProgress('hooks-extracted', {
      hooks: cached, cached: true, activeModel: null, modelAction: '✓ Hooks loaded from cache',
    });
    return cached;
  }

  console.log('[clipper] Step 3: Extracting viral hooks...');
  sendProgress('extracting-hooks', {
    activeModel: 'llm',
    modelName: 'OpenAI',
    modelAction: '🤖 OpenAI analyzing transcript — identifying viral hooks...',
  });
  const hooks = await extractViralHooks(words);
  if (hooks.length === 0) {
    throw new Error('AI analysis was completed but no viral clips were identified.');
  }
  fs.writeFileSync(hooksCachePath, JSON.stringify(hooks), 'utf-8');
  sendProgress('hooks-extracted', {
    hooks,
    activeModel: null,
    modelName: 'OpenAI',
    modelAction: '✓ OpenAI hook extraction complete',
  });
  return hooks;
}

/** Downloads every selected segment at once. Cookies are prepared first, once. */
async function downloadSegments(
  url: string,
  hooks: any[],
  scratch: ScratchTracker,
  sendProgress: ProgressFn
): Promise<Array<{ clipId: string; segmentPath: string }>> {
  const cookieMode = await prepareCookies(url);
  sendProgress('cookies-ready', {
    mode: cookieMode,
    modelAction: cookieMode === 'browser'
      ? '🔐 Using live browser cookies'
      : cookieMode === 'jar'
        ? '🔐 Using cookie jar (session tokens refreshed)'
        : '⚠️ No cookies configured',
  });

  console.log(`[clipper] Downloading ${hooks.length} video segments in parallel...`);
  sendProgress('downloading-segments', {
    total: hooks.length,
    activeModel: 'yt-dlp',
    modelAction: `📥 Downloading ${hooks.length} video segments in parallel...`,
  });

  return Promise.all(hooks.map(async (hook: any, i: number) => {
    const clipId = `${Date.now()}_${i}`;
    const segmentPath = await downloadVideoSegment(url, hook.start_time, hook.end_time, `segment_${clipId}.mp4`);
    scratch.add(segmentPath);
    sendProgress('segment-downloaded', {
      index: i + 1,
      total: hooks.length,
      startTime: hook.start_time,
      endTime: hook.end_time,
      modelAction: `✓ Segment ${i + 1}/${hooks.length} downloaded`,
    });
    return { clipId, segmentPath };
  }));
}

interface RenderPair {
  clip: RenderedClip;
  webhookClip: WebhookClipInput;
}

/** Renders one selected segment to a finished 9:16 clip with burned-in subtitles. */
async function renderOneClip(
  hook: any,
  index: number,
  total: number,
  segment: { clipId: string; segmentPath: string },
  transcriptionWords: WordTimestamp[],
  opts: ClipperOptions,
  scratch: ScratchTracker,
  sendProgress: ProgressFn,
  onFinished: () => number
): Promise<RenderPair> {
  const { clipId, segmentPath } = segment;
  console.log(`[clipper] Rendering Clip ${index + 1}/${total}: "${hook.suggested_title}"`);

  const startSec = hhmmssToSeconds(hook.start_time);
  const endSec = hhmmssToSeconds(hook.end_time);
  const assPath = generateAssSubtitles(transcriptionWords, startSec, endSec, clipId);
  scratch.add(assPath);

  // Strip the source channel's mark before the tracker crops the frame --
  // afterwards the logo has moved to wherever the faces put it. Returns the
  // input path unchanged when masking is off.
  const maskedPath = await maskSourceWatermark(
    segmentPath,
    path.join(process.cwd(), 'tmp', `masked_${clipId}.mp4`),
    { mode: opts.watermarkMode, region: opts.watermarkRegion }
  );
  if (maskedPath !== segmentPath) scratch.add(maskedPath);

  const outputFilename = `short_${clipId}.mp4`;
  const outputVideoPath = path.join(process.cwd(), 'public', 'output', outputFilename);

  const { actualLayout, faceTrackingFailed, faceTrackingError } = await renderVerticalClipWithSubtitles(
    maskedPath,
    assPath,
    outputVideoPath,
    undefined,
    undefined,
    (percent) => {
      sendProgress('clip-progress', {
        index: index + 1, total, title: hook.suggested_title, percent,
      });
    },
    opts.cropLayout || 'stacked'
  );

  if (faceTrackingFailed) {
    sendProgress('face-tracking-unavailable', {
      index: index + 1,
      total,
      error: faceTrackingError,
      modelAction: '⚠️ Face tracking unavailable — using center crop',
    });
  }

  sendProgress('clip-rendered', {
    index: index + 1,
    finished: onFinished(),
    total,
    title: hook.suggested_title,
    layout: actualLayout,
    modelAction: `✓ Clip ${index + 1}/${total} rendered`,
  });

  const clipWords = transcriptionWords.filter((w) => w.start >= startSec && w.end <= endSec);
  const clipTranscriptText = clipWords.map((w) => w.word).join(' ');

  scratch.release(
    maskedPath === segmentPath ? [segmentPath, assPath] : [segmentPath, maskedPath, assPath]
  );

  return {
    clip: {
      // Placeholder: replaced by the metadata pass, which needs every clip's
      // transcript and so cannot run until all renders are done.
      title: hook.suggested_title,
      caption: '',
      hashtags: [] as string[],
      start_time: hook.start_time,
      end_time: hook.end_time,
      viral_score: hook.viral_score,
      reason_for_clip: hook.reason_for_clip,
      videoUrl: `/output/${outputFilename}`,
      transcript: clipTranscriptText,
      cropLayout: actualLayout,
    },
    webhookClip: {
      filePath: outputVideoPath,
      transcript: clipTranscriptText,
      title: hook.suggested_title,
      description: '',
      hashtags: [] as string[],
    },
  };
}

/**
 * Writes the published title, caption and hashtags onto every clip, in place.
 *
 * The description used to be hook.reason_for_clip -- the selector's note to
 * whoever reviews the cut -- which went out as the post caption verbatim.
 */
async function applyClipMetadata(
  clips: RenderedClip[],
  webhookClips: WebhookClipInput[],
  sendProgress: ProgressFn
): Promise<void> {
  sendProgress('writing-metadata', {
    activeModel: 'llm',
    modelAction: 'Writing titles, captions and hashtags...',
  });
  const metadata = await generateClipMetadata(
    clips.map((c) => ({ transcript: c.transcript, workingTitle: c.title }))
  );
  metadata.forEach((meta, i) => {
    clips[i].title = meta.title;
    clips[i].caption = meta.caption;
    clips[i].hashtags = meta.hashtags;
    webhookClips[i].title = meta.title;
    webhookClips[i].description = meta.caption;
    webhookClips[i].hashtags = meta.hashtags;
  });
  sendProgress('metadata-ready', { activeModel: null, modelAction: 'Post copy ready' });
}

/** Optional N8N dispatch. Rendered clips already exist on disk either way. */
async function dispatchPublishing(
  videoid: string,
  webhookClips: WebhookClipInput[],
  sendProgress: ProgressFn
): Promise<{ webhookStatus: ClipperResult['webhookStatus']; webhookMessage: string }> {
  sendProgress('publishing', {
    total: webhookClips.length,
    modelAction: `📤 Sending ${webhookClips.length} clips to the N8N publishing webhook...`,
  });
  try {
    await sendClipsToPublishingWebhook(videoid, webhookClips);
    const webhookMessage = `Dispatched ${webhookClips.length} clips to the N8N publishing webhook.`;
    console.log(`[clipper] ${webhookMessage}`);
    sendProgress('published', { modelAction: '✓ Clips sent to N8N' });
    return { webhookStatus: 'sent', webhookMessage };
  } catch (webhookErr: any) {
    const webhookMessage = webhookErr?.message || String(webhookErr);
    console.error(`[clipper] N8N publishing failed for ${videoid}: ${webhookMessage}`);
    sendProgress('publish-failed', {
      error: webhookMessage,
      modelAction: `⚠️ N8N publishing failed: ${webhookMessage}`,
    });
    // The clips are already rendered on disk; only fail the run if configured to.
    if (FAIL_PIPELINE_ON_WEBHOOK_FAILURE) {
      throw new Error(`Pipeline failed because the N8N webhook failed: ${webhookMessage}`);
    }
    return { webhookStatus: 'failed', webhookMessage };
  }
}

/**
 * Runs the full Clipper pipeline: transcript → viral hooks → segment download →
 * face-tracked 9:16 render with burned-in subtitles.
 *
 * Progress is reported through `onProgress`; the streaming API route forwards
 * those events to the browser, while the simple automation endpoint records them.
 */
export async function runClipperPipeline(opts: ClipperOptions): Promise<ClipperResult> {
  const sendProgress: ProgressFn = opts.onProgress ?? (() => {});

  initDirectories();
  const videoid = extractYoutubeVideoId(opts.url);
  const scratch = createScratchTracker();

  try {
    // The cache key carries the settings that produced the transcript. Keyed on
    // video id alone, changing the language or hotwords would silently replay
    // the old words and look like the change did nothing.
    const asrKey = transcriptionCacheKey({ language: opts.language, hotwords: opts.hotwords });

    const { transcription, audioPath } = await resolveTranscript(
      opts, videoid, asrKey, scratch, sendProgress
    );
    const hooks = await resolveHooks(opts, videoid, asrKey, transcription.words, sendProgress);
    const segments = await downloadSegments(opts.url, hooks, scratch, sendProgress);

    sendProgress('rendering-parallel', {
      total: hooks.length,
      activeModel: 'mediapipe',
      modelAction: `🎬 Rendering ${hooks.length} clips in parallel...`,
    });

    let clipsFinished = 0;
    const renderResults = await Promise.all(hooks.map((hook: any, i: number) =>
      renderOneClip(
        hook, i, hooks.length, segments[i], transcription.words,
        opts, scratch, sendProgress, () => ++clipsFinished
      )
    ));

    if (audioPath) scratch.release([audioPath]);

    const clips = renderResults.map((r) => r.clip);
    const webhookClips = renderResults.map((r) => r.webhookClip);

    await applyClipMetadata(clips, webhookClips, sendProgress);

    const { webhookStatus, webhookMessage } = opts.publish
      ? await dispatchPublishing(videoid, webhookClips, sendProgress)
      : {
          webhookStatus: 'pending' as const,
          webhookMessage: 'Clips generated. Publishing not requested — review before publishing.',
        };

    console.log('[clipper] Pipeline completed successfully.');
    return { videoid, clips, webhookClips, webhookStatus, webhookMessage };
  } catch (error) {
    scratch.cleanupAll();
    throw error;
  }
}


