import fs from 'fs';
import { CONFIG } from './config';
import { compressForUpload } from './ffmpeg';

// Configuration constant: if true, webhook failures will fail the entire pipeline request.
// If false, it will log the error and allow the pipeline to complete successfully.
export const FAIL_PIPELINE_ON_WEBHOOK_FAILURE = false;

export interface WebhookClipInput {
  filePath: string;
  transcript: string;
  title: string;
  description: string;
  /** Bare tags, no '#'. Sent as a space-separated string of #tags. */
  hashtags?: string[];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * N8N Publishing Webhook Contract:
 * Method: POST
 * Content-Type: multipart/form-data
 *
 * Text fields:
 * - videoid          -> string, the unique identifier for this source video
 * - clip1_transcript  -> string, transcript text for clip 1
 * - clip2_transcript  -> string, transcript text for clip 2
 * - clip3_transcript  -> string, transcript text for clip 3
 * - clipN_title       -> string, the published title (hook)
 * - clipN_description -> string, the published caption
 * - clipN_hashtags    -> string, space-separated "#tag #tag" (may be empty)
 *
 * clipN_hashtags was added alongside the existing fields rather than replacing
 * any of them, so an N8N flow that predates it keeps working untouched.
 *
 * Per-clip mode (N8N_CLIP_WEBHOOK_MODE=per-clip) posts one request per clip
 * instead, using unnumbered field names plus an index:
 * - videoid, clip_index (1-based), clip_count
 * - clip_transcript, clip_title, clip_description, clip_hashtags
 * - clip_video -> file binary data (video/mp4)
 * The n8n flow has to be adapted for that shape, which is why 'batch' remains
 * the default.
 *
 * File fields (binary, .mp4):
 * - clip1_video      -> file binary data (video/mp4)
 * - clip2_video      -> file binary data (video/mp4)
 * - clip3_video      -> file binary data (video/mp4)
 *
 * Sends all generated clips and transcripts to the publishing endpoint.
 * Retries up to 3 times (delays: 1s, 3s, 9s) on network failures or 5xx responses.
 *
 * @param videoid - Unique video identifier (e.g. YouTube video ID)
 * @param clips - Array of generated clips containing file paths and transcripts
 */
/**
 * Posts one already-built multipart body, retrying on network failures and 5xx.
 *
 * 413 is called out separately because it is not transient and not a malformed
 * payload — it means the body is bigger than the receiving stack accepts, and
 * retrying an identical body just burns three more uploads.
 */
async function postWithRetries(url: string, formData: FormData, label: string): Promise<void> {
  const maxRetries = 3;
  const backoffDelays = [1000, 3000, 9000];

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`[webhook] Dispatching ${label} (Attempt ${attempt}/${maxRetries + 1})...`);

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        console.log(`[webhook] ${label} accepted by N8N on attempt ${attempt}.`);
        return;
      }

      const body = await response.text().catch(() => '');
      const is5xx = response.status >= 500 && response.status < 600;
      console.warn(`[webhook] ${label} failed with status ${response.status} on attempt ${attempt}. ${body.slice(0, 500)}`);

      if (response.status === 413) {
        const err = new Error(
          `N8N rejected ${label} with 413 Payload Too Large. The request body is bigger than the ` +
            `receiving stack allows. Lower N8N_CLIP_UPLOAD_BUDGET_MB (currently ` +
            `${CONFIG.N8N_CLIP_UPLOAD_BUDGET_MB} MB), set N8N_CLIP_WEBHOOK_MODE=per-clip so each clip ` +
            `gets its own request, or raise the limit on the receiving side ` +
            `(Cloudflare caps uploads at 100 MB on the free plan, then client_max_body_size on ` +
            `nginx, then N8N_PAYLOAD_SIZE_MAX on n8n itself).`
        );
        (err as any).noRetry = true;
        throw err;
      }

      if (!is5xx) {
        // Do not retry on 4xx responses or other status codes. Throw and exit.
        const err = new Error(
          `N8N Webhook returned client error status: ${response.status} for ${label}. Retries skipped for 4xx responses.` +
            (body ? ` Response: ${body.slice(0, 500)}` : '')
        );
        (err as any).noRetry = true;
        throw err;
      }

      if (attempt > maxRetries) {
        throw new Error(`N8N Webhook returned server error status: ${response.status} after ${maxRetries} retries.`);
      }
    } catch (error: any) {
      console.error(`[webhook] Failure on attempt ${attempt} for ${label}. Error: ${error.message || error}`);

      if (error.noRetry || attempt > maxRetries) {
        throw error;
      }
    }

    const delayMs = backoffDelays[attempt - 1] || 1000;
    console.log(`[webhook] Waiting ${delayMs / 1000}s before next retry...`);
    await delay(delayMs);
  }
}

