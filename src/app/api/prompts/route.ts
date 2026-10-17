import { NextResponse } from 'next/server';
import { CONFIG } from '@/lib/config';
import { loadPrompt } from '@/lib/promptLibrary';

export const dynamic = 'force-dynamic';

/** Returns only version-controlled AI instructions, never secrets or runtime data. */
export function GET() {
  return NextResponse.json(
    {
      prompts: [
        {
          id: 'viral-hooks',
          label: 'Viral moment selection',
          stage: 'Transcript → clip candidates',
          model: process.env.OPENAI_CLIPPER_MODEL || CONFIG.OPENAI_MODEL,
          content: loadPrompt('clipper', 'viral-hooks'),
        },
        {
          id: 'clip-metadata',
          label: 'Titles, captions & hashtags',
          stage: 'Rendered clips → social metadata',
          model: process.env.OPENAI_METADATA_MODEL || CONFIG.OPENAI_MODEL,
          content: loadPrompt('clipper', 'clip-metadata'),
        },
      ],
      note: 'The transcript and clip data are supplied separately as runtime user messages.',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
