/**
 * Simulated Limbo — local random outcome engine (ENTERTAINMENT ONLY).
 *
 * Runs in Node (game agent) and in the browser (the standalone game page). No network, no Housebets servers.
 *
 * How one round is generated (all draws use a cryptographic RNG, never a stored sequence):
 *   1. Pick an outcome tier by its configured weight  (small win, medium win, large win, huge win, loss).
 *   2. Pick the target multiplier: in "auto" mode from that tier's target list; in "fixed" mode the fixed target.
 *   3. Draw the result multiplier from a Limbo-shaped curve (P(result ≥ x) ∝ 1/x), restricted to
 *      ≥ target for a win tier or < target for a loss tier.
 *   4. Compare result with target (the comparison decides win/loss — it is not copied from the tier).
 *   5. Payout = bet × target on a win (Limbo rules, as shown under "Payout on Win" BEFORE the round), 0 on a loss.
 * The result is never altered after step 3. Weights are not Housebets' odds/RTP and are not provably fair.
 */

export interface OutcomeTier { id: string; label: string; weight: number; win: boolean; targets: number[] }
export interface LimboSettings {
  label: string;
  roundDelaySec: number;
  currency: string;
  startingCredits: number;
  betAmount: number;
  targetMode: 'auto' | 'fixed';
  fixedTarget: number;
  resultCap: number;
  outcomes: OutcomeTier[];
}

export interface LimboRound {
  type: 'limbo_round_complete';
  roundId: string;
  roundNumber: number;
  tier: string;
  targetMultiplier: number;
  resultMultiplier: number;
  outcome: 'win' | 'loss';
  payoutMultiplier: number;   // = target on a win, 0 on a loss
  bet: number;
  payout: number;             // bet × payoutMultiplier
  profit: number;             // payout − bet
  balanceAfter: number;
  simulated: true;
  at: number;
}

export type Rng = () => number; // uniform in [0, 1)

/** Cryptographic uniform [0,1) with 53 bits of precision. */
export const cryptoRng: Rng = () => {
  const a = new Uint32Array(2);
  globalThis.crypto.getRandomValues(a);
  return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53;
};

const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function validateSettings(s: LimboSettings): string[] {
  const errs: string[] = [];
  if (!Array.isArray(s.outcomes) || !s.outcomes.length) errs.push('at least one outcome tier is required');
  const total = (s.outcomes ?? []).reduce((a, o) => a + (o.weight > 0 ? o.weight : 0), 0);
  if (total <= 0) errs.push('weights must add up to more than 0');
  if (!(s.outcomes ?? []).some((o) => !o.win && o.weight > 0)) errs.push('keep some losses (a loss tier with weight > 0) for suspense');
  for (const o of s.outcomes ?? []) {
    if (!(o.weight >= 0)) errs.push(`${o.id}: weight must be ≥ 0`);
    if (!o.targets?.length) errs.push(`${o.id}: needs at least one target`);
    for (const t of o.targets ?? []) if (!(t >= 1.01 && t <= 1000)) errs.push(`${o.id}: target ${t} must be between 1.01x and 1000x`);
  }
  if (!(s.fixedTarget >= 1.01 && s.fixedTarget <= 1000)) errs.push('fixed target must be between 1.01x and 1000x');
  if (!(s.betAmount > 0)) errs.push('bet amount must be > 0');
  if (!(s.roundDelaySec >= 2 && s.roundDelaySec <= 120)) errs.push('round delay must be 2–120 s');
  if (!(s.resultCap >= 100)) errs.push('result cap must be ≥ 100');
  return errs;
}

export function pickTier(tiers: OutcomeTier[], rng: Rng, onlyWin?: boolean): OutcomeTier {
  const pool = tiers.filter((t) => t.weight > 0 && (onlyWin === undefined || t.win === onlyWin));
  const total = pool.reduce((a, t) => a + t.weight, 0);
  let x = rng() * total;
  for (const t of pool) { if ((x -= t.weight) < 0) return t; }
  return pool[pool.length - 1];
}

