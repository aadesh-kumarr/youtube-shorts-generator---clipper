import { loadPrompt } from './promptLibrary';
import { WordTimestamp } from './whisper';
import { callOpenAI, ChatMessage } from './openai';
import { CONFIG } from './config';

export interface ViralClip {
  start_time: string; // HH:MM:SS
  end_time: string;   // HH:MM:SS
  viral_score: number; // 1-10
  reason_for_clip: string;
  suggested_title: string;
  crop_layout: 'center' | 'stacked';
}

/**
 * One utterance: a run of words ending at a sentence ending or a natural pause.
 *
 * Units are the unit of selection. The model picks clips by unit id rather than
 * by timestamp, which is what makes a mid-sentence cut structurally impossible
 * rather than something to detect and repair afterwards.
 */
export interface SpeechUnit {
  id: number;
  start: number;
  end: number;
  text: string;
  wordCount: number;
}

/** Sentence enders across the scripts this pipeline sees. */
const TERMINAL_PUNCT = /[.!?।॥]["'”’)\]]*$/;
/** Weaker breaks, used only to split a unit that has run too long. */
const SOFT_PUNCT = /[,;:—–]["'”’)\]]*$/;

/**
 * Silence between words that reads as a phrase boundary.
 *
 * Punctuation alone is not enough. Measured across these transcripts, terminal
 * punctuation lands on 2.3% of words in Hindi sources against 12.7% in English —
 * one sentence ending every 43 seconds versus every 4. Pauses are the signal
 * that survives that gap.
 */
const UNIT_GAP_SEC = 0.35;
/** Past this, split at the last comma instead of waiting for a real boundary. */
const UNIT_MAX_WORDS = 26;
/** Below this a unit is too small to be a useful cut point; keep accumulating. */
const UNIT_MIN_WORDS = 3;

/**
 * Cut slightly before the first word and slightly after the last.
 *
 * A cut placed exactly on a word's start timestamp clips the attack of the first
 * consonant, which is audible and makes an otherwise clean opening sound
 * chopped. The tail guard lets the closing word decay instead of stopping dead.
 */
const CLIP_LEAD_PAD_SEC = 0.15;
const CLIP_TAIL_PAD_SEC = 0.25;

/**
 * Converts seconds into HH:MM:SS string format.
 */
function secondsToHHMMSS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0')
  ].join(':');
}

/**
 * Converts HH:MM:SS string format to seconds.
 */
export function hhmmssToSeconds(timeStr: string): number {
  const parts = String(timeStr || '').trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(timeStr) || 0;
}

/** Short MM:SS label used inside the prompt, where hours are mostly noise. */
function shortTimeLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Splits the word stream into numbered speech units.
 *
 * A unit ends at terminal punctuation or at a pause of at least UNIT_GAP_SEC.
 * A unit that reaches UNIT_MAX_WORDS without hitting either is split at its last
 * comma, and failing that, split hard — so a long unpunctuated run still yields
 * usable cut points rather than one enormous unit.
 *
 * Ids are assigned once across the whole transcript, so they stay meaningful
 * after the transcript is chunked for the model.
 */
function buildSpeechUnits(words: WordTimestamp[]): SpeechUnit[] {
  const units: SpeechUnit[] = [];
  let buffer: WordTimestamp[] = [];
  let lastSoftIdx = -1;

  const flush = (upToIdx?: number) => {
    const take = upToIdx === undefined ? buffer.length : upToIdx + 1;
    const chunk = buffer.slice(0, take);
    if (chunk.length === 0) return;
    units.push({
      id: units.length + 1,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim(),
      wordCount: chunk.length,
    });
    buffer = buffer.slice(take);
    lastSoftIdx = -1;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    buffer.push(word);

    const text = word.word.trim();
    if (SOFT_PUNCT.test(text)) lastSoftIdx = buffer.length - 1;

    const next = words[i + 1];
    const gap = next ? next.start - word.end : Infinity;

    if (buffer.length >= UNIT_MIN_WORDS && (TERMINAL_PUNCT.test(text) || gap >= UNIT_GAP_SEC)) {
      flush();
      continue;
    }

    if (buffer.length >= UNIT_MAX_WORDS) {
      const canSplitAtComma = lastSoftIdx >= UNIT_MIN_WORDS - 1 && lastSoftIdx < buffer.length - 1;
      flush(canSplitAtComma ? lastSoftIdx : undefined);
    }
  }

  flush();
  return units;
}

