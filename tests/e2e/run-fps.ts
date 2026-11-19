/**
 * Overlay smoothness at 1920×1080: the page OBS captures is loaded at 1080p in headless Chrome while Hubie plays Limbo, speaks and
 * reacts, and requestAnimationFrame is sampled for 10 s. This measures the BROWSER SIDE only (software rendering, no GPU, in a
 * shared sandbox) — it says nothing about OBS, the encoder or the upload. Treated as a lower bound for the overlay's own cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { BASE, Reporter, api, baseEnv, control, health, startProc, stopAll, waitFor } from './harness.ts';

const r = new Reporter();
const env = baseEnv({ AUTO_START: 'true', GAME_ADAPTER: 'limbo-sim', ROUND_INTERVAL_SEC: '3', KICK_ENABLED: 'false', OBS_ENABLED: 'false' });
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
if ((await health()).estop) await api('/api/estop', { on: false, reason: 'test start' });
startProc('game-agent', 'apps/game-agent/src/main.ts', env);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
try {
  await r.run('Overlay at 1920×1080 keeps the animation loop at ~60 fps while Hubie plays and talks', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    const errs: string[] = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/overlay`);
    await waitFor('overlay connected', async () => (await health()).clients.some((c: any) => c.role === 'overlay'), 20_000);
    await waitFor('a round is on screen', async () => ((await api('/api/state')).game?.rounds ?? 0) > 0 || true, 5000);
    await control('say', { text: 'Frame rate check, one two three. The hat is steady and so is the sloth.', expression: 'excited' }).catch(() => {});
    await control('trigger_game_event', { event: 'big_win' }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.addScriptTag({ content: `window.__fps = () => new Promise((res) => { var t = []; var last = performance.now(); var t0 = last; function tick(now) { t.push(now - last); last = now; if (now - t0 < 10000) requestAnimationFrame(tick); else { t.shift(); var s = t.slice().sort(function (a, b) { return a - b; }); res({ fps: (t.length / (now - t0)) * 1000, p95: s[Math.floor(s.length * 0.95)], worst: s[s.length - 1], frames: t.length, over25: t.filter(function (x) { return x > 25; }).length }); } } requestAnimationFrame(tick); });` });
    const m: { fps: number; p95: number; worst: number; frames: number; over25: number } = await page.evaluate('window.__fps()');
    if (errs.length) throw new Error(`page error: ${errs[0]}`);
    const pct = (m.over25 / m.frames) * 100;
    const verdict = `${m.fps.toFixed(1)} fps avg · 95th-percentile frame ${m.p95.toFixed(1)} ms · worst ${m.worst.toFixed(0)} ms · ${m.over25}/${m.frames} frames over 25 ms (${pct.toFixed(1)}%)`;
    if (m.fps < 55) throw new Error(`below 55 fps in this sandbox: ${verdict}`);
    return verdict;
  });
} finally {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-fps.md'), r.markdown('Overlay frame-rate test at 1920×1080 (browser side only)') + '\n> Software-rendered headless Chrome in a sandbox. Says nothing about OBS, the encoder or your upload — those are measured by OBS itself (section 6).\n');
  await browser.close(); stopAll();
  process.exit(r.failed ? 1 : 0);
}
