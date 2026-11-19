/**
 * Simulated Limbo-style game (no browser). Used for development and as an
 * explicit, labelled fallback. Every event it emits carries simulated=true and
 * the overlay shows a "SIMULATED TEST GAME" ribbon.
 */
import crypto from 'node:crypto';
import type { RoundResult } from '../../shared/src/protocol.ts';
import type { AdapterContext, GameAdapter } from './types.ts';

const TARGETS = [1.5, 2, 2, 3, 5, 10, 25, 100];

/** Limbo crash point with 1% house edge: P(result >= x) = 0.99 / x */
export function limboResult(u = crypto.randomInt(1, 2 ** 31) / 2 ** 31): number {
  return Math.max(1, Math.floor((0.99 / u) * 100) / 100);
}

export class SimulatedAdapter implements GameAdapter {
  name = 'simulated';
  game = "Hubie's Limbo (simulated)";
  simulated = true;
  private balance = 1000;
  private last: (RoundResult & { bonus?: boolean }) | null = null;
  private n = 0;

  async start(_ctx: AdapterContext) { /* nothing to launch */ }

  async playRound() {
    await new Promise((r) => setTimeout(r, 1200)); // "animation"
    const target = TARGETS[crypto.randomInt(0, TARGETS.length)];
    const rolled = limboResult();
    const stake = 1;
    const win = rolled >= target;
    this.balance += win ? stake * target - stake : -stake;
    this.n++;
    this.last = {
      roundId: `sim-${Date.now()}-${this.n}`, game: this.game, stake, payout: win ? stake * target : 0,
      multiplier: win ? target : 0, outcome: win ? 'win' : 'loss', balance: Math.round(this.balance * 100) / 100,
      details: { target, rolled }, bonus: rolled >= 50,
    };
    return this.last;
  }

  async healthy() { return true; }
  async stop() { /* nothing */ }

  renderFrame() {
    const r = this.last;
    const rolled = (r?.details?.rolled as number | undefined) ?? 0;
    const target = (r?.details?.target as number | undefined) ?? 0;
    const color = !r ? '#8fb3b0' : r.outcome === 'win' ? '#7ee0a3' : '#ff8a8a';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1216" height="684" viewBox="0 0 1216 684">
<rect width="1216" height="684" fill="#04232a"/><text x="608" y="90" fill="#f0b549" font-family="sans-serif" font-size="40" text-anchor="middle" font-weight="700">Hubie's Limbo — SIMULATED</text>
<text x="608" y="330" fill="${color}" font-family="sans-serif" font-size="180" text-anchor="middle" font-weight="800">${r ? rolled.toFixed(2) + '×' : '—'}</text>
<text x="608" y="430" fill="#cfe3e0" font-family="sans-serif" font-size="40" text-anchor="middle">Target ${target ? target + '×' : '—'} · ${r ? r.outcome.toUpperCase() : 'ready'}</text>
<text x="608" y="600" fill="#8fb3b0" font-family="sans-serif" font-size="28" text-anchor="middle">Play-money balance ${this.balance.toFixed(2)} · not a real Housebets game</text></svg>`;
    return { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
  }
}