/**
 * Renders units for the prompt as `[id] (m:ss) text`.
 */
function formatUnitsForPrompt(units: SpeechUnit[]): string {
  return units
    .map(u => `[${u.id}] (${shortTimeLabel(u.start)}) ${u.text}`)
    .join('\n');
}

/**
 * Cleans and extracts raw JSON object/array from markdown fences or surrounding commentary.
 */
export function cleanJsonText(rawText: string): string {
  let cleaned = rawText.trim();

  // Strip Markdown code blocks
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3);
  }

  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }

  cleaned = cleaned.trim();

  // Extract JSON boundaries (prefer outermost object or array)
  const firstCurly = cleaned.indexOf('{');
  const firstSquare = cleaned.indexOf('[');

  let startIdx = -1;
  let endIdx = -1;

  if (firstCurly !== -1 && (firstSquare === -1 || firstCurly < firstSquare)) {
    startIdx = firstCurly;
    endIdx = cleaned.lastIndexOf('}');
  } else if (firstSquare !== -1) {
    startIdx = firstSquare;
    endIdx = cleaned.lastIndexOf(']');
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  // Remove trailing commas before closing braces/brackets (common LLM formatting flaw)
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  return cleaned;
}

/**
 * Loads the clip-selection system prompt.
 *
 * A missing file is fatal on purpose. This used to fall back to a single
 * embedded sentence and log a warning, and every clip the pipeline ever cut was
 * selected by that sentence — the warning went to a log nobody reads, so the
 * real prompt being absent looked exactly like it working.
 */
function loadSystemPrompt(): string {
  return loadPrompt('clipper', 'viral-hooks');
}

/**
 * Model used for clip extraction. Falls back to the app-wide default rather
 * than pinning its own — set OPENAI_CLIPPER_MODEL only to override this path.
 */
const CLIPPER_MODEL = process.env.OPENAI_CLIPPER_MODEL || CONFIG.OPENAI_MODEL;

/**
 * Builds the chat messages for one clip-extraction call, optionally appending
 * parse-failure feedback so the retry can self-correct.
 */
