import fs from 'fs';
import path from 'path';

import { Agent } from 'undici';
import { CONFIG } from './config';

// Define types to match your existing app interfaces
export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  words: WordTimestamp[];
}

/**
 * Sends explicit unload command to local Whisper server to release VRAM immediately.
 */
async function unloadWhisper(): Promise<void> {
  try {
    await fetch(`${CONFIG.WHISPER_BACKEND_URL}/unload`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    console.log('[whisper] Sent explicit VRAM unload signal to Whisper backend.');
  } catch {
    // Ignore if server is offline or already freed
  }
}

export interface TranscribeOptions {
  /**
   * ISO code pinned for the whole file ("hi", "en", ...). Omit or pass "auto"
   * to let Whisper detect it.
   *
   * Detection is per-file, and the model still code-switches inside a file even
   * once it has decided -- which is how three clips cut from one Hindi podcast
   * came back two in Devanagari and one transliterated into Latin.
   */
  language?: string;
  /** Free text steering style and spelling; also carries context for names. */
  initialPrompt?: string;
  /** Comma-separated proper nouns to bias the decoder toward. */
  hotwords?: string;
}

export async function transcribeAudio(
  audioFilePath: string,
  options: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  console.log(`[whisper] Starting local transcription for: ${audioFilePath}`);
  
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }

  // Create Form Data payload from local file buffer
  const fileBuffer = fs.readFileSync(audioFilePath);
  const fileName = path.basename(audioFilePath);
  const fileBlob = new Blob([fileBuffer]);

  const formData = new FormData();
  formData.append('file', fileBlob, fileName);
  if (options.language) formData.append('language', options.language);
  if (options.initialPrompt) formData.append('initial_prompt', options.initialPrompt);
  if (options.hotwords) formData.append('hotwords', options.hotwords);

  try {
    // Send to local Python Whisper backend with a 2-hour timeout limit
    const response = await fetch(`${CONFIG.WHISPER_BACKEND_URL}/transcribe`, {
      method: 'POST',
      body: formData,
      dispatcher: new Agent({
        headersTimeout: 120 * 60 * 1000, // 2 hours
        bodyTimeout: 120 * 60 * 1000,    // 2 hours
      }),
    } as any);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Local Whisper transcription failed: ${errorData.error || response.statusText}`);
    }

    const data = await response.json();
    const words: WordTimestamp[] = data.words || [];
    const text: string = data.text || '';

    console.log(`[whisper] Transcription completed successfully. Word count: ${words.length}`);
    
    return {
      text,
      words,
    };
  } finally {
    // Guarantee Whisper releases all VRAM before downstream LLM / FFmpeg steps start
    await unloadWhisper();
  }
}

