import fs from 'fs';
import path from 'path';
import { WordTimestamp } from './whisper';
import { CONFIG } from './config';

/**
 * Formats a timestamp in seconds to ASS format: H:MM:SS.cs
 */
function formatASSTime(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);

  const hStr = h.toString();
  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toString().padStart(2, '0');
  const csStr = cs.toString().padStart(2, '0');

  return `${hStr}:${mStr}:${sStr}.${csStr}`;
}

/** Horizontal breathing room, so a wrapped line never touches the frame edge. */
const MARGIN_H = 70;
/** Words per caption group, before the width check trims it further. */
const MAX_WORDS_PER_CHUNK = 3;
/**
 * Rough width ceiling for one line, in characters.
 *
 * Devanagari sets much wider than Latin at the same point size, and the frame is
 * only 1080 wide — at the old 65px nothing ever came close, but at display size
 * a three-word Hindi group will overflow and wrap mid-word unless it is split.
 */
const MAX_CHARS_PER_CHUNK = 20;

/**
 * Converts a style colour to the form an inline override tag expects.
 *
 * The two are not the same notation: a style field is &HAABBGGRR, while \c
 * takes &HBBGGRR& — six digits and a terminating ampersand. Passing the
 * eight-digit form to \c leaves libass parsing the alpha pair as colour data.
 */
function inlineColour(styleColour: string): string {
  const hex = styleColour.trim().replace(/^&[Hh]/, '').replace(/&$/, '');
  const bgr = hex.length === 8 ? hex.slice(2) : hex.padStart(6, '0');
  return `&H${bgr.toUpperCase()}&`;
}

/** How long the active word's scale pop takes, in milliseconds. */
const POP_MS = 110;
/** Size the active word jumps to before settling back to 100%. */
const POP_SCALE = 112;

/**
 * Groups words into caption chunks, breaking early when a group would be too
 * wide for the frame rather than relying on the renderer to wrap it.
 */
function groupWords<T extends { word: string }>(words: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let chars = 0;

  for (const word of words) {
    const cost = word.word.length + (current.length ? 1 : 0);
    const tooWide = current.length > 0 && chars + cost > MAX_CHARS_PER_CHUNK;
    const tooMany = current.length >= MAX_WORDS_PER_CHUNK;

    if (tooWide || tooMany) {
      chunks.push(current);
      current = [];
      chars = 0;
    }

    current.push(word);
    chars += current.length === 1 ? word.word.length : cost;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Converts Whisper word timestamps into an Advanced SubStation Alpha (.ass) file.
 *
 * Times are rescaled relative to the clip start, words are grouped into short
 * chunks, and the word currently being spoken is recoloured and given a brief
 * scale pop.
 *
 * @param words - Raw words with absolute timestamps
 * @param startTimeSec - Start time of the clip in seconds
 * @param endTimeSec - End time of the clip in seconds
 * @param clipId - Unique identifier for the clip files
 * @returns Path to the generated ASS subtitle file
 */
export function generateAssSubtitles(
  words: WordTimestamp[],
  startTimeSec: number,
  endTimeSec: number,
  clipId: string
): string {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const outputFilePath = path.join(tmpDir, `captions_${clipId}.ass`);
  console.log(`[subtitles] Generating ASS file for clip: ${clipId} (${startTimeSec}s - ${endTimeSec}s)`);

  // Overlap, not containment. Requiring the whole word to sit inside the clip
  // silently dropped any word straddling either boundary — so a clip could open
  // on a caption that starts a word late.
  const clipWords = words
    .filter((w) => w.end > startTimeSec && w.start < endTimeSec)
    .map((w) => ({
      word: w.word.toUpperCase(),
      start: Math.max(0, w.start - startTimeSec),
      end: Math.min(endTimeSec - startTimeSec, w.end - startTimeSec),
    }));

  if (clipWords.length === 0) {
    console.warn(`[subtitles] Warning: No words found in the timestamp range: ${startTimeSec}s - ${endTimeSec}s`);
  }

  const chunks = groupWords(clipWords);
  const dialogueLines: string[] = [];
  const activeColour = inlineColour(CONFIG.CAPTION_ACTIVE_COLOUR);

  for (const chunk of chunks) {
    const chunkEnd = chunk[chunk.length - 1].end;

    // One dialogue line per word: the whole group stays on screen while the
    // active word is highlighted, so the line redraws as each word lands.
    for (let j = 0; j < chunk.length; j++) {
      const activeWord = chunk[j];
      const start = activeWord.start;

      let end = j < chunk.length - 1 ? chunk[j + 1].start : chunkEnd;
      if (end <= start) end = start + 0.1;

      const textParts = chunk.map((wordObj, index) => {
        if (index !== j) return wordObj.word;
        return (
          `{\\c${activeColour}` +
          `\\fscx${POP_SCALE}\\fscy${POP_SCALE}` +
          `\\t(0,${POP_MS},\\fscx100\\fscy100)}` +
          `${wordObj.word}{\\r}`
        );
      });

      dialogueLines.push(
        `Dialogue: 0,${formatASSTime(start)},${formatASSTime(end)},Default,,0,0,0,,${textParts.join(' ')}`
      );
    }
  }

  // Bold=-1 selects the bold face of the family, which is what carries a caption
  // at this size. Nirmala UI is the only family on a stock Windows install that
  // covers Devanagari — naming Arial here meant libass silently fell back to
  // whatever it could find for every Hindi clip ever rendered.
  const assContent = `[Script Info]
Title: Clipper Captions
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${CONFIG.CAPTION_FONT},${CONFIG.CAPTION_FONT_SIZE},${CONFIG.CAPTION_COLOUR},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${CONFIG.CAPTION_OUTLINE},${CONFIG.CAPTION_SHADOW},2,${MARGIN_H},${MARGIN_H},${CONFIG.CAPTION_MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join('\n')}
`;

  fs.writeFileSync(outputFilePath, assContent, 'utf-8');
  console.log(
    `[subtitles] ASS saved: ${outputFilePath} ` +
    `(${chunks.length} groups, ${dialogueLines.length} cues, ` +
    `${CONFIG.CAPTION_FONT} ${CONFIG.CAPTION_FONT_SIZE}px, marginV ${CONFIG.CAPTION_MARGIN_V})`
  );
  return outputFilePath;
}


