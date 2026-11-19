import { describe, it, expect } from 'vitest';
import { ResilientLLM, createLLM, describeBrain } from '../../services/ai/src/providers.ts';
import type { LLMProvider } from '../../services/ai/src/types.ts';

const sit: any = { kind: 'idle', topic: 'test' };
const ctx: any = { recentLines: [], chat: [], stats: {} };
const ok = (name: string, text = `${name} line`): LLMProvider => ({ name, generate: async () => ({ text, expression: 'speaking', tone: 'relaxed' }) });
const bad = (name: string, status = 500): LLMProvider => ({ name, generate: async () => { throw Object.assign(new Error('boom'), { status }); } });

describe('provider selection', () => {
  it('auto: Anthropic is the brain when both keys are set; OpenAI is backup', () => {
    const l = createLLM({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x' });
    expect(l.chain).toEqual(['anthropic', 'openai']);
    expect(describeBrain({}, l)).toMatch(/^Anthropic Claude · .*backup: OpenAI/);
  });
  it('auto with only OpenAI → OpenAI; with nothing → demo lines', () => {
    expect(createLLM({ OPENAI_API_KEY: 'sk-x' }).chain).toEqual(['openai']);
    const d = createLLM({});
    expect(d.isDemo).toBe(true);
    expect(describeBrain({}, d)).toMatch(/demo/i);
  });
  it('explicit openai puts OpenAI first; fallback=false removes the backup', () => {
    expect(createLLM({ LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' }).chain).toEqual(['openai', 'anthropic']);
    expect(createLLM({ LLM_PROVIDER: 'anthropic', LLM_FALLBACK: 'false', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' }).chain).toEqual(['anthropic']);
  });
});

describe('fallback chain', () => {
  it('uses the backup real provider before built-in lines', async () => {
    const l = new ResilientLLM([bad('anthropic'), ok('openai')]);
    const out = await l.generate(sit, ctx);
    expect(out.text).toBe('openai line');
    expect(l.lastProvider).toBe('openai');
  });
  it('built-in lines only when every real provider fails', async () => {
    const l = new ResilientLLM([bad('anthropic'), bad('openai')]);
    await l.generate(sit, ctx);
    expect(l.lastProvider).toBe('mock');
  });
  it('a bad key opens the circuit immediately and the backup takes over', async () => {
    let calls = 0;
    const p: LLMProvider = { name: 'anthropic', generate: async () => { calls++; throw new (await import('@anthropic-ai/sdk')).default.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid', new Headers()); } };
    const l = new ResilientLLM([p, ok('openai')]);
    await l.generate(sit, ctx); await l.generate(sit, ctx); await l.generate(sit, ctx);
    expect(calls).toBe(1);
    expect(l.lastErrorCode).toBe('invalid_key');
    expect(l.lastProvider).toBe('openai');
  });
  it('tracks usage per provider without storing secrets', async () => {
    const l = new ResilientLLM([ok('anthropic')]);
    await l.generate(sit, ctx);
    l.recordTokens('anthropic', 100, 20);
    expect(l.usage.anthropic).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
    expect(JSON.stringify(l.usage)).not.toMatch(/sk-/);
  });
});
