import { loadPrompt } from './promptLibrary';
import { callOpenAI, ChatMessage } from './openai';
import { cleanJsonText } from './ai-hooks';
import { CONFIG } from './config';

/**
 * The copy that actually gets posted.
 *
 * Kept separate from the selection stage's `suggested_title` and
 * `reason_for_clip`, which are working notes written for whoever reviews the
 * clips. Those used to be published verbatim, so captions went out reading
 * "...which makes it highly shareable and comment-friendly".
 */
export interface ClipMetadata {
  /** Hook-shaped, short enough to survive truncation on every platform. */
  title: string;
  /** Post copy. First line has to work on its own — the rest is behind "more". */
  caption: string;
  /** Bare tags, no leading '#'. Rendered with one at the point of use. */
  hashtags: string[];
}

export interface ClipMetadataInput {
  /** What is actually said in the clip. */
  transcript: string;
  /** The selection stage's internal label, as a hint only. */
  workingTitle: string;
}

const METADATA_MODEL = process.env.OPENAI_METADATA_MODEL || CONFIG.OPENAI_MODEL;

/**
 * Arabic, Perso-Arabic, and their presentation forms.
 *
 * The prompt forbids this script, but a prompt is not a guarantee — the model
 * follows the transcript it is shown, and one Hindi source that Whisper
 * resolved into Urdu produced a complete set of Urdu titles, captions and
 * hashtags. This is the deterministic check standing behind the instruction.
 */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;



function fallbackMetadata(input: ClipMetadataInput): ClipMetadata {
  return {
    title: input.workingTitle,
    caption: '',
    hashtags: [],
  };
}

function coerceHashtags(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const tag = String(item).trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}

/** True when any published field carries script the audience cannot read. */
function hasForbiddenScript(meta: ClipMetadata): boolean {
  return ARABIC_SCRIPT.test(`${meta.title} ${meta.caption} ${meta.hashtags.join(' ')}`);
}

function buildMessages(listing: string, sourceTitle?: string, scriptFeedback?: boolean): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: loadPrompt('clipper', 'clip-metadata') },
    {
      role: 'user',
      content: sourceTitle
        ? `These clips come from: ${sourceTitle}\n\n${listing}`
        : listing,
    },
  ];

  if (scriptFeedback) {
    messages.push({ role: 'assistant', content: 'Previous response' });
    messages.push({
      role: 'user',
      content:
        'That response contained Urdu / Perso-Arabic script. The transcript is in that script only because the recogniser mislabelled spoken Hindi as Urdu — the audience reads Devanagari. ' +
        'Rewrite every title, caption and hashtag in Hindi using Devanagari script (or English where the speech is genuinely English). Output the same JSON shape and nothing else.',
    });
  }

  return messages;
}

function parseResponse(raw: string, clips: ClipMetadataInput[]): ClipMetadata[] {
  const parsed = JSON.parse(cleanJsonText(raw));
  const entries: any[] = Array.isArray(parsed) ? parsed : parsed.clips;
  if (!Array.isArray(entries)) throw new Error('no "clips" array in response');

  return clips.map((input, i) => {
    const entry = entries[i];
    if (!entry) return fallbackMetadata(input);
    const title = String(entry.title || '').trim();
    return {
      title: title || input.workingTitle,
      caption: String(entry.caption || '').trim(),
      hashtags: coerceHashtags(entry.hashtags),
    };
  });
}

/**
 * Writes publishable title, caption and hashtags for a batch of clips.
 *
 * Never throws. By the time this runs the clips are already rendered to disk, so
 * a metadata failure must not lose them — it falls back to the working titles
 * and leaves the caption empty for a human to fill in.
 */
export async function generateClipMetadata(
  clips: ClipMetadataInput[],
  context: { sourceTitle?: string } = {}
): Promise<ClipMetadata[]> {
  if (clips.length === 0) return [];

  const listing = clips
    .map((c, i) => [
      `### Clip ${i + 1}`,
      `internal label (do not reuse): ${c.workingTitle}`,
      `transcript: ${c.transcript.slice(0, 1800)}`,
    ].join('\n'))
    .join('\n\n');

  try {
    const raw = await callOpenAI(
      buildMessages(listing, context.sourceTitle),
      { model: METADATA_MODEL, maxTokens: 8192 }
    );
    let result = parseResponse(raw, clips);

    // One corrective pass. The model mirrors the script of the transcript it is
    // shown, so a mislabelled source reliably produces unreadable copy however
    // firmly the system prompt asks otherwise.
    if (result.some(hasForbiddenScript)) {
      console.warn('[clip-metadata] Response came back in Arabic script — retrying with correction.');
      try {
        const retry = await callOpenAI(
          buildMessages(listing, context.sourceTitle, true),
          { model: METADATA_MODEL, maxTokens: 8192 }
        );
        const corrected = parseResponse(retry, clips);
        if (corrected.some(hasForbiddenScript)) {
          console.error(
            '[clip-metadata] Still Arabic script after the retry. The transcript itself is almost ' +
            'certainly in Urdu — re-transcribe with the language pinned to "hi" rather than publishing this.'
          );
        }
        result = corrected;
      } catch (retryErr: any) {
        console.error(`[clip-metadata] Correction pass failed (${retryErr.message}). Keeping the first response.`);
      }
    }

    console.log(`[clip-metadata] Wrote copy for ${result.length} clip(s) using ${METADATA_MODEL}.`);
    return result;
  } catch (err: any) {
    console.error(
      `[clip-metadata] Metadata generation failed (${err.message}). ` +
      `Falling back to working titles — captions will be empty and need writing by hand.`
    );
    return clips.map(fallbackMetadata);
  }
}


