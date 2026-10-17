import { NextRequest } from 'next/server';
import { apiRoute } from '@/lib/apiRoute';
import { runClipperPipeline, extractYoutubeVideoId, initDirectories } from '@/lib/clipper-pipeline';

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

/**
 * Streaming (NDJSON) pipeline endpoint used by the Clipper.AI dashboard.
 * The pipeline itself lives in @/lib/clipper-pipeline so the automation
 * endpoint (/api/clipper/run) executes exactly the same code path.
 */
export const POST = apiRoute<Record<string, string>, NextRequest>(
  'POST /api/clipper/process',
  async (req) => {
    try {
      initDirectories();
    } catch (err) {
      console.error('[process] Failed to initialize directories:', err);
    }

    const {
      url, cropLayout, bypassCache, bypassHooksCache, language, hotwords,
      watermarkMode, watermarkRegion,
    } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'YouTube URL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const videoid = extractYoutubeVideoId(url);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let isControllerClosed = false;

        const sendProgress = (step: string, data?: Record<string, any>) => {
          if (isControllerClosed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify({ step, ...data }) + '\n'));
          } catch (e: any) {
            isControllerClosed = true;
            console.warn('[process-api] Client closed the stream. Background processing continues.', e?.message || e);
          }
        };

        const closeStream = () => {
          if (isControllerClosed) return;
          try { controller.close(); } catch { /* stream was already closed */ }
          isControllerClosed = true;
        };

        // Keeps the connection alive through the long Python/FFmpeg stages.
        const heartbeat = setInterval(() => sendProgress('heartbeat'), 8000);

        try {
          const result = await runClipperPipeline({
            url,
            cropLayout,
            bypassCache,
            bypassHooksCache,
            language,
            hotwords,
            watermarkMode,
            watermarkRegion,
            // Dashboard runs stay review-first; automation goes through /api/clipper/run.
            publish: false,
            onProgress: sendProgress,
          });

          clearInterval(heartbeat);
          sendProgress('completed', {
            clips: result.clips,
            videoid: result.videoid,
            webhookStatus: result.webhookStatus,
            webhookMessage: result.webhookMessage,
            activeModel: null,
            modelName: null,
            modelAction: 'All AI models idle — GPU memory free',
          });
          closeStream();
        } catch (error: any) {
          clearInterval(heartbeat);
          console.error('[process-api] Pipeline execution failed:', error);
          sendProgress('error', { message: error?.message || String(error) });
          closeStream();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Video-Id': videoid,
      },
    });
  }
);


