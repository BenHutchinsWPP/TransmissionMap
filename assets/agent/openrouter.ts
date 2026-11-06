// ─── OpenRouter client: one chat completion per call, from the browser ───────
// Role: the only module that talks to OpenRouter (OpenAI-compatible
//       /chat/completions with `tools`), using the visitor's own key.
//         chat(messages, tools, {key, model, signal})
//                              one request, no streaming; always sends
//                              max_tokens and usage.include, so every answer
//                              carries usage.cost. max_tokens is MAX_TOKENS,
//                              lowered to the model's max completion tokens
//                              when the catalogue has fetched it; OpenRouter
//                              checks a key's balance against it, so a 402
//                              that says what the key can afford is retried
//                              once with 90% of that. Returns
//                              {ok: true, message, cost} or {ok: false, code}.
//         listToolModels()     GET /models once per session (~775 KB),
//                              filtered to models that take `tools`, sorted
//                              by price, `:free` variants last and marked;
//                              each with its provider, display name and the
//                              catalogue's Artificial Analysis intelligence
//                              index (null when the catalogue has none).
//         RECOMMENDED_MODELS / DEFAULT_MODEL   the short in-code set the chat
//                              offers without a catalogue fetch: providers
//                              outside China, for organisations whose policies
//                              exclude them (any catalogue model stays selectable).
//       Errors come back as a ChatErrorCode (the chat translates it): HTTP
//       status → code, never the response body or the request, so neither the
//       key nor model text can reach an error message, the diagnostics log or
//       the console. (A 402 body is read only for the number of tokens the key
//       can afford; none of its text is kept.) The key travels in the Authorization header only.
//
// Deps: constants.ts (OPENROUTER_ORIGIN).

import { OPENROUTER_ORIGIN } from '../constants.js';

const API = `${OPENROUTER_ORIGIN}/api/v1`;
export const MAX_TOKENS = 16384;
export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
export const RECOMMENDED_MODELS: readonly string[] = [
  DEFAULT_MODEL, 'openai/gpt-6-luna', 'google/gemini-3.8-flash', 'meta/muse-spark-1.3', 'anthropic/claude-sonnet-5.5',
];

// ─── Messages (the OpenAI shape) ──────────────────────────────────────────────

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export type ChatErrorCode =
  | 'auth'          // 401: key missing, wrong or revoked
  | 'credit'        // 402: the key has no credit left
  | 'moderation'    // 403: the provider's moderation refused the input
  | 'timeout'       // 408
  | 'rate'          // 429
  | 'bad-request'   // other 4xx (e.g. a model that does not take tools)
  | 'server'        // 5xx, or an error inside a 200 body
  | 'network'       // fetch itself failed (offline, blocked)
  | 'aborted'       // the visitor pressed Stop
  | 'bad-response'; // a 200 whose body is not a chat completion

export type ChatOutcome =
  | { ok: true; message: Extract<ChatMessage, { role: 'assistant' }>; cost: number }
  | { ok: false; code: ChatErrorCode; status?: number };

function statusCode(status: number): ChatErrorCode {
  if (status === 401) return 'auth';
  if (status === 402) return 'credit';
  if (status === 403) return 'moderation';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate';
  return status >= 500 ? 'server' : 'bad-request';
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

export interface ChatOpts { key: string; model?: string; signal?: AbortSignal }

/** The most completion tokens a catalogue entry allows, by model id (filled by listToolModels). */
const modelMaxOutput = new Map<string, number>();

/** A 402 about max_tokens: the tokens the key can afford (null when the text gives none), or undefined for any other 402. */
async function affordable(res: Response): Promise<number | null | undefined> {
  let text: string;
  try { text = JSON.stringify(await res.json()); } catch { return undefined; }
  if (!/max_tokens/.test(text) || !/afford/.test(text)) return undefined;
  const n = Number(/afford\D{0,20}?(\d[\d,]*)/.exec(text)?.[1].replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function chat(messages: ChatMessage[], tools: ToolSchema[], opts: ChatOpts): Promise<ChatOutcome> {
  const model = opts.model ?? DEFAULT_MODEL;
  const send = async (maxTokens: number): Promise<Response | ChatOutcome> => {
    try {
      return await fetch(`${API}/chat/completions`, {
        method: 'POST',
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${opts.key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': globalThis.location?.origin ?? '',
          'X-Title': 'TransmissionMap',
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools.length && { tools }),
          max_tokens: maxTokens,
          usage: { include: true },
        }),
      });
    } catch (e) {
      return { ok: false, code: isAbort(e) ? 'aborted' : 'network' };
    }
  };
  let r = await send(Math.min(MAX_TOKENS, modelMaxOutput.get(model) ?? MAX_TOKENS));
  if (!(r instanceof Response)) return r;
  if (r.status === 402) {
    const n = await affordable(r);
    if (n !== undefined) {
      r = await send(n === null ? 1024 : Math.max(256, Math.floor(n * 0.9)));
      if (!(r instanceof Response)) return r;
    }
  }
  const res = r;
  if (!res.ok) return { ok: false, code: statusCode(res.status), status: res.status };
  let body: {
    choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    usage?: { cost?: unknown };
    error?: unknown;
  };
  try { body = await res.json(); } catch (e) { return { ok: false, code: isAbort(e) ? 'aborted' : 'bad-response' }; }
  if (body?.error) return { ok: false, code: 'server' };
  const m = body?.choices?.[0]?.message;
  if (!m || typeof m !== 'object') return { ok: false, code: 'bad-response' };
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isToolCall) : [];
  const cost = typeof body.usage?.cost === 'number' && Number.isFinite(body.usage.cost) ? body.usage.cost : 0;
  return {
    ok: true,
    cost,
    message: { role: 'assistant', content: typeof m.content === 'string' ? m.content : null, ...(calls.length && { tool_calls: calls }) },
  };
}

