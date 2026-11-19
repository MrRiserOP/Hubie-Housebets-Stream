/**
 * OpenAI access (official SDK). Backend only — the key never reaches a browser.
 *  - Responses API for Hubie's lines (structured JSON output)
 *  - human-readable error explanations for the setup wizard
 *  - connection test
 *  - hourly usage limits so a demo can't run up a surprise bill
 */
import OpenAI, { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { EMOTIONS, EXPRESSIONS, COMBOS, type Combo, type Emotion, type Expression } from '../../../packages/shared/src/protocol.ts';
import { HUBIE_SYSTEM_PROMPT, LINE_SCHEMA, buildUserInput } from './persona.ts';
import type { LLMContext, LLMProvider, LineOut, Situation } from './types.ts';

export function openaiClient(env: Record<string, string | undefined> = process.env, timeoutMs?: number) {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY || 'missing',
    baseURL: env.OPENAI_BASE_URL || undefined,
    timeout: timeoutMs ?? Number(env.LLM_TIMEOUT_MS || 12000),
    maxRetries: 1, // one quick SDK retry for 408/409/429/5xx; we have our own fallback after that
  });
}

export interface ExplainedError { code: string; message: string; retryable: boolean }

/** Turn any OpenAI/network error into something a non-technical person can act on. */
export function explainOpenAIError(e: unknown): ExplainedError {
  if (e instanceof APIConnectionTimeoutError) return { code: 'timeout', message: 'OpenAI did not answer in time. Check the internet connection of this computer/server and try again.', retryable: true };
  if (e instanceof APIConnectionError) return { code: 'network', message: 'Could not reach OpenAI. This computer/server may have no internet access, or a firewall/proxy is blocking api.openai.com.', retryable: true };
  if (e instanceof APIError) {
    const code = (e.code ?? (e.error as any)?.code ?? '') as string;
    if (e.status === 401) return { code: 'invalid_key', message: 'OpenAI rejected the API key. Make sure you copied the whole key (it starts with "sk-") from platform.openai.com → API keys, and that it was not deleted.', retryable: false };
    if (e.status === 429 && /insufficient_quota|billing/i.test(code + e.message)) return { code: 'no_credits', message: 'The key works, but the OpenAI account has no credits or billing is not set up. Add a payment method / credits at platform.openai.com → Settings → Billing, then test again.', retryable: false };
    if (e.status === 429) return { code: 'rate_limited', message: 'OpenAI is rate-limiting this key right now (too many requests). Wait a minute and try again; Hubie will slow down automatically.', retryable: true };
    if (e.status === 403) return { code: 'forbidden', message: 'The key is valid but not allowed to use this model or region. Check the project permissions for the key at platform.openai.com, or pick another model.', retryable: false };
    if (e.status === 404) return { code: 'model_not_found', message: `The model was not found for this account. Check the model name in settings (${(e as any).param ?? 'model'}).`, retryable: false };
    if (e.status === 400) return { code: 'bad_request', message: `OpenAI did not accept the request: ${e.message.slice(0, 160)}`, retryable: false };
    if ((e.status ?? 0) >= 500) return { code: 'openai_down', message: 'OpenAI is having problems on their side. Hubie will keep going with backup lines and retry later.', retryable: true };
    return { code: `http_${e.status}`, message: e.message.slice(0, 200), retryable: false };
  }
  return { code: 'unknown', message: (e as Error)?.message?.slice(0, 200) ?? 'Unknown error', retryable: true };
}

/** Rolling one-hour usage counter. */
export { UsageLimiter } from './usage.ts';
import { UsageLimiter } from './usage.ts';

export async function testOpenAIConnection(env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; model?: string; reply?: string; error?: ExplainedError }> {
  if (!env.OPENAI_API_KEY) return { ok: false, error: { code: 'missing', message: 'No API key saved yet.', retryable: false } };
  const client = openaiClient(env, 20000);
  const model = env.OPENAI_MODEL || 'gpt-5.4-mini';
  try {
    const r = await client.responses.create({ model, input: 'Reply with exactly: Hubie is ready.', max_output_tokens: 40, ...reasoningParam(env, model) } as any);
    return { ok: true, model, reply: (r as any).output_text?.trim() };
  } catch (e) {
    return { ok: false, model, error: explainOpenAIError(e) };
  }
}

/** Reasoning models accept a reasoning effort; keep latency low for live commentary. */
function reasoningParam(env: Record<string, string | undefined>, model: string) {
  const effort = env.OPENAI_REASONING_EFFORT ?? 'low';
  if (!effort || effort === 'off') return {};
  return /^(gpt-5|o\d)/.test(model) ? { reasoning: { effort } } : {};
}

export function normalizeLine(o: any): LineOut | null {
  if (!o || typeof o.text !== 'string' || !o.text.trim()) return null;
  const expression: Expression = EXPRESSIONS.includes(o.expression) ? o.expression : 'speaking';
  const tone: Emotion = EMOTIONS.includes(o.emotion) ? o.emotion : EMOTIONS.includes(o.tone) ? o.tone : 'relaxed';
  const combo: Combo | undefined = COMBOS.includes(o.combo) ? o.combo : undefined;
  let caption = typeof o.caption === 'string' ? o.caption.trim().toUpperCase().slice(0, 48) : '';
  if (caption.split(/\s+/).length > 7) caption = '';
  return { text: o.text.trim(), expression, tone, combo, caption: caption || undefined };
}

export class OpenAIResponsesLLM implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private noReasoning = false;
  constructor(private env: Record<string, string | undefined>, private limiter: UsageLimiter) {
    this.client = openaiClient(env);
  }
  get model() { return this.env.OPENAI_MODEL || 'gpt-5.4-mini'; }

  async generate(s: Situation, ctx: LLMContext): Promise<LineOut> {
    if (!this.limiter.canSpend(1)) throw Object.assign(new Error('hourly OpenAI LLM call limit reached'), { code: 'usage_limit' });
    this.limiter.spend(1);
    const body: any = {
      model: this.model,
      instructions: HUBIE_SYSTEM_PROMPT,
      input: buildUserInput(s, ctx),
      max_output_tokens: Number(this.env.OPENAI_MAX_OUTPUT_TOKENS || 600),
      text: { format: { type: 'json_schema', name: 'hubie_line', schema: LINE_SCHEMA, strict: true } },
      store: false,
      ...(this.noReasoning ? {} : reasoningParam(this.env, this.model)),
    };
    let r: any;
    try {
      r = await this.client.responses.create(body);
    } catch (e) {
      // Some models reject the reasoning parameter; retry once without it and remember.
      if (e instanceof APIError && e.status === 400 && /reasoning/i.test(e.message) && !this.noReasoning) {
        this.noReasoning = true;
        delete body.reasoning;
        r = await this.client.responses.create(body);
      } else throw e;
    }
    const text: string = r.output_text ?? '';
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const out = normalizeLine(parsed);
    if (!out) throw new Error('unparseable model output');
    return out;
  }
}
