import { CONFIG } from '@/lib/config';
import { fetchWithTimeout } from '@/lib/fetchUtils';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** What this call is for, shown in the AI-calls panel. */
  label?: string;
};

/**
 * How long to wait before retrying a rate-limited call.
 *
 * OpenAI tells us exactly how long: either in the `retry-after` header or inside
 * the error message ("Please try again in 1.107s"). Honour that rather than
 * guessing, and fall back to exponential backoff when neither is present.
 */
type FetchLikeResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
};

function rateLimitDelayMs(response: FetchLikeResponse, body: string, attempt: number): number {
  // fetchWithTimeout is a custom http/https wrapper, not real fetch, so treat
  // headers as optional rather than assuming a standard Response.
  const header = (name: string): string | null => {
    try {
      return response?.headers?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };

  const ms = header('retry-after-ms');
  const seconds = header('retry-after');
  const raw = ms || seconds;
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      // `retry-after` is seconds; `retry-after-ms` is already milliseconds.
      return ms ? value : value * 1000;
    }
  }

  const match = body.match(/try again in ([\d.]+)(ms|s)\b/i);
  if (match) {
    const value = parseFloat(match[1]);
    if (Number.isFinite(value)) {
      return match[2].toLowerCase() === 'ms' ? value : value * 1000;
    }
  }

  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** Request body, with the per-model quirks applied. */
function buildRequestBody(messages: ChatMessage[], options: ChatOptions, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  if (options.maxTokens !== undefined) {
    body.max_completion_tokens = options.maxTokens;
  }
  // gpt-5 rejects an explicit temperature; every other model accepts one.
  if (!model.startsWith('gpt-5') && options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  return body;
}

/**
 * POSTs the completion, retrying transient failures.
 *
 * A 429 here is normally a burst problem, not a quota problem — the TPM window
 * refills within a second or two. Without this retry a whole run dies on a
 * transient limit, which is exactly what happened when n8n fired ~68 publish
 * calls at once.
 */
async function postWithRetry(requestBody: Record<string, unknown>, model: string): Promise<FetchLikeResponse> {
  const maxAttempts = CONFIG.OPENAI_MAX_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithTimeout(`${CONFIG.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    }, 10 * 60 * 1000);

    if (response.ok) return response;

    const body = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`OpenAI API returned ${response.status}: ${body}`);
    }

    const delay = rateLimitDelayMs(response, body, attempt);
    console.warn(
      `[openai] ${response.status} from ${model} (attempt ${attempt + 1}/${maxAttempts + 1}) — retrying in ${Math.round(delay)}ms`
    );
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Logs and stores token usage.
 *
 * Logged on every call because reasoning tokens are billed but invisible in
 * the output, so per-call cost is otherwise unknowable.
 */
function recordUsage(data: any, model: string): void {
  const usage = data.usage;
  if (!usage) return;

  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  console.log(
    `[openai] ${model} · in ${usage.prompt_tokens} · out ${usage.completion_tokens}` +
    (reasoning ? ` (${reasoning} reasoning)` : '') +
    ` · total ${usage.total_tokens}`
  );
}

/** Pulls the assistant text out, turning every "no text" case into a real reason. */
function extractText(data: any, model: string): string {
  const choice = data.choices?.[0];

  // o-series / gpt-5 can set content=null and explain themselves in `refusal`.
  const refusal = choice?.message?.refusal;
  if (refusal) throw new Error(`OpenAI refused the request: ${refusal}`);

  let text: string | undefined = choice?.message?.content;

  // gpt-5 / newer models may return content as an array of blocks.
  if (Array.isArray(text)) {
    text = (text as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text' || b.type === 'output_text')
      .map(b => b.text ?? '')
      .join('');
  }

  if (typeof text === 'string' && text.trim()) return text;

  // Reasoning models (gpt-5, o-series) spend max_completion_tokens on hidden
  // reasoning BEFORE emitting any content. Set the budget too low and the
  // whole allowance goes to reasoning: finish_reason is 'length' and content
  // comes back empty. Naming the cause here saves rediscovering it every time.
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
  if (choice?.finish_reason === 'length') {
    throw new Error(
      `OpenAI hit the token limit before producing any content` +
      (reasoningTokens ? ` (${reasoningTokens} tokens went to reasoning)` : '') +
      `. ${model} is a reasoning model — raise maxTokens well above the length ` +
      `of the answer you expect.`
    );
  }
  console.error('[openai] Unexpected response shape:', JSON.stringify(data).slice(0, 500));
  throw new Error('OpenAI returned an empty response');
}

export async function callOpenAI(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (!CONFIG.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured. Add it to app/.env.local and restart Next.js.');
  }

  const model = options.model || CONFIG.OPENAI_MODEL;
  const response = await postWithRetry(buildRequestBody(messages, options, model), model);
  const data = await response.json();
  recordUsage(data, model);
  return extractText(data, model);
}