function buildClipMessages(systemPrompt: string, userContent: string, errorFeedback?: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Numbered transcript:\n\n${userContent}` },
  ];

  if (errorFeedback) {
    messages.push({ role: 'assistant', content: 'Failed response' });
    messages.push({
      role: 'user',
      content: `Your previous response failed to parse as valid JSON due to: ${errorFeedback}. Please output ONLY a valid JSON object matching the requested schema with a "clips" array of objects using start_unit and end_unit. Do NOT include markdown code blocks, preamble, or explanations.`,
    });
  }

  return messages;
}

/**
 * Turns raw model output into clips, resolving unit ids to timestamps.
 *
 * Unit ids are the contract, but a model that ignores the schema and returns
 * timestamps anyway still produces something usable — those fall back to the old
 * parsing path rather than dropping the clip.
 */
function resolveClips(rawClips: any[], units: SpeechUnit[]): ViralClip[] {
  if (!Array.isArray(rawClips) || units.length === 0) return [];

  const byId = new Map(units.map(u => [u.id, u]));
  const firstId = units[0].id;
  const lastId = units[units.length - 1].id;

  return rawClips
    .map((c: any, index: number): ViralClip | null => {
      let startSec: number;
      let endSec: number;

      const rawStartUnit = Number(c.start_unit ?? c.startUnit ?? c.start);
      const rawEndUnit = Number(c.end_unit ?? c.endUnit ?? c.end);

      if (Number.isFinite(rawStartUnit) && Number.isFinite(rawEndUnit)) {
        const startId = Math.min(Math.max(Math.round(rawStartUnit), firstId), lastId);
        const endId = Math.min(Math.max(Math.round(rawEndUnit), startId), lastId);
        const startUnit = byId.get(startId);
        const endUnit = byId.get(endId);
        if (!startUnit || !endUnit) return null;
        startSec = startUnit.start;
        endSec = endUnit.end;
      } else if (c.start_time && c.end_time) {
        // Schema ignored. Salvage it rather than losing the candidate.
        console.warn(`[ai-hooks] Clip ${index + 1} came back with timestamps instead of unit ids.`);
        startSec = hhmmssToSeconds(String(c.start_time));
        endSec = hhmmssToSeconds(String(c.end_time));
      } else {
        return null;
      }

      // Pad outward, but never past the material that actually exists.
      startSec = Math.max(units[0].start, startSec - CLIP_LEAD_PAD_SEC);
      endSec = Math.min(units[units.length - 1].end, endSec + CLIP_TAIL_PAD_SEC);

      const rawScore = Number(c.viral_score);
      const viralScore = !isNaN(rawScore) ? Math.min(10, Math.max(1, rawScore)) : 5;

      const reason = String(c.reason_for_clip || c.reason || 'High engagement moment').trim();
      const title = String(c.suggested_title || c.title || `Clip #${index + 1}`).trim();

      const rawLayout = String(c.crop_layout || '').toLowerCase().trim();
      const cropLayout: 'center' | 'stacked' = rawLayout === 'stacked' ? 'stacked' : 'center';

      return {
        start_time: secondsToHHMMSS(startSec),
        end_time: secondsToHHMMSS(endSec),
        viral_score: viralScore,
        reason_for_clip: reason,
        suggested_title: title,
        crop_layout: cropLayout,
      };
    })
    .filter((c): c is ViralClip => {
      if (!c || !c.start_time || !c.end_time) return false;
      const startSec = hhmmssToSeconds(c.start_time);
      const endSec = hhmmssToSeconds(c.end_time);
      return endSec > startSec && (endSec - startSec) >= 15;
    });
}

/**
 * Splits units into time-based overlapping chunks so a long source still fits
 * the model's context window. Unit ids stay global across chunks.
 */
function chunkUnits(units: SpeechUnit[], chunkDurationSec = 600, overlapSec = 60): SpeechUnit[][] {
  if (units.length === 0) return [];
  const totalDuration = units[units.length - 1].end - units[0].start;

  if (totalDuration <= chunkDurationSec && units.length <= 400) {
    return [units];
  }

  const chunks: SpeechUnit[][] = [];
  let chunkStart = units[0].start;
  const maxEnd = units[units.length - 1].end;

  while (chunkStart < maxEnd) {
    const chunkEnd = chunkStart + chunkDurationSec;
    const slice = units.filter(u => u.start >= chunkStart && u.start < chunkEnd);

    if (slice.length >= 5) {
      chunks.push(slice);
    }

    chunkStart += (chunkDurationSec - overlapSec);
    if (chunkStart >= maxEnd) break;
  }

  return chunks.length > 0 ? chunks : [units];
}

/**
 * Processes a single chunk of transcript with retry mechanism.
 */
