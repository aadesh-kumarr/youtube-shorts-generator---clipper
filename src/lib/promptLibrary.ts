// src/lib/promptLibrary.ts
//
// One version-controlled place for every prompt the Clipper sends.
//
// Now the prose lives in prompts/<channel>.md and is read at request time, so
// editing a prompt is editing a markdown file. The ARITHMETIC stays in code:
// word budgets, section durations, beat counts and the like are computed and
// passed in as {{placeholders}}, because those are derived from config and from
// the video being made, not written by hand.
//
// File format: `## section-id` starts a section, everything until the next
// `## ` is its body. Anything before the first heading is notes for whoever
// edits the file and is never sent to a model.

import fs from 'fs';
import path from 'path';

export type PromptChannel = 'clipper';

type Cached = { mtimeMs: number; sections: Map<string, string> };

const cache = new Map<string, Cached>();

/** Prompts are project content and live in the repository-level prompts folder. */
function resolveFile(channel: PromptChannel): string {
  const file = path.join(process.cwd(), 'prompts', `${channel}.md`);
  if (fs.existsSync(file)) return file;
  throw new Error(`Prompt file for "${channel}" not found at ${file}`);
}

function parse(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let id: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (id) sections.set(id, body.join('\n').trim());
    body = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+([a-z0-9-]+)\s*$/.exec(line);
    if (heading) {
      flush();
      id = heading[1];
    } else if (id) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Read one section, with {{placeholders}} filled in.
 *
 * Re-read whenever the file changes on disk, so a prompt edit takes effect on
 * the next generation without restarting anything.
 */
export function loadPrompt(
  channel: PromptChannel,
  id: string,
  vars: Record<string, string | number> = {}
): string {
  const file = resolveFile(channel);
  const mtimeMs = fs.statSync(file).mtimeMs;
  let entry = cache.get(file);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    entry = { mtimeMs, sections: parse(fs.readFileSync(file, 'utf8')) };
    cache.set(file, entry);
  }

  const body = entry.sections.get(id);
  if (body === undefined) {
    throw new Error(
      `Prompt "${id}" is missing from ${file}. Sections present: ` +
      [...entry.sections.keys()].join(', ')
    );
  }

  // An unfilled placeholder is a silent hole in a prompt - the model would
  // simply never see that rule - so it fails loudly instead.
  return body.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Prompt "${channel}/${id}" wants {{${name}}}, which was not provided.`);
    }
    return String(vars[name]);
  });
}


