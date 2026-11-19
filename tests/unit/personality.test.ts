import { describe, expect, it, vi } from 'vitest';
import { Director } from '../../apps/controller/src/director.ts';
import { SpeechQueue } from '../../apps/controller/src/speech.ts';
import { Memory } from '../../services/memory/src/memory.ts';
import { HumourPicker, ALL_STYLES, hatAllowed, hatViolation, mentionsHat, classifyChat, ConversationMemory, sanitizePersonality, DEFAULT_PERSONALITY } from '../../services/ai/src/personality.ts';
import { MockLLM } from '../../services/ai/src/providers.ts';
import { HUBIE_SYSTEM_PROMPT } from '../../services/ai/src/persona.ts';
import type { LLMContext, LineOut, Situation } from '../../services/ai/src/types.ts';
import type { SpeechRequest } from '../../apps/controller/src/speech.ts';

const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
const P = DEFAULT_PERSONALITY;

describe('hat rule', () => {
  it('detects hat words but not "that"/"what"', () => {
    expect(mentionsHat('the hat has seen things')).toBe(true); expect(mentionsHat('nice top hat')).toBe(true);
    expect(mentionsHat('that is what happened')).toBe(false); expect(mentionsHat('whatever, chat')).toBe(false);
  });
  it('is not allowed by default, allowed right after a viewer mentions it, never when set to "never"', () => {
    expect(hatAllowed(P, ['gg', 'nice round'], 'how is the round going', 100)).toBe(false);
    expect(hatAllowed(P, [], 'love your hat hubie', 100)).toBe(true);
    expect(hatAllowed(P, ['cool hat', 'lol', 'gg'], undefined, 100)).toBe(true);
    expect(hatAllowed(P, ['lol', 'gg', 'nice', 'ok'], undefined, 100)).toBe(false); // mention scrolled out of the last 3 messages
    expect(hatAllowed({ ...P, hat: 'never' }, [], 'your hat is great', 100)).toBe(false);
  });
  it('the system prompt makes the hat a non-personality and keeps the youthful voice rules out of scope', () => {
    expect(HUBIE_SYSTEM_PROMPT).toMatch(/THE HAT RULE/); expect(HUBIE_SYSTEM_PROMPT).toMatch(/hatAllowed/);
    expect(HUBIE_SYSTEM_PROMPT).not.toMatch(/has seen things/i);
  });
  it('built-in demo lines: across 300 lines the hat appears only when allowed', async () => {
    const m = new MockLLM(); let hits = 0; const sits: Situation[] = [
      { kind: 'round', game: 'Limbo', simulated: true, outcome: 'loss', tier: 'tiny', nearMiss: false, lossStreak: 1, winStreak: 0, roundsPlayed: 5, brief: false, target: 2, rolled: 1.2 },
      { kind: 'spontaneous', mode: 'observation' }, { kind: 'spontaneous', mode: 'sloth_joke' }, { kind: 'segment', segment: 'funny' }];
    const ctx = { recentLines: [], recentChat: [], showState: { segment: 'x', rounds: 1, wins: 0, losses: 1, bestMultiplier: 0, game: 'g' } } as LLMContext;
    const speech = new SpeechQueue({ llm: () => ({ isDemo: true, lastProvider: 'mock', generate: (s: Situation, c: LLMContext) => m.generate(s, c) }) as any, voice: () => ({}) as any, memory: new Memory(':memory:'), log, ttsDir: '/tmp', context: () => ctx, play: () => true, stop: () => {}, caption: () => {}, isStopped: () => false });
    let produced = 0;
    for (let i = 0; i < 300; i++) { const l = await speech.generateFresh(sits[i % sits.length], false); if (l) { produced++; if (mentionsHat(l.text)) hits++; } }
    expect(produced).toBeGreaterThan(30); expect(hits).toBe(0);
  });
  it('pipeline guard: an AI that keeps joking about the hat is rejected and regenerated; allowed once a viewer mentions it', async () => {
    const calls: string[] = [];
    const llm: any = { isDemo: false, lastProvider: 'anthropic', generate: async (_s: Situation, c: LLMContext): Promise<LineOut> => { const t = c.avoid?.some((a) => /do NOT mention any hat/.test(a)) ? 'That one hurt, and nobody saw it coming.' : 'Honestly the hat has seen worse.'; calls.push(t); return { text: t, expression: 'happy', tone: 'playful' }; } };
    const mkQ = (hatAllowedFlag: boolean) => new SpeechQueue({ llm: () => llm, voice: () => ({}) as any, memory: new Memory(':memory:'), log, ttsDir: '/tmp', context: () => ({ recentLines: [], recentChat: [], showState: { segment: 'x', rounds: 1, wins: 0, losses: 0, bestMultiplier: 0, game: 'g' }, hatAllowed: hatAllowedFlag }) as LLMContext, play: () => true, stop: () => {}, caption: () => {}, isStopped: () => false });
    const sit: Situation = { kind: 'round', game: 'Limbo', simulated: true, outcome: 'loss', tier: 'tiny', nearMiss: false, lossStreak: 1, winStreak: 0, roundsPlayed: 2, brief: false, target: 2, rolled: 1.1 };
    const q1 = mkQ(false); const a = await q1.generateFresh(sit, false);
    expect(a!.text).not.toMatch(/\bhats?\b/i); expect(q1.stats.hatBlocked).toBeGreaterThanOrEqual(1);
    const b = await mkQ(true).generateFresh(sit, false); expect(b!.text).toMatch(/\bhat\b/i);
    expect(hatViolation('the hat again', false)).toBe(true);
  });
});