async function processChunk(
  systemPrompt: string,
  unitsChunk: SpeechUnit[],
  allUnits: SpeechUnit[],
  chunkIndex: number,
  totalChunks: number
): Promise<ViralClip[]> {
  const formatted = formatUnitsForPrompt(unitsChunk);
  const timeRange = `${secondsToHHMMSS(unitsChunk[0].start)} - ${secondsToHHMMSS(unitsChunk[unitsChunk.length - 1].end)}`;
  console.log(`[ai-hooks] Processing chunk ${chunkIndex + 1}/${totalChunks} (${unitsChunk.length} units, time: ${timeRange})...`);

  // API failures (network/rate-limit/5xx) propagate immediately — retrying with
  // "parse feedback" can't fix those. Only a JSON.parse failure on an otherwise
  // successful response gets one feedback-guided retry.
  let rawResponse: string;
  try {
    rawResponse = await callOpenAI(buildClipMessages(systemPrompt, formatted), {
      model: CLIPPER_MODEL,
      maxTokens: 16384,
    });
  } catch (err: any) {
    console.error(`[ai-hooks] OpenAI API error during chunk ${chunkIndex + 1}:`, err.message);
    throw err;
  }

  let parsedJson: any = null;
  try {
    parsedJson = JSON.parse(cleanJsonText(rawResponse));
  } catch (err: any) {
    console.warn(`[ai-hooks] Chunk ${chunkIndex + 1} JSON parse failed: "${err.message}". Retrying with feedback...`);
    try {
      const retryResponse = await callOpenAI(buildClipMessages(systemPrompt, formatted, err.message), {
        model: CLIPPER_MODEL,
        maxTokens: 16384,
      });
      parsedJson = JSON.parse(cleanJsonText(retryResponse));
    } catch (retryErr: any) {
      console.error(`[ai-hooks] Chunk ${chunkIndex + 1} retry failed:`, retryErr.message);
      return []; // Skip this failed chunk so other chunks can still succeed
    }
  }

  let rawClipsArray: any[] = [];
  if (parsedJson && Array.isArray(parsedJson)) {
    rawClipsArray = parsedJson;
  } else if (parsedJson && Array.isArray(parsedJson.clips)) {
    rawClipsArray = parsedJson.clips;
  } else if (parsedJson && parsedJson.data && Array.isArray(parsedJson.data.clips)) {
    rawClipsArray = parsedJson.data.clips;
  } else if (parsedJson && parsedJson.data && Array.isArray(parsedJson.data)) {
    rawClipsArray = parsedJson.data;
  }

  // Resolved against the full unit list: a clip may legitimately end just past
  // the chunk's own tail.
  const clips = resolveClips(rawClipsArray, allUnits);
  console.log(`[ai-hooks] Chunk ${chunkIndex + 1}/${totalChunks} returned ${clips.length} clip(s).`);
  return clips;
}

/** The text a clip actually contains, for the ranking pass. */
function clipText(clip: ViralClip, units: SpeechUnit[], maxChars: number): string {
  const start = hhmmssToSeconds(clip.start_time);
  const end = hhmmssToSeconds(clip.end_time);
  const text = units
    .filter(u => u.start >= start - 0.5 && u.end <= end + 0.5)
    .map(u => u.text)
    .join(' ');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Ranks every candidate against every other in one call.
 *
 * Per-chunk scores are not comparable: each was assigned by a model that saw
 * only its own ten-minute window, so a 9 from minute 3 and a 9 from minute 90
 * mean different things. Without this pass the scores collapse into a tie, and a
 * tie resolved by insertion order means the first chunk wins every slot — which
 * is how a 3h56m source ended up clipped entirely within its first four minutes.
 */
async function rankCandidatesGlobally(
  candidates: ViralClip[],
  units: SpeechUnit[]
): Promise<ViralClip[]> {
  if (candidates.length <= 1) return candidates;

  const listing = candidates
    .map((c, i) => {
      const duration = Math.round(hhmmssToSeconds(c.end_time) - hhmmssToSeconds(c.start_time));
      return [
        `### Candidate ${i + 1}`,
        `at ${c.start_time}, ${duration}s, self-scored ${c.viral_score}`,
        `opens with: "${clipText(c, units, 220)}"`,
        `editor's note: ${c.reason_for_clip}`,
      ].join('\n');
    })
    .join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a short-form editor choosing which clips to publish from one long interview.\n\n' +
        'Each candidate was scored in isolation by an editor who saw only a ten-minute window of ' +
        'the source, so the self-scores are not comparable to each other — treat them as weak ' +
        'evidence at best and judge the clips yourself.\n\n' +
        'Rank them best first. Weight most heavily whether the opening line can hold a stranger ' +
        'who has no context: a clip opening on a connective, a pronoun with no referent, or the ' +
        'middle of an answer ranks below one that opens on a claim, a number, a name, or a ' +
        'question, however interesting the rest of it is.\n\n' +
        'Reply with only JSON: {"ranking": [3, 1, 7, ...]} listing every candidate number exactly once, best first.',
    },
    { role: 'user', content: listing },
  ];

  try {
    const raw = await callOpenAI(messages, { model: CLIPPER_MODEL, maxTokens: 8192 });
    const parsed = JSON.parse(cleanJsonText(raw));
    const order: number[] = Array.isArray(parsed) ? parsed : parsed.ranking;
    if (!Array.isArray(order)) throw new Error('no "ranking" array in response');

    const seen = new Set<number>();
    const ranked: ViralClip[] = [];
    for (const n of order) {
      const idx = Number(n) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        seen.add(idx);
        ranked.push(candidates[idx]);
      }
    }
    // Anything the model forgot keeps its place at the back.
    candidates.forEach((c, i) => { if (!seen.has(i)) ranked.push(c); });

    console.log(`[ai-hooks] Ranked ${candidates.length} candidates head-to-head.`);
    return ranked;
  } catch (err: any) {
    console.warn(`[ai-hooks] Global ranking failed (${err.message}); falling back to self-scores.`);
    return fallbackRank(candidates);
  }
}

