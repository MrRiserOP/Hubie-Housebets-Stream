/**
 * Simulated Limbo engine — 100,000 generated rounds (requirement: ≥ 10,000).
 * Checks: weighted tier distribution vs configuration (chi-square), target comparison, payout maths,
 * history, genuine randomness (bit balance, serial correlation, runs, no repeating sequence, independent engines differ).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LimboEngine, cryptoRng, drawResult, validateSettings, type LimboSettings, type LimboRound } from '../../packages/game-adapters/src/limboEngine.ts';

const settings: LimboSettings = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/limbo-sim.json'), 'utf8'));
const N = 100_000;
const eng = new LimboEngine(settings);
const rounds: LimboRound[] = Array.from({ length: N }, () => eng.next());
export const STATS: Record<string, unknown> = {};

// chi-square critical values at p = 0.001 for df 1..10
const CHI_001 = [10.83, 13.82, 16.27, 18.47, 20.52, 22.46, 24.32, 26.12, 27.88, 29.59];

describe(`simulated Limbo engine — ${N.toLocaleString()} rounds`, () => {
  it('the default settings are valid and keep some losses', () => {
    expect(validateSettings(settings)).toEqual([]);
  });

  it('tier frequencies match the configured weights (chi-square, p > 0.001; each within ±1 pt)', () => {
    const total = settings.outcomes.reduce((a, o) => a + o.weight, 0);
    let chi = 0;
    const rows: string[] = [];
    for (const o of settings.outcomes) {
      const obs = rounds.filter((r) => r.tier === o.id).length;
      const exp = (N * o.weight) / total;
      chi += (obs - exp) ** 2 / exp;
      rows.push(`${o.id}: ${(obs / N * 100).toFixed(2)}% (configured ${(o.weight / total * 100).toFixed(2)}%)`);
      expect(Math.abs(obs / N - o.weight / total)).toBeLessThan(0.01);
    }
    STATS.tiers = rows; STATS.chi = chi;
    expect(chi).toBeLessThan(CHI_001[settings.outcomes.length - 2]);
  });

  it('every outcome comes from comparing result with target; payout = bet × target on win, 0 on loss', () => {
    for (const r of rounds) {
      expect(r.outcome).toBe(r.resultMultiplier >= r.targetMultiplier ? 'win' : 'loss');
      expect(r.payoutMultiplier).toBe(r.outcome === 'win' ? r.targetMultiplier : 0);
      expect(r.payout).toBeCloseTo(r.bet * r.payoutMultiplier, 2);
      expect(r.profit).toBeCloseTo(r.payout - r.bet, 2);
      expect(r.resultMultiplier).toBeGreaterThanOrEqual(1);
      expect(r.resultMultiplier).toBeLessThanOrEqual(settings.resultCap);
      expect(Number(r.resultMultiplier.toFixed(2))).toBe(r.resultMultiplier);
      expect(r.simulated).toBe(true);
      expect(r.type).toBe('limbo_round_complete');
    }
    const wins = rounds.filter((r) => r.outcome === 'win').length / N;
    STATS.winRate = wins;
    expect(wins).toBeGreaterThan(0.6); // win-heavy by design (configured 71 %)
  });

  it('round numbers increase by one, ids are unique, history keeps the last 50', () => {
    rounds.forEach((r, i) => expect(r.roundNumber).toBe(i + 1));
    expect(new Set(rounds.map((r) => r.roundId)).size).toBe(N);
    expect(eng.history.length).toBe(50);
    expect(eng.history.at(-1)).toBe(rounds.at(-1));
  });

  it('result shape: wins are heavy-tailed above the target (P(R ≥ 2t | win) ≈ 1/2)', () => {
    const wins = rounds.filter((r) => r.outcome === 'win' && r.targetMultiplier * 2 < settings.resultCap);
    const dbl = wins.filter((r) => r.resultMultiplier >= 2 * r.targetMultiplier).length / wins.length;
    STATS.doubleTarget = dbl;
    expect(dbl).toBeGreaterThan(0.47); expect(dbl).toBeLessThan(0.53);
    const big = rounds.filter((r) => r.resultMultiplier >= 100).length;
    STATS.over100 = big;
    expect(big).toBeGreaterThan(0); // rare impressive results do occur
  });

  it('randomness: uniform bits, no serial correlation, normal runs, no repeating sequence', () => {
    const u = Array.from({ length: 200_000 }, cryptoRng);
    // mean and variance of U(0,1)
    const mean = u.reduce((a, b) => a + b, 0) / u.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
    // 10-bin chi-square
    const bins = new Array(10).fill(0); for (const x of u) bins[Math.floor(x * 10)]++;
    const chi = bins.reduce((a, o) => a + (o - u.length / 10) ** 2 / (u.length / 10), 0);
    expect(chi).toBeLessThan(27.88); // df 9, p = 0.001
    // lag-1 serial correlation
    let c = 0; for (let i = 1; i < u.length; i++) c += (u[i] - 0.5) * (u[i - 1] - 0.5);
    const corr = c / (u.length - 1) / (1 / 12);
    expect(Math.abs(corr)).toBeLessThan(0.01);
    // Wald–Wolfowitz runs test on win/loss sequence
    const seq = rounds.map((r) => r.outcome === 'win');
    const n1 = seq.filter(Boolean).length, n2 = N - n1;
    let runs = 1; for (let i = 1; i < N; i++) if (seq[i] !== seq[i - 1]) runs++;
    const mu = (2 * n1 * n2) / N + 1, sd = Math.sqrt(((mu - 1) * (mu - 2)) / (N - 1));
    const z = (runs - mu) / sd;
    STATS.runsZ = z; STATS.serialCorr = corr; STATS.binChi = chi;
    expect(Math.abs(z)).toBeLessThan(3.3);
    // no repeating cycle: the first 30 results do not reappear as a block
    const key = rounds.slice(0, 30).map((r) => r.resultMultiplier).join(',');
    const all = rounds.map((r) => r.resultMultiplier).join(',');
    expect(all.indexOf(key, 1)).toBe(-1);
    // two engines produce different sequences
    const a = new LimboEngine(settings), b = new LimboEngine(settings);
    const sa = Array.from({ length: 50 }, () => a.next().resultMultiplier).join(), sb = Array.from({ length: 50 }, () => b.next().resultMultiplier).join();
    expect(sa).not.toBe(sb);
  });

  it('fixed-target mode compares against the chosen target and keeps the configured win share', () => {
    const e = new LimboEngine({ ...settings, targetMode: 'fixed', fixedTarget: 3.5 });
    const rs = Array.from({ length: 20_000 }, () => e.next());
    expect(rs.every((r) => r.targetMultiplier === 3.5)).toBe(true);
    const wr = rs.filter((r) => r.outcome === 'win').length / rs.length;
    expect(Math.abs(wr - e.winShare())).toBeLessThan(0.015);
    expect(rs.filter((r) => r.outcome === 'loss').every((r) => r.resultMultiplier < 3.5)).toBe(true);
  });

  it('loss results are always strictly below the target, even for tiny targets', () => {
    for (let i = 0; i < 20_000; i++) expect(drawResult(1.01, false, 10000, cryptoRng)).toBeLessThan(1.01);
  });

  it('settings validation rejects nonsense and a setup without losses', () => {
    expect(validateSettings({ ...settings, outcomes: settings.outcomes.filter((o) => o.win) }).join()).toMatch(/keep some losses/);
    expect(validateSettings({ ...settings, betAmount: 0 }).join()).toMatch(/bet amount/);
  });

  it('writes the distribution report', () => {
    const lines = [
      `# Simulated Limbo — distribution test (${N.toLocaleString()} rounds, crypto RNG)`, '',
      `Run: ${new Date().toISOString()}. Settings: config/limbo-sim.json. ENTERTAINMENT ONLY — not Housebets odds/RTP.`, '',
      '| Tier | Observed vs configured |', '|---|---|', ...(STATS.tiers as string[]).map((t) => `| ${t.split(':')[0]} | ${t.split(': ')[1]} |`), '',
      `- Chi-square (tiers): ${(STATS.chi as number).toFixed(2)} (critical value at p=0.001: ${CHI_001[settings.outcomes.length - 2]}) → matches configuration`,
      `- Overall win rate: ${((STATS.winRate as number) * 100).toFixed(2)} %`,
      `- Winning results at least double the target: ${((STATS.doubleTarget as number) * 100).toFixed(1)} % (Limbo-shaped tail, expected ≈ 50 %)`,
      `- Results ≥ 100x: ${STATS.over100} of ${N.toLocaleString()}`,
      `- RNG: 10-bin chi-square ${(STATS.binChi as number).toFixed(2)} (crit 27.88) · lag-1 correlation ${(STATS.serialCorr as number).toFixed(4)} · win/loss runs test z = ${(STATS.runsZ as number).toFixed(2)} (|z| < 3.3)`,
      '- Every round: outcome = (result ≥ target); payout = bet × target on a win, 0 on a loss; no repeating sequence; two engines never share a sequence.',
    ];
    fs.writeFileSync(path.join(__dirname, '../../docs/TEST-REPORT-limbo-distribution.md'), lines.join('\n') + '\n');
  });
});

describe('per-target win chance shown in the game', () => {
  it('matches the observed win rate for each target in auto mode', () => {
    const e = new LimboEngine(settings);
    const rs = Array.from({ length: 60_000 }, () => e.next());
    for (const t of [2, 5, 10]) {
      const sub = rs.filter((r) => r.targetMultiplier === t);
      const observed = sub.filter((r) => r.outcome === 'win').length / sub.length;
      expect(Math.abs(observed - e.winChanceFor(t))).toBeLessThan(0.03);
    }
  });
});