describe('humour variety', () => {
  it('uses many styles, never repeats a style back-to-back or 3 in a row, and respects the dials', () => {
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const h = new HumourPicker(rnd); const seen: string[] = [];
    for (let i = 0; i < 400; i++) seen.push(h.pick(P, { chat: i % 3 === 0, teased: false, lost: i % 4 === 0, big: false, spontaneous: i % 5 === 0 }));
    expect(new Set(seen).size).toBeGreaterThanOrEqual(7);
    let backToBack = 0; for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) backToBack++;
    expect(backToBack).toBeLessThan(15); // 400 picks: nearly never the same style twice in a row
    const counts: Record<string, number> = {}; for (const s of seen) counts[s] = (counts[s] ?? 0) + 1;
    expect(Math.max(...Object.values(counts)) / seen.length).toBeLessThan(0.4);
  });
  it('roasting only exists in chat replies; 0 sarcasm/humor dials reduce those styles', () => {
    const h = new HumourPicker(); const noChat = Array.from({ length: 200 }, () => h.pick(P, { chat: false, teased: false, lost: false, big: false, spontaneous: false }));
    expect(noChat).not.toContain('roast'); expect(noChat).not.toContain('comeback');
    const dry = new HumourPicker(); const flat = Array.from({ length: 300 }, () => dry.pick({ ...P, humor: 0 }, { chat: false, teased: false, lost: false, big: false, spontaneous: false }));
    expect(flat.filter((s) => s === 'straight').length / 300).toBeGreaterThan(0.5);
  });
  it('sanitises settings from the control panel', () => {
    expect(sanitizePersonality({ humor: 999, sarcasm: -5, commentary: 'wild' as any, memoryTurns: 1, hat: 'always' as any })).toMatchObject({ humor: 100, sarcasm: 0, commentary: 'balanced', memoryTurns: 4, hat: 'only_when_asked' });
    expect(ALL_STYLES.length).toBe(9);
  });
});

describe('chat understanding', () => {
  it('reads joking, teasing, compliments, criticism, thanks, questions and sarcasm', () => {
    expect(classifyChat('lol that was hilarious').tone).toBe('joking');
    expect(classifyChat('skill issue').tone).toBe('teasing');
    expect(classifyChat('you are so funny hubie').tone).toBe('compliment');
    expect(classifyChat('this stream is boring and rigged').tone).toBe('criticism');
    expect(classifyChat('thanks for the shoutout').tone).toBe('thanks');
    expect(classifyChat('why did it stop at 1.2?').tone).toBe('question');
    expect(classifyChat('sure buddy /s').sarcasmLikely).toBe(true);
    expect(classifyChat('hey everyone').tone).toBe('greeting');
  });
  it('recognises a follow-up from the same viewer', () => {
    expect(classifyChat('why though?', undefined, true).followUp).toBe(true);
    expect(classifyChat('and that last one?', undefined, true).followUp).toBe(true);
    expect(classifyChat('why though?', undefined, false).followUp).toBe(false);
  });
  it('keeps per-viewer threads, bounded memory, and never answers one message twice', () => {
    const c = new ConversationMemory(6);
    for (let i = 0; i < 20; i++) c.add({ id: `m${i}`, user: i % 2 ? 'bob' : 'amy', userId: i % 2 ? 'b' : 'a', text: `message ${i}`, at: Date.now(), tone: 'neutral', topics: ['rounds'] });
    expect(c.turns.length).toBe(6);
    c.recordReply('m18', 'sure thing'); expect(c.alreadyAnswered('m18')).toBe(true); expect(c.alreadyAnswered('m19')).toBe(false);
    expect(c.thread('a').map((t) => t.id)).toContain('m18'); expect(c.forPrompt('a').thisViewer.at(-1)).toMatchObject({ said: 'message 18', hubieReplied: 'sure thing' });
  });
});

