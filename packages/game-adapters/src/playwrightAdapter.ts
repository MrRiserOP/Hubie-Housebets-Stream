/**
 * Generic Playwright adapter. A game is described by a GameDriver (selectors +
 * how to read an outcome). The adapter owns the browser lifecycle, crash
 * detection, policy guards (no login, no deposits, no CAPTCHA bypass) and
 * round timeouts.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { RoundResult } from '../../shared/src/protocol.ts';
import { LoginWallError, type AdapterContext, type GameAdapter } from './types.ts';

export interface GameDriver {
  id: string;
  game: string;
  simulated: boolean;
  url: (ctx: AdapterContext) => string;
  /** get into demo mode (e.g. click "Demo"/"Fun play"). Must never log in. */
  enterDemo(page: Page): Promise<void>;
  /** wait until the game is ready for a round */
  waitReady(page: Page): Promise<void>;
  /** optionally choose game parameters for this round (target multiplier etc.) */
  configureRound?(page: Page): Promise<Record<string, unknown>>;
  /** press the permitted demo play control */
  startRound(page: Page): Promise<void>;
  /** wait for and read the outcome */
  readOutcome(page: Page, before: OutcomeSnapshot, cfg: Record<string, unknown>): Promise<RoundResult & { bonus?: boolean }>;
  snapshot(page: Page): Promise<OutcomeSnapshot>;
}

export type OutcomeSnapshot = Record<string, string | number | undefined>;

/** Text that means we hit an auth/CAPTCHA/payment wall. We stop instead of bypassing. */
const BLOCKERS = /(verify you are human|captcha|cloudflare|are you a robot|sign in to continue|log ?in to play|login required|deposit to play|connect wallet to play)/i;

export class PlaywrightAdapter implements GameAdapter {
  name: string; game: string; simulated: boolean;
  page?: Page;
  private browser?: Browser;
  private context?: BrowserContext;
  private ctx?: AdapterContext;
  crashed = false;
  onCrash?: (reason: string) => void;

  constructor(private driver: GameDriver) {
    this.name = driver.id; this.game = driver.game; this.simulated = driver.simulated;
  }

  async start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.crashed = false;
    this.browser = await launchChromium(ctx);
    this.browser.on('disconnected', () => { if (!this.crashed) { this.crashed = true; this.onCrash?.('browser disconnected'); } });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    // Policy guard: block navigation to obvious payment / cashier / login endpoints.
    await this.context.route(/\/(cashier|deposit|wallet|checkout|payment|login|signin|sign-in|register)(\/|\?|$)/i, (route) => {
      ctx.log('warn', `blocked navigation to ${route.request().url()} (policy)`);
      return route.abort();
    });
    this.page = await this.context.newPage();
    this.page.on('crash', () => { this.crashed = true; this.onCrash?.('page crashed'); });
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const url = this.driver.url(ctx);
    if (!url) throw new Error(`${this.driver.id}: no game URL configured`);
    ctx.log('info', `opening ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.assertNoBlocker();
    await this.driver.enterDemo(this.page);
    await this.driver.waitReady(this.page);
  }

  private async assertNoBlocker() {
    if (!this.page) return;
    const text = (await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 20_000);
    if (BLOCKERS.test(text)) throw new LoginWallError(`blocked by access control: "${text.match(BLOCKERS)?.[0]}" — not bypassing`);
  }

  async playRound() {
    if (!this.page || this.crashed) throw new Error('browser not running');
    const page = this.page;
    await this.driver.waitReady(page);
    const cfg = (await this.driver.configureRound?.(page)) ?? {};
    const before = await this.driver.snapshot(page);
    await this.driver.startRound(page);
    const result = await withTimeout(this.driver.readOutcome(page, before, cfg), 30_000, 'round outcome timeout');
    return { ...result, game: this.game };
  }

  async healthy() {
    if (!this.page || this.crashed || !this.browser?.isConnected()) return false;
    try { await withTimeout(this.page.evaluate(() => document.readyState), 3000, 'page unresponsive'); return true; } catch { return false; }
  }

  async stop() {
    this.crashed = true;
    await this.browser?.close().catch(() => {});
    this.browser = undefined; this.page = undefined;
  }
}

/**
 * Launch order: explicit BROWSER_EXECUTABLE_PATH → Playwright's bundled Chromium →
 * installed Google Chrome → Microsoft Edge (always present on Windows 10/11).
 */
export async function launchChromium(ctx: AdapterContext): Promise<Browser> {
  const args = ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--mute-audio'];
  if (ctx.executablePath) return chromium.launch({ headless: ctx.headless, executablePath: ctx.executablePath, args });
  const errors: string[] = [];
  for (const channel of [undefined, 'chrome', 'msedge'] as const) {
    try { return await chromium.launch({ headless: ctx.headless, channel, args }); }
    catch (e) { errors.push(`${channel ?? 'bundled'}: ${(e as Error).message.split('\n')[0]}`); }
  }
  throw new Error(`No usable browser found. Install Google Chrome, or run "npx playwright install chromium". (${errors.join(' | ')})`);
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function parseMultiplier(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*[x×]/i);
  return m ? Number(m[1]) : undefined;
}