/** Result multiplier ≥ target (win) or in [1.00, target) (loss), Limbo-shaped. */
export function drawResult(target: number, win: boolean, cap: number, rng: Rng): number {
  if (win) {
    const u = 1 - rng(); // (0, 1]
    return Math.min(cap, Math.max(target, floor2(target / u)));
  }
  // loss: P(R ≥ x) = 1/x restricted to [1, target)
  const v = rng();
  const r = 1 / (1 - v * (1 - 1 / target));
  return Math.min(floor2(r), round2(target - 0.01));
}

export class LimboEngine {
  roundNumber: number;
  balance: number;
  history: LimboRound[] = [];
  constructor(public settings: LimboSettings, private rng: Rng = cryptoRng, state?: { roundNumber?: number; balance?: number; history?: LimboRound[] }) {
    this.roundNumber = state?.roundNumber ?? 0;
    this.balance = state?.balance ?? settings.startingCredits;
    this.history = (state?.history ?? []).slice(-50);
  }

  /** The win chance implied by the current weights (shown in the UI instead of real odds). */
  winShare(): number {
    const pos = this.settings.outcomes.filter((o) => o.weight > 0);
    const total = pos.reduce((a, o) => a + o.weight, 0);
    return total ? pos.filter((o) => o.win).reduce((a, o) => a + o.weight, 0) / total : 0;
  }

  /** Chance this game gives a win when Hubie picks this target (from the configured weights). */
  winChanceFor(target: number): number {
    if (this.settings.targetMode === 'fixed') return this.winShare();
    let win = 0, all = 0;
    for (const o of this.settings.outcomes) {
      if (!(o.weight > 0) || !o.targets.some((t) => Math.abs(t - target) < 0.005)) continue;
      const share = o.weight / o.targets.length;
      all += share; if (o.win) win += share;
    }
    return all ? win / all : this.winShare();
  }

  next(): LimboRound {
    const s = this.settings;
    let tier: OutcomeTier;
    let target: number;
    if (s.targetMode === 'fixed') {
      // fixed target: decide win vs loss by the weights' win share, then the result
      const win = this.rng() < this.winShare();
      tier = pickTier(s.outcomes, this.rng, win);
      target = round2(s.fixedTarget);
    } else {
      tier = pickTier(s.outcomes, this.rng);
      target = round2(tier.targets[Math.floor(this.rng() * tier.targets.length)]);
    }
    const result = drawResult(target, tier.win, s.resultCap, this.rng);
    // the comparison decides the outcome
    const outcome: 'win' | 'loss' = result >= target ? 'win' : 'loss';
    const bet = Math.min(s.betAmount, Math.max(0, this.balance)) || s.betAmount; // demo credits never block play
    const payoutMultiplier = outcome === 'win' ? target : 0;
    const payout = round2(bet * payoutMultiplier);
    const profit = round2(payout - bet);
    this.balance = round2(this.balance + profit);
    if (this.balance < bet) this.balance = s.startingCredits; // virtual credits refill — demo only
    this.roundNumber++;
    const r: LimboRound = {
      type: 'limbo_round_complete', roundId: `limbo-${Date.now().toString(36)}-${this.roundNumber}`, roundNumber: this.roundNumber,
      tier: tier.id, targetMultiplier: target, resultMultiplier: result, outcome, payoutMultiplier, bet, payout, profit,
      balanceAfter: this.balance, simulated: true, at: Date.now(),
    };
    this.history = [...this.history.slice(-49), r];
    return r;
  }
}

/** Display-side consistency check (the page and the engine must agree). */
export function sameRound(a: Pick<LimboRound, 'targetMultiplier' | 'resultMultiplier' | 'outcome' | 'payoutMultiplier'>, b: typeof a): boolean {
  return Math.abs(a.targetMultiplier - b.targetMultiplier) < 0.005 && Math.abs(a.resultMultiplier - b.resultMultiplier) < 0.005
    && a.outcome === b.outcome && Math.abs(a.payoutMultiplier - b.payoutMultiplier) < 0.005;
}
