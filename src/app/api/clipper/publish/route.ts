import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/apiRoute';
import path from 'path';
import fs from 'fs';
import { sendClipsToPublishingWebhook } from '@/lib/webhook';

/** The dashboard sends hashtags as free text; accept either form. */
const parseHashtags = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const tag = String(item).trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
};

const resolveVideoPath = (videoUrl: string): string => {
  // If the path has a leading slash, strip it (e.g. /output/short_xx.mp4 -> output/short_xx.mp4)
  const relative = videoUrl.startsWith('/') ? videoUrl.slice(1) : videoUrl;
  return path.join(process.cwd(), 'public', relative);
};

export const POST = apiRoute(
  'POST /api/clipper/publish',
  async (req) => {
    const data = await req.json();
    const {
      videoid,
      clip1_transcript,
      clip2_transcript,
      clip3_transcript,
      clip1_videoUrl,
      clip2_videoUrl,
      clip3_videoUrl,
      clip1_title,
      clip2_title,
      clip3_title,
      clip1_description,
      clip2_description,
      clip3_description,
      clip1_hashtags,
      clip2_hashtags,
      clip3_hashtags,
    } = data;

    if (!videoid) {
      return NextResponse.json({ error: 'videoid is required' }, { status: 400 });
    }

    console.log(`[publish-api] Preparing to republish clips for Video ID: ${videoid}`);

    // Map each clip videoUrl and transcript to a WebhookClipInput structure
    const clips = [
      {
        filePath: resolveVideoPath(clip1_videoUrl || ''),
        transcript: clip1_transcript || '',
        title: clip1_title || '',
        description: clip1_description || '',
        hashtags: parseHashtags(clip1_hashtags)
      },
      {
        filePath: resolveVideoPath(clip2_videoUrl || ''),
        transcript: clip2_transcript || '',
        title: clip2_title || '',
        description: clip2_description || '',
        hashtags: parseHashtags(clip2_hashtags)
      },
      {
        filePath: resolveVideoPath(clip3_videoUrl || ''),
        transcript: clip3_transcript || '',
        title: clip3_title || '',
        description: clip3_description || '',
        hashtags: parseHashtags(clip3_hashtags)
      },
    ].filter(c => {
      if (!c.filePath) return false;
      const exists = fs.existsSync(c.filePath);
      if (!exists) {
        console.warn(`[publish-api] Warning: Video file not found at ${c.filePath} for webhook payload construction.`);
      }
      return exists;
    });

    if (clips.length === 0) {
      return NextResponse.json({ error: 'No valid video files found on disk to publish.' }, { status: 400 });
    }

    // Call the outbound webhook with backoff retries
    await sendClipsToPublishingWebhook(videoid, clips);

    return NextResponse.json({
      success: true,
      message: 'Clips successfully published to N8N!',
    });
  }
);


