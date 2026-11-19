import { describe, expect, it } from 'vitest';
import { judgeVariety, isBareFiller, similarity } from '../../services/ai/src/variety.ts';
import { mockGenerate } from '../../services/ai/src/mockBank.ts';
import type { LLMContext, Situation } from '../../services/ai/src/types.ts';

describe('repetition prevention', () => {
  it('rejects bare fillers', () => {
    for (const f of ['Nope.', 'Oh no!', 'Interesting.', "Let's go!", 'ouch']) expect(isBareFiller(f), f).toBe(true);
    expect(isBareFiller('Nope, that 1.9x was a crime against sloths.')).toBe(false);
  });
  it('rejects near-duplicates and reused openers, accepts fresh lines', () => {
    const recent = ['That multiplier walked into the room like it owns the place.', 'Chat, the hat has seen things tonight.'];
    expect(judgeVariety('That multiplier walked in like it owns the place!', recent).ok).toBe(false);
    expect(judgeVariety('Chat, the hat is exhausted now.', recent).ok).toBe(false);
    expect(judgeVariety('Seven rounds in and my bow tie is still straight. Small victories.', recent).ok).toBe(true);
    expect(similarity('a b c d e', 'a b c d e')).toBe(1);
  });
  it('demo brain stays varied over 300 rounds (≥90% unique, no bare fillers)', () => {
    const recent: string[] = [];
    const spoken: string[] = [];
    let streak = 0;
    for (let i = 0; i < 300; i++) {
      const win = Math.random() < 0.4;
      streak = win ? 0 : streak + 1;
      const target = [1.5, 2, 2, 2.5, 3, 5, 10, 25][i % 8]; // same target mix as the game agent
      const rolled = win ? target + Math.random() * 3 : Math.round((1 + Math.random() * (target - 1)) * 100) / 100;
      const sit: Situation = { kind: 'round', game: 'Limbo', simulated: true, outcome: win ? 'win' : 'loss', multiplier: win ? target : 0, target, rolled, tier: win ? (target >= 10 ? 'big' : target >= 3 ? 'medium' : 'small') : 'tiny', nearMiss: !win && rolled >= target * 0.9, lossStreak: streak, winStreak: win ? 1 : 0, roundsPlayed: i + 1, brief: i % 3 !== 0 };
      const ctx: LLMContext = { recentLines: recent.slice(-100), recentChat: [], showState: { segment: 'gameplay', rounds: i, wins: 0, losses: 0, bestMultiplier: 0, game: 'Limbo' } };
      const line = mockGenerate(sit, ctx).text;
      spoken.push(line); recent.push(line);
      expect(isBareFiller(line), line).toBe(false);
    }
    const unique = new Set(spoken).size / spoken.length;
    expect(unique).toBeGreaterThanOrEqual(0.9);
  });
});
