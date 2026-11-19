/**
 * Captures the README screenshots from the RUNNING app (real controller, real overlay, real Chrome, real Claude brain).
 * ElevenLabs is a stand-in server here (the build machine cannot reach the real one); Kick/OBS are left unconfigured,
 * exactly as on a fresh install. Run:  BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome npx tsx scripts/capture-readme-screenshots.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { ROOT } from '../packages/shared/src/node.ts';
import { startFakeElevenLabs } from '../tests/fakes/fakeElevenLabs.ts';
import { BASE, TMP, api, baseEnv, health, startProc, stopAll, waitFor } from '../tests/e2e/harness.ts';

const real = dotenv.parse(fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env')) : '');
const OUT = path.join(ROOT, 'docs', 'screenshots', 'readme'); fs.mkdirSync(OUT, { recursive: true });
const el = await startFakeElevenLabs();
const env = baseEnv({
  AUTO_START: 'true', ROUND_INTERVAL_SEC: '5', ANTHROPIC_API_KEY: real.ANTHROPIC_API_KEY ?? '', ANTHROPIC_MODEL: 'claude-haiku-5-5',
  TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'sk_good_primary_0123456789abcdef', ELEVENLABS_BASE_URL: el.url, ELEVENLABS_VOICE_ID: 'IKne3meq5aSn9XLyUdCD',
});
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller', () => health().then((h) => h.ok), 30_000);
startProc('game-agent', 'apps/game-agent/src/main.ts', env);
await api('/api/voice/keys/add', { name: 'Backup key', key: 'sk_good_backup_0123456789abcdefg' });
await api('/api/audio', { musicEnabled: true, musicVolume: 35 });

const b = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const ov = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await ov.goto(`${BASE}/overlay`);
const cc = await b.newPage({ viewport: { width: 1440, height: 900 } });
await cc.goto(`${BASE}/setup`); await cc.getByText('HUBIE CONTROL CENTER').waitFor();
const nav = (id: string) => cc.locator('.wiz-steps li', { hasText: new RegExp(`^${id}(?!\\d)`) }).click();
const shot = async (page: typeof cc, name: string, opts: { full?: boolean; clip?: number } = {}) => {
  await page.waitForTimeout(900); const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: !!opts.full, ...(opts.clip ? { clip: { x: 0, y: 0, width: 1440, height: opts.clip } } : {}) }); console.log('captured', name);
};

// let the show run: a few real rounds, with live Claude commentary and music
await waitFor('rounds', async () => ((await health()).stats?.rounds ?? 0) >= 4, 150_000);
await ov.waitForTimeout(6000);
await ov.screenshot({ path: path.join(OUT, 'overlay-live.png') }); console.log('captured overlay-live');
await waitFor('next round', async () => ((await health()).stats?.rounds ?? 0) >= 7, 90_000).catch(() => {});
await ov.screenshot({ path: path.join(OUT, 'overlay-live-2.png') });

for (const [id, name] of [['1', 'cc-1-ai'], ['2', 'cc-2-voice'], ['3', 'cc-3-game'], ['4', 'cc-4-kick-chat'], ['6', 'cc-6-obs'], ['9', 'cc-9-health'], ['12', 'cc-12-personality'], ['13', 'cc-13-audio'], ['14', 'cc-14-avatar'], ['16', 'cc-16-monitoring']] as const) {
  await nav(id); await shot(cc, name, id === '13' ? { clip: 900 } : {});
}
await b.close(); stopAll(); await el.close?.(); process.exit(0);