/** Reads a clip off disk as a multipart-ready blob. */
function readClipBlob(filePath: string): Blob {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Webhook payload construction failed: clip file not found at ${filePath}`);
  }
  return new Blob([fs.readFileSync(filePath)], { type: 'video/mp4' });
}

export async function sendClipsToPublishingWebhook(
  videoid: string,
  clips: WebhookClipInput[]
): Promise<void> {
  const webhookUrl = CONFIG.N8N_CLIP_WEBHOOK_URL;

  if (!webhookUrl || webhookUrl === 'https://your-n8n-instance.cloud/webhook/clips-publish') {
    console.log('[webhook] N8N_CLIP_WEBHOOK_URL is not set or has placeholder value. Skipping publishing webhook dispatch.');
    return;
  }

  const perClip = CONFIG.N8N_CLIP_WEBHOOK_MODE === 'per-clip';
  const budgetBytes = Math.max(1, CONFIG.N8N_CLIP_UPLOAD_BUDGET_MB) * 1024 * 1024;

  // In batch mode all three clips ride in one body, so each one only gets a
  // third of the budget. The 0.95 leaves room for the text fields, the
  // multipart boundaries and base64-free binary framing overhead.
  const perClipBudget = perClip
    ? Math.floor(budgetBytes * 0.95)
    : Math.floor((budgetBytes * 0.95) / 3);

  console.log(
    `[webhook] Building ${perClip ? 'per-clip' : 'batch'} request(s) for N8N webhook publishing. ` +
      `Video ID: ${videoid}. Upload budget ${CONFIG.N8N_CLIP_UPLOAD_BUDGET_MB} MB ` +
      `(${(perClipBudget / 1024 / 1024).toFixed(1)} MB per clip).`
  );

  // Shrink anything over budget before it is ever dispatched. Doing this up
  // front means a 413 can only come from a limit tighter than the configured
  // budget — which is exactly what the error message then tells the operator.
  const temporaryFiles: string[] = [];
  const uploadPaths: (string | null)[] = [];

  try {
    for (let i = 0; i < 3; i++) {
      const clip = clips[i];
      if (!clip) {
        uploadPaths.push(null);
        continue;
      }
      if (!fs.existsSync(clip.filePath)) {
        throw new Error(`Webhook payload construction failed: clip file not found at ${clip.filePath}`);
      }
      const prepared = await compressForUpload(clip.filePath, perClipBudget);
      if (prepared.isTemporary) temporaryFiles.push(prepared.path);
      uploadPaths.push(prepared.path);
    }

    if (perClip) {
      for (let i = 0; i < 3; i++) {
        const clip = clips[i];
        const uploadPath = uploadPaths[i];
        if (!clip || !uploadPath) continue;

        const formData = new FormData();
        formData.append('videoid', videoid);
        formData.append('clip_index', String(i + 1));
        formData.append('clip_count', String(clips.length));
        formData.append('clip_transcript', clip.transcript);
        formData.append('clip_title', clip.title || '');
        formData.append('clip_description', clip.description || '');
        formData.append('clip_hashtags', (clip.hashtags || []).map(t => `#${t}`).join(' '));
        formData.append('clip_video', readClipBlob(uploadPath), `clip${i + 1}.mp4`);

        await postWithRetries(webhookUrl, formData, `clip ${i + 1}/${clips.length} for ${videoid}`);
      }
      return;
    }

    const formData = new FormData();
    formData.append('videoid', videoid);

    // Map each clip to the specific field names required by the contract.
    // We iterate exactly 3 times to satisfy the 7-field N8N webhook contract.
    for (let i = 0; i < 3; i++) {
      const clipNum = i + 1;
      const clip = clips[i];
      const uploadPath = uploadPaths[i];

      if (clip && uploadPath) {
        formData.append(`clip${clipNum}_transcript`, clip.transcript);
        formData.append(`clip${clipNum}_title`, clip.title || '');
        formData.append(`clip${clipNum}_description`, clip.description || '');
        formData.append(
          `clip${clipNum}_hashtags`,
          (clip.hashtags || []).map(t => `#${t}`).join(' ')
        );
        formData.append(`clip${clipNum}_video`, readClipBlob(uploadPath), `clip${clipNum}.mp4`);
      } else {
        // Pad missing clips to ensure the contract is met
        console.warn(`[webhook] Padding empty clip${clipNum} fields (fewer than 3 clips provided).`);
        formData.append(`clip${clipNum}_transcript`, '');
        formData.append(`clip${clipNum}_title`, '');
        formData.append(`clip${clipNum}_description`, '');
        formData.append(`clip${clipNum}_hashtags`, '');

        // Use an empty video blob for padding
        const emptyBlob = new Blob([Buffer.alloc(0)], { type: 'video/mp4' });
        formData.append(`clip${clipNum}_video`, emptyBlob, `clip${clipNum}.mp4`);
      }
    }

    const totalBytes = uploadPaths.reduce(
      (sum: number, filePath) => sum + (filePath ? fs.statSync(filePath).size : 0),
      0
    );
    console.log(`[webhook] Batch body carries ${(totalBytes / 1024 / 1024).toFixed(1)} MB of video across 3 fields.`);

    await postWithRetries(webhookUrl, formData, `clip batch for ${videoid}`);
  } finally {
    for (const file of temporaryFiles) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        console.warn(`[webhook] Could not delete temporary upload copy ${file}: ${e}`);
      }
    }
  }
}


