// src/lib/serviceHealth.ts
//
// Which local model servers exist, and whether they are up.
//
// Two routes reported this independently and had already drifted: /api/status
// called Whisper "large-v3-turbo" while /api/clipper/models/status called it
// "large-v3". The backend moved to large-v3 (see TRANSCRIPTION_CACHE_VERSION in
// clipper-pipeline.ts, which exists precisely because that change invalidated
// every cached transcript), so one of the two was simply wrong. Naming the
// servers once removes the chance of a third answer.

import { CONFIG } from './config';

/** True when the service answers at all — a 4xx still means it is running. */
export async function probeService(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export interface ServiceHealth {
  whisperBackend: boolean;
  /** No endpoint to probe — a configured key is the only signal available. */
  llmConfigured: boolean;
}

export async function probeAllServices(): Promise<ServiceHealth> {
  const whisperBackend = await probeService(`${CONFIG.WHISPER_BACKEND_URL}/unload`);
  return { whisperBackend, llmConfigured: !!CONFIG.OPENAI_API_KEY };
}

/** Display names and ports, so every status endpoint agrees on them. */
export const SERVICE_INFO = {
  whisper: { name: 'Faster-Whisper (large-v3)', port: 5000 },
  llm: { name: () => `OpenAI ${CONFIG.OPENAI_MODEL}`, port: null },
} as const;


