/**
 * Round-commentary fact check: Hubie may never announce a different result than the game engine produced.
 *  - every multiplier-like number in the line ("3.45x", "3.45 times", "3.45") must be one of the round's real values
 *    (target, result, payout multiplier — of this round or the grouped previous round) or a known session stat;
 *  - the line must not claim a win on a loss or a loss on a win.
 * Failing lines are regenerated once with the exact numbers, then replaced by a factual template line.
 */
import type { LineOut, Situation, RoundInfo } from './types.ts';

type RoundSit = Extract<Situation, { kind: 'round' }>;

export interface FactCheck { ok: boolean; reason?: string }

const near = (a: number, b: number) => Math.abs(a - b) < 0.011 || (b >= 100 && Math.abs(a - b) / b < 0.005);

function multValues(s: RoundSit, best?: number): number[] {
  const vals: number[] = [];
  const add = (r: Partial<RoundInfo> | undefined) => { if (!r) return; for (const v of [r.target, r.rolled, r.multiplier]) if (typeof v === 'number' && v > 0) vals.push(v); };
  add(s); add(s.previous);
  if (best) vals.push(best);
  return vals;
}

/** extra = [wins, losses, rounds, bestMultiplier] from the show state */
export function checkRoundLine(text: string, s: RoundSit, extra: number[] = []): FactCheck {
  const mult = multValues(s, extra[3]);
  const amounts = [s.stake, s.payout].filter((v): v is number => typeof v === 'number');
  // multiplier context: "3.45x", "3.45 ×", "12 times" → must be a real multiplier of this (or the grouped) round
  const seen = new Set<string>();
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s?(?:x(?![a-z])|×|times\b)/gi)) {
    const n = Number(m[1].replace(',', '.'));
    seen.add(m[1]);
    if (!mult.some((a) => near(n, a))) return { ok: false, reason: `says ${n}x, which is not a multiplier from this round` };
  }
  // any other decimal number must be one of the round's numbers or credit amounts
  for (const m of text.matchAll(/\b\d+\.\d+\b/g)) {
    if (seen.has(m[0])) continue;
    const n = Number(m[0]);
    if (![...mult, ...amounts].some((a) => near(n, a))) return { ok: false, reason: `mentions ${n}, which is not a value from this round` };
  }
  const t = text.toLowerCase();
  const prevOutcome = s.previous?.outcome;
  if (s.outcome === 'loss' && prevOutcome !== 'win' && /\b(we|i|you|hubie) (just )?won\b|\bthat'?s a win\b|\b(big|nice|huge) win\b|\bpaid (out )?\d/.test(t)) return { ok: false, reason: 'claims a win on a loss' };
  if (s.outcome === 'win' && prevOutcome !== 'loss' && /\bthat'?s a loss\b|\bwe lost\b|\bno win\b|\bmissed (it|the target)\b/.test(t)) return { ok: false, reason: 'claims a loss on a win' };
  return { ok: true };
}

const fmt = (n: number | undefined) => (n === undefined ? '?' : Number(n.toFixed(2)).toString());
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** Last-resort factual line (only used if the AI twice gets the numbers wrong). */
export function factualLine(s: RoundSit): LineOut {
  const r = fmt(s.rolled), t = fmt(s.target), p = fmt(s.multiplier);
  if (s.outcome === 'win') {
    const big = (s.multiplier ?? 0) >= 10;
    return {
      text: big
        ? pick([`${r}x against a ${t}x target. That pays ${p}x, chat. The sloth is cooking today!`, `Excuse me? ${r}x on the board, target ${t}x, and that's a ${p}x payout. Someone check the cameras.`])
        : pick([`${r}x beats the ${t}x target. A ${p}x win, I'll take it.`, `Target ${t}x, result ${r}x. That's a win at ${p}x, sloth speed but it counts.`]),
      expression: big ? 'celebrating' : 'happy', tone: big ? 'hyped' as LineOut['tone'] : 'playful', combo: big ? 'big_win' : 'nod',
    };
  }
  return {
    text: pick([`${r}x, and we needed ${t}x. No win this time, let's pretend that never happened.`, `The result stopped at ${r}x, short of the ${t}x target. Zero return, onward.`]),
    expression: 'disappointed', tone: 'disappointed' as LineOut['tone'], combo: 'bad_result',
  };
}
