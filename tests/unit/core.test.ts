import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyseFrame, sampleTrack, textVisemeTrack, estimateDurationMs } from '../../services/lipsync/src/lipsync.ts';
import { Memory } from '../../services/memory/src/memory.ts';
import { ResilientLLM, MockLLM, parseLine } from '../../services/ai/src/providers.ts';
import { mockGenerate } from '../../services/ai/src/mockBank.ts';
import { VoiceService, BrowserTTS, type TTSProvider } from '../../services/tts/src/tts.ts';
import type { LLMContext, LLMProvider, Situation } from '../../services/ai/src/types.ts';
import { limboResult } from '../../packages/game-adapters/src/simulated.ts';
import { parseMultiplier } from '../../packages/game-adapters/src/playwrightAdapter.ts';

const ctx: LLMContext = { recentLines: [], recentChat: [], showState: { segment: 'gameplay', rounds: 0, wins: 0, losses: 0, bestMultiplier: 0, game: 'x' } };

describe('lipsync', () => {
  it('silence keeps the mouth closed; loud audio opens it', () => {
    const st = { floor: 0.01, peak: 0.1 };
    const silent = new Uint8Array(1024).fill(128);
    expect(analyseFrame(silent, new Uint8Array(512), 44100, st).open).toBeLessThan(0.05);
    const loud = Uint8Array.from({ length: 1024 }, (_, i) => 128 + Math.round(90 * Math.sin(i / 3)));
    const freq = Uint8Array.from({ length: 512 }, (_, i) => (i < 20 ? 220 : 40));
    let open = 0;
    for (let i = 0; i < 5; i++) open = analyseFrame(loud, freq, 44100, st).open;
    expect(open).toBeGreaterThan(0.3);
  });
  it('text track opens on vowels and closes at the end', () => {
    const tr = textVisemeTrack('Hello chat, big win!', 2000);
    const opens = [100, 400, 800, 1200].map((t) => sampleTrack(tr, t).open);
    expect(Math.max(...opens)).toBeGreaterThan(0.3);
    expect(sampleTrack(tr, 2100).open).toBe(0);
  });
  it('duration estimate scales with words and rate', () => {
    expect(estimateDurationMs('one two three four five six')).toBeGreaterThan(1500);
    expect(estimateDurationMs('one two three', 2)).toBeLessThan(estimateDurationMs('one two three', 1));
  });
});

describe('memory', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-mem-')), 'm.db');
  it('recognises new and returning viewers and persists across reopen', () => {
    const m = new Memory(file);
    expect(m.touchViewer('1', 'sam', 0).isNew).toBe(true);
    expect(m.touchViewer('1', 'sam', 60_000).isReturning).toBe(false);
    expect(m.touchViewer('1', 'sam', 60_000 + 31 * 60_000).isReturning).toBe(true);
    m.set('show_state', { segment: 'funny' });
    m.close();
    const m2 = new Memory(file);
    expect(m2.get<any>('show_state', null).segment).toBe('funny');
    expect(m2.touchViewer('1', 'sam').isNew).toBe(false);
    m2.close();
  });
  it('tracks used lines and duplicate rounds', () => {
    const m = new Memory(':memory:');
    m.markUsed('Hello there chat!');
    expect(m.wasUsedRecently('hello there, chat')).toBe(true);
    m.logRound({ id: 'r1', game: 'g', outcome: 'win', simulated: true });
    expect(m.hasRound('r1')).toBe(true);
  });
});

describe('AI provider', () => {
  it('parses JSON lines and rejects junk', () => {
    expect(parseLine('blah {"text":"hi","expression":"happy","emotion":"warm"}')?.expression).toBe('happy');
    expect(parseLine('{"text":"hi","expression":"happy","emotion":"hyped","combo":"big_win","caption":"the sloth has awakened"}')?.caption).toBe('THE SLOTH HAS AWAKENED');
    expect(parseLine('{"text":"hi","expression":"evil"}')?.expression).toBe('speaking');
    expect(parseLine('no json')).toBeNull();
  });
  it('falls back to mock when the LLM is down and opens a circuit', async () => {
    let calls = 0;
    const broken: LLMProvider = { name: 'broken', generate: async () => { calls++; throw new Error('503'); } };
    const events: string[] = [];
    const llm = new ResilientLLM(broken, (ok, d) => events.push(`${ok}:${d}`));
    const sit: Situation = { kind: 'segment', segment: 'funny' };
    for (let i = 0; i < 5; i++) expect((await llm.generate(sit, ctx)).text.length).toBeGreaterThan(5);
    expect(calls).toBe(3); // circuit opened after 3 failures
    expect(llm.lastProvider).toBe('mock');
    expect(events.some((e) => e.startsWith('false'))).toBe(true);
  });
  it('mock bank avoids recently used lines', () => {
    const sit: Situation = { kind: 'round', game: 'x', simulated: true, outcome: 'loss', tier: 'tiny', lossStreak: 1, winStreak: 0, nearMiss: false, roundsPlayed: 3, brief: false };
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) seen.push(mockGenerate(sit, { ...ctx, recentLines: seen }).text);
    expect(new Set(seen).size).toBe(8);
  });
  it('mock never promises wins when asked', async () => {
    const out = await new MockLLM().generate({ kind: 'chat_reply', user: 'v', text: 'will I win if I deposit?', isNew: false, isReturning: false, isQuestion: true }, ctx);
    expect(out.text.toLowerCase()).toMatch(/nobody can promise|demo play money/);
  });
});

describe('voice service', () => {
  it('falls back down the chain when the primary TTS fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-tts-'));
    const failing: TTSProvider = { name: 'cloud', available: async () => true, synth: async () => { throw new Error('HTTP 500'); } };
    const health: string[] = [];
    const v = new VoiceService([failing, new BrowserTTS()], dir, (ok, d) => health.push(`${ok}:${d}`));
    const r = await v.synth({ id: 'a', text: 'hello', tone: 'relaxed', rate: 1 });
    expect(r.provider).toBe('browser');
    expect(r.browserSpeech).toBe(true);
    expect(health.some((h) => h.includes('fallback'))).toBe(true);
  });
});

describe('game helpers', () => {
  it('limbo distribution has ~1% edge', () => {
    let wins = 0; const N = 40_000;
    for (let i = 0; i < N; i++) if (limboResult() >= 2) wins++;
    expect(wins / N).toBeGreaterThan(0.47);
    expect(wins / N).toBeLessThan(0.52);
  });
  it('parses multipliers from game text', () => {
    expect(parseMultiplier('1,234.50×')).toBe(1234.5);
    expect(parseMultiplier('Result: 2.00x')).toBe(2);
    expect(parseMultiplier('nothing')).toBeUndefined();
  });
});

describe('outbound safety — negated responsible advice', () => {
  it('allows directly negated advice but still blocks encouragement', async () => {
    const { checkOutbound } = await import('../../services/safety/src/safety.ts');
    expect(checkOutbound("Please keep your rent money where it is, don't chase it with real cash.").ok).toBe(true);
    expect(checkOutbound('Never deposit your savings for a stream, friends.').ok).toBe(true);
    expect(checkOutbound('This is play money, so no deposits, no chasing.').ok).toBe(true);
    expect(checkOutbound('This is play money, and nobody should ever bet rent.').ok).toBe(true);
    expect(checkOutbound("Don't hesitate to deposit, chat!").ok).toBe(false);
    expect(checkOutbound('Everybody should bet their rent!').ok).toBe(false);
    expect(checkOutbound('Go chase it with your rent money!').ok).toBe(false);
    expect(checkOutbound('You will definitely win this time.').ok).toBe(false);
  });
});
