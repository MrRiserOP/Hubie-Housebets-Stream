/**
 * LLM provider selection + resilience.
 *   anthropic  — Claude via the official SDK (default brain when its key is set)
 *   openai     — OpenAI Responses API via the official SDK (alternative / backup)
 *   mock       — demo-mode line bank (no key) and automatic outage fallback
 */
import { HUBIE_SYSTEM_PROMPT, buildUserInput } from './persona.ts';
import { mockGenerate } from './mockBank.ts';
import { OpenAIResponsesLLM, UsageLimiter, explainOpenAIError, normalizeLine } from './openai.ts';
import { AnthropicLLM, explainAnthropicError, DEFAULT_ANTHROPIC_MODEL } from './anthropic.ts';
import type { LLMContext, LLMProvider, LineOut, Situation } from './types.ts';

/** Parse a JSON line from free text (used by non-structured providers and tests). */
export function parseLine(raw: string): LineOut | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return normalizeLine(JSON.parse(m[0])); } catch { return null; }
}

export class MockLLM implements LLMProvider {
  name = 'mock';
  async generate(s: Situation, ctx: LLMContext) { return mockGenerate(s, ctx); }
}

export { AnthropicLLM };

interface Slot { p: LLMProvider; failures: number; openUntil: number }
export interface UsageStats { calls: number; failures: number; inputTokens: number; outputTokens: number; avgMs: number; lastMs: number }

/**
 * Real providers in priority order (e.g. anthropic → openai). A failing provider is skipped
 * (circuit breaker) and the next real one is used. Built-in lines are used ONLY when no real
 * provider is configured (demo mode) or every configured one is failing right now.
 */
export class ResilientLLM implements LLMProvider {
  name: string;
  private slots: Slot[];
  private mock = new MockLLM();
  lastError = '';
  lastErrorCode = '';
  lastProvider = '';
  usage: Record<string, UsageStats> = {};
  constructor(primary: LLMProvider | LLMProvider[], private onHealth?: (ok: boolean, detail: string) => void) {
    const list = (Array.isArray(primary) ? primary : [primary]).filter((p) => p.name !== 'mock');
    this.slots = list.map((p) => ({ p, failures: 0, openUntil: 0 }));
    this.name = this.slots[0]?.p.name ?? 'mock';
  }
  get primary(): LLMProvider { return this.slots[0]?.p ?? this.mock; }
  get chain() { return this.slots.map((s) => s.p.name); }
  get healthy() { return this.isDemo || this.slots.some((s) => Date.now() > s.openUntil); }
  get isDemo() { return this.slots.length === 0; }

  private stat(name: string) { return (this.usage[name] ??= { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, avgMs: 0, lastMs: 0 }); }
  recordTokens(name: string, input: number, output: number) { const u = this.stat(name); u.inputTokens += input; u.outputTokens += output; }

  async generate(s: Situation, ctx: LLMContext): Promise<LineOut> {
    const now = Date.now();
    for (const slot of this.slots) {
      if (now < slot.openUntil) continue;
      const u = this.stat(slot.p.name);
      const t0 = Date.now();
      try {
        const out = await slot.p.generate(s, ctx);
        u.calls++; u.lastMs = Date.now() - t0; u.avgMs = Math.round(u.avgMs + (u.lastMs - u.avgMs) / u.calls);
        if (slot.failures) this.onHealth?.(true, `${slot.p.name} recovered`);
        slot.failures = 0;
        this.lastProvider = slot.p.name;
        return out;
      } catch (e) {
        u.failures++;
        slot.failures++;
        const ex = (e as any)?.code === 'usage_limit'
          ? { code: 'usage_limit', message: 'hourly AI usage limit reached (configurable)', retryable: true }
          : slot.p.name === 'anthropic' ? explainAnthropicError(e) : explainOpenAIError(e);
        this.lastError = ex.message;
        this.lastErrorCode = ex.code;
        const hard = !ex.retryable;
        const next = this.slots.find((x) => x !== slot && Date.now() > x.openUntil)?.p.name;
        if (hard || slot.failures >= 3) {
          const cooldown = hard ? 10 * 60_000 : Math.min(5 * 60_000, 15_000 * 2 ** (slot.failures - 3));
          slot.openUntil = Date.now() + cooldown;
          this.onHealth?.(false, `${slot.p.name}: ${ex.message} — ${next ? `using ${next}` : 'backup lines'} for ${Math.round(cooldown / 1000)}s`);
        } else {
          this.onHealth?.(false, `${slot.p.name}: ${ex.message}`);
        }
      }
    }
    this.lastProvider = 'mock';
    return this.mock.generate(s, ctx);
  }
}

/**
 * LLM_PROVIDER: auto (default) | anthropic | openai | mock
 *   auto → Anthropic if its key is set, else OpenAI, else built-in demo lines.
 * LLM_FALLBACK=true (default) → if the chosen provider fails, try the other configured one.
 */
export function createLLM(env: Record<string, string | undefined>, onHealth?: (ok: boolean, d: string) => void): ResilientLLM {
  const want = (env.LLM_PROVIDER || 'auto').toLowerCase();
  const limiter = new UsageLimiter(Number(env.AI_MAX_CALLS_PER_HOUR || env.OPENAI_MAX_LLM_CALLS_PER_HOUR || 900));
  let llm: ResilientLLM;
  const make: Record<string, () => LLMProvider | null> = {
    anthropic: () => env.ANTHROPIC_API_KEY ? new AnthropicLLM(env, limiter, (u) => llm?.recordTokens('anthropic', u.input, u.output)) : null,
    openai: () => env.OPENAI_API_KEY ? new OpenAIResponsesLLM(env, limiter) : null,
  };
  const order = want === 'mock' ? [] : want === 'openai' ? ['openai', 'anthropic'] : ['anthropic', 'openai'];
  const fallback = env.LLM_FALLBACK !== 'false';
  const chain = order.map((n) => make[n]()).filter((p): p is LLMProvider => !!p);
  // an explicitly chosen provider without a key → none of it (fallback may still supply the other)
  const list = want !== 'auto' && want !== 'mock' && chain[0]?.name !== want ? (fallback ? chain : []) : (fallback ? chain : chain.slice(0, 1));
  llm = new ResilientLLM(list, onHealth);
  return llm;
}

/** Human description of the active brain for status displays (no secrets). */
export function describeBrain(env: Record<string, string | undefined>, llm: ResilientLLM): string {
  if (llm.isDemo) return 'Built-in demo lines (no AI key set)';
  const model = (n: string) => n === 'anthropic' ? (env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL) : (env.OPENAI_MODEL || 'gpt-5.4-mini');
  const [a, ...rest] = llm.chain;
  return `${a === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'} · ${model(a)}${rest.length ? ` (backup: ${rest.map((n) => n === 'anthropic' ? 'Anthropic' : 'OpenAI').join(', ')})` : ''}`;
}