/**
 * Score-order fallback for when the ranking call fails.
 *
 * The tie-break deliberately is not chronological. Array.prototype.sort is
 * stable, so ties preserve insertion order, and insertion order here is chunk
 * order — meaning an all-ties response silently resolves to "everything from the
 * start of the video". Scattering ties by a hash of the start time keeps the
 * result deterministic without that bias.
 */
function fallbackRank(candidates: ViralClip[]): ViralClip[] {
  const scatter = (clip: ViralClip): number => {
    const seed = Math.round(hhmmssToSeconds(clip.start_time) * 1000);
    return ((seed * 2654435761) >>> 0) / 4294967296;
  };
  return [...candidates].sort(
    (a, b) => (b.viral_score - a.viral_score) || (scatter(a) - scatter(b))
  );
}

/** True when two clips are close enough to be the same moment. */
function overlaps(clip: ViralClip, chosen: ViralClip[]): boolean {
  const start = hhmmssToSeconds(clip.start_time);
  const end = hhmmssToSeconds(clip.end_time);
  const duration = end - start;

  return chosen.some(existing => {
    const exStart = hhmmssToSeconds(existing.start_time);
    const exEnd = hhmmssToSeconds(existing.end_time);
    const overlapDuration = Math.max(0, Math.min(end, exEnd) - Math.max(start, exStart));
    const minDuration = Math.min(duration, exEnd - exStart);
    return Math.abs(start - exStart) < 25 || (minDuration > 0 && overlapDuration / minDuration > 0.4);
  });
}

/**
 * Picks the final clips from the ranked candidates, spread across the source.
 *
 * The source is divided into as many zones as there are slots and the best
 * available candidate is taken from each. Any slot whose zone had nothing usable
 * is filled from the best remaining candidates, so enforcing spread never costs
 * a clip — it only stops all of them coming from the same stretch.
 */
