/**
 * Simulated Limbo adapter (default game). The engine (Node, crypto RNG) decides each round; the game page
 * (assets/limbo-sim, rendered in Chromium and streamed to the overlay) animates it. After every reveal the
 * adapter READS THE PAGE BACK and refuses to report a round whose displayed values differ from the engine's —
 * so commentary can only ever be about what viewers actually saw.
 * State (round counter, demo balance, last 50 results) persists in data/limbo-state.json across restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { RoundResult } from '../../shared/src/protocol.ts';
import { launchChromium } from './playwrightAdapter.ts';
import { LimboEngine, sameRound, type LimboRound, type LimboSettings } from './limboEngine.ts';
import { loadLimboSettings, STATE_FILE } from './limboSettings.ts';
import type { AdapterContext, GameAdapter } from './types.ts';

export class LimboSimAdapter implements GameAdapter {
  readonly name = 'limbo-sim';
  readonly game = 'Limbo';
  readonly simulated = true;
  readonly source = 'limbo-sim' as const;
  page?: Page;
  crashed = false;
  onCrash?: (reason: string) => void;
  engine!: LimboEngine;
  settings!: LimboSettings;
  private browser?: Browser;
  private busy = false;

  async start(ctx: AdapterContext) {
    this.crashed = false;
    this.settings = loadLimboSettings();
    this.engine = new LimboEngine(this.settings, undefined, this.loadState());
    this.browser = await launchChromium(ctx);
    this.browser.on('disconnected', () => { if (!this.crashed) { this.crashed = true; this.onCrash?.('browser disconnected'); } });
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    // the simulated game never needs the internet: block everything that isn't our own controller
    const own = new URL(ctx.baseUrl).host;
    await context.route('**/*', (route) => (new URL(route.request().url()).host === own ? route.continue() : route.abort()));
    this.page = await context.newPage();
    this.page.on('crash', () => { this.crashed = true; this.onCrash?.('page crashed'); });
    await this.page.goto(`${ctx.baseUrl}/limbo-sim/index.html?driven=1`, { waitUntil: 'load', timeout: 30_000 });
    await this.page.waitForFunction(() => !!(window as any).limbo && !!(window as any).LimboSim, null, { timeout: 15_000 });
    await this.page.evaluate(([s, st]) => { (window as any).limbo.setSettings(s); (window as any).limbo.setState(st); }, [this.settings, this.publicState()] as const);
    ctx.log('info', `simulated Limbo ready — round ${this.engine.roundNumber}, ${(this.engine.winShare() * 100).toFixed(0)}% simulated win share`);
  }

  /** Re-read settings (Control Center changes) without restarting the browser. */
  async reloadSettings() {
    this.settings = loadLimboSettings();
    this.engine.settings = this.settings;
    await this.page?.evaluate((s) => (window as any).limbo.setSettings(s), this.settings).catch(() => {});
  }

  async setPaused(p: boolean) { await this.page?.evaluate((x) => (window as any).limbo.setPaused(x), p).catch(() => {}); }

  async playRound(): Promise<RoundResult & { bonus?: boolean }> {
    if (!this.page || this.crashed) throw new Error('game page not running');
    if (this.busy) throw new Error('a round is already in progress');
    this.busy = true;
    try {
      const r = this.engine.next();
      const shown = await this.page.evaluate((round) => (window as any).limbo.show(round), r);
      if (!sameRound(r, shown)) throw new Error(`display mismatch — engine ${r.resultMultiplier}x/${r.targetMultiplier}x ${r.outcome}, page ${shown.resultMultiplier}x/${shown.targetMultiplier}x ${shown.outcome}`);
      this.saveState();
      return toRoundResult(r, this.game);
    } finally { this.busy = false; }
  }

  async healthy() { try { return !!this.page && !this.crashed && (await this.page.evaluate(() => !!(window as any).limbo)); } catch { return false; } }
  async stop() { this.saveState(); await this.browser?.close().catch(() => {}); this.browser = undefined; this.page = undefined; }

  private publicState() { return { roundNumber: this.engine.roundNumber, balance: this.engine.balance, history: this.engine.history,
    wins: this.engine.history.filter((h) => h.outcome === 'win').length, losses: this.engine.history.filter((h) => h.outcome === 'loss').length,
    best: Math.max(0, ...this.engine.history.map((h) => h.resultMultiplier)) }; }
  private loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return undefined; } }
  private saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ roundNumber: this.engine.roundNumber, balance: this.engine.balance, history: this.engine.history.slice(-50) }));
      fs.renameSync(tmp, STATE_FILE);
    } catch { /* non-fatal */ }
  }
}

/** Map an engine round onto the shared RoundResult schema (details carry the full limbo event). */
export function toRoundResult(r: LimboRound, game: string): RoundResult {
  return {
    roundId: r.roundId, game, outcome: r.outcome, multiplier: r.outcome === 'win' ? r.payoutMultiplier : 0,
    stake: r.bet, payout: r.payout, balance: r.balanceAfter,
    details: { target: r.targetMultiplier, rolled: r.resultMultiplier, tier: r.tier, roundNumber: r.roundNumber, limbo: r },
  };
}
