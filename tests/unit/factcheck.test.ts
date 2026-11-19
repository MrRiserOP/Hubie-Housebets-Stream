import { describe, it, expect } from 'vitest';
import { checkRoundLine, factualLine } from '../../services/ai/src/factcheck.ts';

const base = { kind: 'round' as const, game: "Hubie's Limbo (simulated)", simulated: true, lossStreak: 0, winStreak: 1, roundsPlayed: 12, brief: false, tier: 'small' as const, nearMiss: false, stake: 10 };
const win = { ...base, outcome: 'win' as const, target: 2, rolled: 3.45, multiplier: 2, payout: 20 };
const loss = { ...base, outcome: 'loss' as const, target: 5, rolled: 1.87, multiplier: 0, payout: 0, winStreak: 0, lossStreak: 2 };

describe('commentary fact check (commentary can never announce a different result)', () => {
  it('accepts lines that use the real numbers', () => {
    expect(checkRoundLine('3.45x against a 2x target. Paid 2x, I will take it.', win).ok).toBe(true);
    expect(checkRoundLine('Stopped at 1.87x, we needed 5x. Two losses in a row.', loss).ok).toBe(true);
    expect(checkRoundLine('3.45 times! The target was only 2 times.', win).ok).toBe(true);
  });
  it('rejects invented or wrong numbers', () => {
    expect(checkRoundLine('That paid 3.45x!', { ...win, rolled: 3.4 }).ok).toBe(false);
    expect(checkRoundLine('A huge 12x win!', win).ok).toBe(false);
    expect(checkRoundLine('It landed at 1.9 so close!', loss).ok).toBe(false);
  });
  it('rejects a win claimed on a loss and a loss claimed on a win', () => {
    expect(checkRoundLine("That's a win, chat!", loss).ok).toBe(false);
    expect(checkRoundLine('We lost that one.', win).ok).toBe(false);
  });
  it('the fallback factual line is itself correct', () => {
    for (let i = 0; i < 50; i++) { expect(checkRoundLine(factualLine(win).text, win).ok).toBe(true); expect(checkRoundLine(factualLine(loss).text, loss).ok).toBe(true); }
    const big = { ...win, target: 25, rolled: 61.2, multiplier: 25 };
    expect(checkRoundLine(factualLine(big).text, big).ok).toBe(true);
  });
});