function selectClips(ranked: ViralClip[], units: SpeechUnit[], maxCount = 3): ViralClip[] {
  const eligible = ranked.filter(clip => {
    const duration = hhmmssToSeconds(clip.end_time) - hhmmssToSeconds(clip.start_time);
    return duration >= 15 && duration <= 120;
  });

  const sourceStart = units[0].start;
  const sourceEnd = units[units.length - 1].end;
  const zoneLength = (sourceEnd - sourceStart) / maxCount;

  const chosen: ViralClip[] = [];
  const taken = new Set<ViralClip>();

  for (let zone = 0; zone < maxCount; zone++) {
    const zoneStart = sourceStart + zone * zoneLength;
    const zoneEnd = zone === maxCount - 1 ? Infinity : zoneStart + zoneLength;

    const pick = eligible.find(clip => {
      if (taken.has(clip)) return false;
      const start = hhmmssToSeconds(clip.start_time);
      return start >= zoneStart && start < zoneEnd && !overlaps(clip, chosen);
    });

    if (pick) {
      chosen.push(pick);
      taken.add(pick);
    }
  }

  // Backfill slots left empty because their zone had nothing usable.
  for (const clip of eligible) {
    if (chosen.length >= maxCount) break;
    if (taken.has(clip) || overlaps(clip, chosen)) continue;
    chosen.push(clip);
    taken.add(clip);
  }

  return chosen.sort((a, b) => hhmmssToSeconds(a.start_time) - hhmmssToSeconds(b.start_time));
}

/**
 * Discourse markers that make a terrible first word for a clip.
 *
 * Only used to warn. Units opening this way are legitimate cut points in the
 * middle of a clip -- it is specifically the opening unit that matters, and the
 * judgement of whether a given opening works belongs to the model, not to a
 * word list. This exists so a bad opening is visible in the log rather than
 * discovered after publishing.
 */
const WEAK_OPENERS = /^(so|and|but|because|therefore|then|anyway|also|तो|और|लेकिन|क्योंकि|इसलिए|फिर)(?:[\s,]|$)/iu;

/**
 * Analyzes the transcript to identify clips worth cutting.
 *
 * Words are grouped into speech units, the units are chunked to fit the context
 * window, every chunk contributes candidates, and a single ranking pass compares
 * all of them before the final spread-aware selection.
 */
export async function extractViralHooks(words: WordTimestamp[]): Promise<ViralClip[]> {
  if (!words || words.length === 0) {
    throw new Error('No word timestamps provided for viral hook extraction.');
  }

  console.log(`[ai-hooks] Preparing transcript and calling OpenAI (${CLIPPER_MODEL}) for clip extraction...`);

  const systemPrompt = loadSystemPrompt();
  const units = buildSpeechUnits(words);
  if (units.length === 0) {
    throw new Error('Transcript produced no speech units.');
  }

  const sourceDuration = units[units.length - 1].end - units[0].start;
  console.log(
    `[ai-hooks] ${words.length} words → ${units.length} speech units ` +
    `(one per ${(sourceDuration / units.length).toFixed(1)}s of source).`
  );

  const chunks = chunkUnits(units, 600, 60);
  console.log(`[ai-hooks] Processing ${units.length} units across ${chunks.length} chunk(s)...`);

  const allClips: ViralClip[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkClips = await processChunk(systemPrompt, chunks[i], units, i, chunks.length);
    allClips.push(...chunkClips);
  }

  if (allClips.length === 0) {
    throw new Error(`LLM returned no valid clips across ${chunks.length} transcript segment(s).`);
  }

  const scoreSpread = new Set(allClips.map(c => c.viral_score)).size;
  console.log(
    `[ai-hooks] ${allClips.length} candidate(s) collected, ${scoreSpread} distinct score(s).`
  );

  const ranked = await rankCandidatesGlobally(allClips, units);
  const selected = selectClips(ranked, units, 3);

  if (selected.length === 0) {
    throw new Error(`No candidate clip fell within the usable duration range.`);
  }

  console.log(
    `[ai-hooks] Selected ${selected.length} clip(s) at ` +
    selected.map(c => c.start_time).join(', ') +
    ` from a ${secondsToHHMMSS(sourceDuration)} source.`
  );

  for (const clip of selected) {
    const opening = clipText(clip, units, 60);
    if (WEAK_OPENERS.test(opening)) {
      console.warn(
        `[ai-hooks] Clip at ${clip.start_time} opens on a connective: "${opening}". ` +
        `It will play as a fragment -- review before publishing.`
      );
    }
  }

  return selected;
}