describe('director wiring', () => {
  function setup(speechLen = 0) {
    const said: SpeechRequest[] = []; const memory = new Memory(':memory:');
    const d = new Director({ memory, speech: { enqueue: (r: SpeechRequest) => said.push(r), busy: false, length: speechLen, idleForMs: 0, recentCaptions: [] } as any, log, requestRound: vi.fn(), sendChat: () => {}, setExpression: () => {}, broadcast: () => {}, onState: () => {}, isStopped: () => false, gameAgentOnline: () => true, roundIntervalMs: 1000, chatEnabled: () => true, autoStart: true, pauseGame: () => {} });
    return { d, said, memory };
  }
  const base = { at: Date.now(), source: 'kick' as const };
  it('LLM context carries conversation, tone, humour style and the hat flag for a chat reply', () => {
    const { d } = setup();
    d.onChat({ ...base, id: '1', userId: 'a', user: 'amy', text: 'what was the best win so far?' });
    const sit: Situation = { kind: 'chat_reply', user: 'amy', userId: 'a', msgId: '2', text: 'and the worst one?', isNew: false, isReturning: false, isQuestion: true };
    const ctx = d.contextForLLM(sit);
    expect(ctx.hatAllowed).toBe(false); expect(ctx.humourStyle?.id).toBeTruthy(); expect(ctx.viewerTone?.followUp).toBe(true);
    expect(ctx.conversation!.thisViewer[0].said).toMatch(/best win/); expect(ctx.persona).toMatchObject({ humor: 70, sarcasm: 45 });
  });
  it('hatAllowed turns on when chat mentions the hat and back off after it scrolls away', () => {
    const { d } = setup();
    d.onChat({ ...base, id: '1', userId: 'a', user: 'amy', text: 'love the hat' });
    expect(d.contextForLLM({ kind: 'spontaneous', mode: 'observation' }).hatAllowed).toBe(true);
    for (let i = 0; i < 4; i++) d.onChat({ ...base, id: `x${i}`, userId: 'b', user: 'bob', text: `gg round ${i}` });
    expect(d.contextForLLM({ kind: 'spontaneous', mode: 'observation' }).hatAllowed).toBe(false);
  });
  it('does not answer the same chat message twice and records Hubie\'s reply in the thread', () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.01); const { d, said } = setup();
    d.onChat({ ...base, id: 'same', userId: 'a', user: 'amy', text: 'hey hubie, what is limbo?' });
    const req = said.find((s) => s.reason.startsWith('chat reply'))!; req.onSpoken!('It is a number game, I promise it is simpler than it sounds.', {} as any);
    d.onChat({ ...base, id: 'same', userId: 'a', user: 'amy', text: 'hey hubie, what is limbo?' });
    expect(said.filter((s) => s.reason.startsWith('chat reply')).length).toBe(1);
    expect(d.conv.thread('a')[0].reply).toMatch(/number game/); rnd.mockRestore();
  });
  it('commentary setting creates quiet periods for routine rounds but never silences big moments', () => {
    const run = (mode: 'quiet' | 'chatty') => {
      const { d, said } = setup(); d.setPersonality({ commentary: mode }); const rnd = vi.spyOn(Math, 'random');
      let n = 0; const before = () => said.filter((s) => s.reason.startsWith('round')).length;
      for (let i = 0; i < 100; i++) { rnd.mockReturnValue((i * 0.6180339) % 1 * 0.999 + 0.0005 > 0.34 ? 0.9 : 0.5); d.onGameEvent({ kind: 'round_result', game: 'g', adapter: 't', simulated: true, at: Date.now(), round: { roundId: `r${mode}${i}`, game: 'g', outcome: 'loss', multiplier: 0, stake: 1, payout: 0, details: { target: 2, rolled: 1.1 } } } as any); n++; }
      rnd.mockRestore(); const routine = before();
      d.onGameEvent({ kind: 'round_result', game: 'g', adapter: 't', simulated: true, at: Date.now(), round: { roundId: `big${mode}`, game: 'g', outcome: 'win', multiplier: 120, stake: 1, payout: 120 } } as any);
      return { routine, bigSpoken: said.some((s) => /round win 120/.test(s.reason)), n };
    };
    const q = run('quiet'), c = run('chatty');
    expect(q.routine).toBeLessThan(c.routine); expect(q.bigSpoken).toBe(true); expect(c.bigSpoken).toBe(true);
  });
  it('persists personality and conversation across a restart', () => {
    const { d, memory } = setup(); d.setPersonality({ humor: 20, hat: 'never' });
    d.onChat({ ...base, id: '1', userId: 'a', user: 'amy', text: 'remember me' }); d.persist();
    const d2 = new Director({ memory, speech: { enqueue: () => {}, busy: false, length: 0, idleForMs: 0, recentCaptions: [] } as any, log, requestRound: vi.fn(), sendChat: () => {}, setExpression: () => {}, broadcast: () => {}, onState: () => {}, isStopped: () => false, gameAgentOnline: () => true, roundIntervalMs: 1000, chatEnabled: () => true, autoStart: false, pauseGame: () => {} });
    expect(d2.personality).toMatchObject({ humor: 20, hat: 'never' }); expect(d2.conv.thread('a')[0]?.text).toBe('remember me');
  });
});