function isToolCall(c: unknown): c is ToolCall {
  const f = (c as ToolCall)?.function;
  return typeof (c as ToolCall)?.id === 'string' && typeof f?.name === 'string'
    && (typeof f.arguments === 'string' || f.arguments === undefined);
}

// ─── The model catalogue ──────────────────────────────────────────────────────

export interface ModelInfo {
  id: string; name: string; provider: string;
  /** $ per token */
  promptPrice: number; completionPrice: number;
  /** Artificial Analysis intelligence index, as the catalogue reports it */
  intelligence: number | null;
  free: boolean;
}

/** The provider an id names (`anthropic/…` → `anthropic`): the picker's group before the catalogue lands. */
export const providerOf = (id: string): string => id.replace(/^~/, '').split('/')[0];

let catalogue: Promise<ModelInfo[] | null> | null = null;

/** Models that take tools, cheapest first, free variants last; null when the
 *  catalogue cannot be fetched (the recommended set still works). */
export function listToolModels(): Promise<ModelInfo[] | null> {
  return catalogue ??= fetch(`${API}/models`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: { data?: unknown[] }) => (body.data ?? []).flatMap(toModel).sort(byPrice))
    .catch(() => { catalogue = null; return null; });
}

function toModel(raw: unknown): ModelInfo[] {
  const m = raw as {
    id?: unknown; name?: unknown; supported_parameters?: unknown; top_provider?: { max_completion_tokens?: unknown }; pricing?: { prompt?: unknown; completion?: unknown };
    benchmarks?: { artificial_analysis?: { intelligence_index?: unknown } };
  };
  if (typeof m?.id !== 'string' || !Array.isArray(m.supported_parameters) || !m.supported_parameters.includes('tools')) return [];
  const price = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : Infinity; };
  const cap = Number(m.top_provider?.max_completion_tokens);
  if (Number.isInteger(cap) && cap >= 256) modelMaxOutput.set(m.id, cap); else modelMaxOutput.delete(m.id);
  const iq = m.benchmarks?.artificial_analysis?.intelligence_index;
  // The catalogue names a model "Provider: Model"; the picker groups by the first part.
  const [provider, name] = typeof m.name === 'string' && m.name.includes(': ')
    ? [m.name.slice(0, m.name.indexOf(': ')), m.name.slice(m.name.indexOf(': ') + 2)]
    : [providerOf(m.id), typeof m.name === 'string' ? m.name : m.id];
  return [{
    id: m.id, name, provider,
    intelligence: typeof iq === 'number' && Number.isFinite(iq) && iq >= 0 ? iq : null,
    promptPrice: price(m.pricing?.prompt), completionPrice: price(m.pricing?.completion),
    free: m.id.endsWith(':free'),
  }];
}

const byPrice = (a: ModelInfo, b: ModelInfo) => Number(a.free) - Number(b.free)
  || (a.promptPrice + a.completionPrice) - (b.promptPrice + b.completionPrice) || a.id.localeCompare(b.id);

/** For tests: forget the session's catalogue. */
export function resetModelCatalogue(): void { catalogue = null; modelMaxOutput.clear(); }
