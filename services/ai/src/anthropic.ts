/**
 * Anthropic (Claude) brain via the official SDK. Backend only — the key never reaches a browser.
 *  - structured output through a forced tool call (tool_choice = say_line), validated by normalizeLine
 *  - plain-language error explanations for the control center
 *  - connection test + model list
 *
 * Note: an Anthropic key gives Hubie a brain only. Anthropic has no text-to-speech API,
 * so Hubie's voice needs an OpenAI key (or the clearly-labelled browser voice fallback).
 */
import Anthropic from '@anthropic-ai/sdk';
import { HUBIE_SYSTEM_PROMPT, LINE_SCHEMA, buildUserInput } from './persona.ts';
import { normalizeLine, UsageLimiter, type ExplainedError } from './openai.ts';
import type { LLMContext, LLMProvider, LineOut, Situation } from './types.ts';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';

export function anthropicClient(env: Record<string, string | undefined> = process.env, timeoutMs?: number) {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY || 'missing',
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    timeout: timeoutMs ?? Number(env.LLM_TIMEOUT_MS || 12000),
    maxRetries: 1,
  });
}

export function explainAnthropicError(e: unknown): ExplainedError {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { code: 'timeout', message: 'Anthropic did not answer in time. Check the internet connection of this computer/server and try again.', retryable: true };
  if (e instanceof Anthropic.APIConnectionError) return { code: 'network', message: 'Could not reach Anthropic. This computer/server may have no internet access, or a firewall/proxy is blocking api.anthropic.com.', retryable: true };
  if (e instanceof Anthropic.APIError) {
    const t = `${(e.error as any)?.error?.type ?? ''} ${e.message}`;
    if (e.status === 401) return { code: 'invalid_key', message: 'Anthropic rejected the API key. Copy the whole key (it starts with "sk-ant-") from console.anthropic.com → API Keys, and make sure it was not deleted.', retryable: false };
    if (e.status === 400 && /credit balance/i.test(t)) return { code: 'no_credits', message: 'The key works, but the Anthropic account has no credits. Add credits at console.anthropic.com → Plans & Billing, then test again.', retryable: false };
    if (e.status === 403) return { code: 'forbidden', message: 'The key is valid but not allowed to use this model. Check the key\'s workspace permissions at console.anthropic.com, or pick another model.', retryable: false };
    if (e.status === 404) return { code: 'model_not_found', message: 'That Claude model was not found for this account. Pick a model from the list in the control center.', retryable: false };
    if (e.status === 429) return { code: 'rate_limited', message: 'Anthropic is rate-limiting this key right now. Hubie will slow down and retry automatically.', retryable: true };
    if (e.status === 529 || (e.status ?? 0) >= 500) return { code: 'provider_down', message: 'Anthropic is overloaded or having problems. Hubie will use the backup provider and retry later.', retryable: true };
    if (e.status === 400) return { code: 'bad_request', message: `Anthropic did not accept the request: ${e.message.slice(0, 160)}`, retryable: false };
    return { code: `http_${e.status}`, message: e.message.slice(0, 200), retryable: false };
  }
  return { code: 'unknown', message: (e as Error)?.message?.slice(0, 200) ?? 'Unknown error', retryable: true };
}

export async function testAnthropicConnection(env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; model?: string; reply?: string; latencyMs?: number; error?: ExplainedError }> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: { code: 'missing', message: 'No Anthropic API key saved yet.', retryable: false } };
  const model = env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const t0 = Date.now();
  try {
    const r = await anthropicClient(env, 20000).messages.create({ model, max_tokens: 30, messages: [{ role: 'user', content: 'Reply with exactly: Hubie is ready.' }] });
    const reply = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
    return { ok: true, model, reply, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, model, error: explainAnthropicError(e) };
  }
}

export async function listAnthropicModels(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  if (!env.ANTHROPIC_API_KEY) return [];
  const out: string[] = [];
  for await (const m of anthropicClient(env, 15000).models.list({ limit: 100 })) out.push(m.id);
  return out;
}

export class AnthropicLLM implements LLMProvider {
  name = 'anthropic';
  private client: Anthropic;
  constructor(private env: Record<string, string | undefined>, private limiter: UsageLimiter, private onUsage?: (u: { input: number; output: number; ms: number }) => void) {
    this.client = anthropicClient(env);
  }
  get model() { return this.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL; }

  async generate(s: Situation, ctx: LLMContext): Promise<LineOut> {
    if (!this.limiter.canSpend(1)) throw Object.assign(new Error('hourly AI call limit reached'), { code: 'usage_limit' });
    this.limiter.spend(1);
    const t0 = Date.now();
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: Number(this.env.ANTHROPIC_MAX_OUTPUT_TOKENS || 400),
      system: HUBIE_SYSTEM_PROMPT,
      tools: [{ name: 'say_line', description: 'Say Hubie\'s next spoken line on stream, with emotion, expression, animation combo and an optional short on-screen caption.', input_schema: LINE_SCHEMA as any }],
      tool_choice: { type: 'tool', name: 'say_line' },
      messages: [{ role: 'user', content: buildUserInput(s, ctx) }],
    });
    this.onUsage?.({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, ms: Date.now() - t0 });
    const tool = r.content.find((c) => c.type === 'tool_use') as { input?: unknown } | undefined;
    const out = normalizeLine(tool?.input);
    if (!out) throw new Error('unparseable model output');
    return out;
  }
}
