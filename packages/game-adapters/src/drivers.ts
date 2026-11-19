/**
 * Game drivers.
 *
 *  local-demo — assets/demo-game (served by the controller): a minimal developer test page that
 *               exercises the generic Playwright pipeline. Labelled LOCAL TEST GAME.
 *  The stream's game is the simulated Limbo (limboSim.ts), not a driver.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { parseMultiplier, type GameDriver, type OutcomeSnapshot } from './playwrightAdapter.ts';

const TARGETS = [1.5, 2, 2, 2.5, 3, 5, 10, 25];
const pickTarget = () => TARGETS[crypto.randomInt(0, TARGETS.length)];

/* ---------------- local demo game ---------------- */
export const localDemoDriver: GameDriver = {
  id: 'local-demo', game: "Hubie's Limbo (local test game)", simulated: true,
  url: (ctx) => `${ctx.baseUrl}/demo-game/index.html`,
  async enterDemo(page) {
    const demo = page.getByRole('button', { name: /demo|fun mode|fun play|practice/i });
    if (await demo.count()) await demo.first().click();
  },
  async waitReady(page) {
    await page.getByRole('button', { name: 'Play round' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => document.body.dataset.state !== 'rolling', null, { timeout: 15_000 });
  },
  async configureRound(page) {
    const target = pickTarget();
    await page.getByLabel('Target multiplier').fill(String(target));
    return { target };
  },
  async startRound(page) { await page.getByRole('button', { name: 'Play round' }).click(); },
  async snapshot(page) { return { round: Number(await page.getByTestId('result').getAttribute('data-round')) }; },
  async readOutcome(page, before) {
    const res = page.getByTestId('result');
    await page.waitForFunction((r) => Number(document.querySelector('[data-testid=result]')?.getAttribute('data-round')) > (r as number), before.round, { timeout: 20_000 });
    const a = async (k: string) => (await res.getAttribute(`data-${k}`)) ?? '';
    const outcome = (await a('outcome')) === 'win' ? 'win' as const : 'loss' as const;
    const target = Number(await a('target')), rolled = Number(await a('rolled'));
    const balanceText = await page.getByTestId('balance').innerText();
    const state = await page.evaluate(() => document.body.dataset.state);
    return {
      roundId: `local-${Date.now()}-${await a('round')}`, game: '', outcome, multiplier: outcome === 'win' ? target : 0,
      stake: Number(await a('stake')), payout: Number(await a('payout')), balance: Number(balanceText),
      details: { target, rolled }, bonus: state === 'bonus',
    };
  },
};

export const DRIVERS: Record<string, () => GameDriver> = {
  'local-demo': () => localDemoDriver,
};
