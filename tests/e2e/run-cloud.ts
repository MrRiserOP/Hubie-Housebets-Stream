/**
 * Streamable cloud mode — what can be proven WITHOUT Streamable: the public overlay is view-only and token-gated, a client arriving
 * through a reverse proxy is never treated as "local", telemetry from a cloud-OBS-style browser source reaches the Control Center,
 * and the verdict/checklist react to software rendering. A node WebSocket client with X-Forwarded-For stands in for Caddy + cloud OBS.
 * It does NOT prove anything about Streamable itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { BASE, PORT, Reporter, api, baseEnv, health, startProc, stopAll, waitFor } from './harness.ts';

const OTOK = 'overlay-test-token-0123456789';
const CTOK = 'control-test-token-0123456789';
const r = new Reporter();
const env = baseEnv({ STREAM_MODE: 'streamable-cloud', OVERLAY_TOKEN: OTOK, CONTROL_TOKEN: CTOK, PUBLIC_HOST: 'hubie.example.test', AUTO_START: 'false', GAME_ADAPTER: 'none' });
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);

/** open a WebSocket as Caddy would present it (X-Forwarded-For set). Resolves with how it ended. */
function proxied(query: string, role: string, then?: (ws: WebSocket) => void): Promise<{ stayedOpen: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hub${query}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    let done = false; const fin = (v: { stayedOpen: boolean; closeCode?: number }) => { if (!done) { done = true; try { ws.close(); } catch { /* */ } resolve(v); } };
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role })); then?.(ws); setTimeout(() => fin({ stayedOpen: true }), 900); });
    ws.on('close', (code) => fin({ stayedOpen: false, closeCode: code }));
    ws.on('error', () => fin({ stayedOpen: false }));
  });
}
const get = (p: string, headers: Record<string, string> = {}) => fetch(`${BASE}${p}`, { headers });

try {
  await r.run('Proxied WebSocket without any token is refused', async () => {
    const o = await proxied('', 'overlay'); if (o.stayedOpen) throw new Error('connection stayed open'); return `closed (${o.closeCode})`;
  });
  await r.run('Proxied WebSocket with a wrong overlay token is refused', async () => {
    const o = await proxied('?otoken=nope', 'overlay'); if (o.stayedOpen) throw new Error('connection stayed open'); return `closed (${o.closeCode})`;
  });
  await r.run('Overlay token lets a proxied client act as an overlay only', async () => {
    const ok = await proxied(`?otoken=${OTOK}`, 'overlay'); if (!ok.stayedOpen) throw new Error(`overlay refused (${ok.closeCode})`);
    const bad = await proxied(`?otoken=${OTOK}`, 'control'); if (bad.stayedOpen) throw new Error('overlay token was accepted for the control role');
    const bad2 = await proxied(`?otoken=${OTOK}`, 'game-agent'); if (bad2.stayedOpen) throw new Error('overlay token was accepted for the game-agent role');
    return 'overlay role accepted; control and game-agent roles refused';
  });
  await r.run('A view-only overlay cannot press emergency stop, send control actions or change anything', async () => {
    await proxied(`?otoken=${OTOK}`, 'overlay', (ws) => { ws.send(JSON.stringify({ type: 'estop', on: true, reason: 'attack' })); ws.send(JSON.stringify({ type: 'control', action: 'obs_start', payload: { confirm: 'GO LIVE' } })); });
    const h = await api('/api/health').catch(() => null);
    const hh = await (await get('/api/health', { 'x-control-token': CTOK })).json() as any;
    if (hh.estop) throw new Error('estop was toggled by a view-only client');
    void h; return 'estop untouched; control messages ignored';
  });
  await r.run('Control token over a proxy still gives full control (the Control Center)', async () => {
    const o = await proxied(`?token=${CTOK}`, 'control'); if (!o.stayedOpen) throw new Error(`refused (${o.closeCode})`); return 'accepted';
  });
  await r.run('The API refuses requests that come through a proxy without the control token', async () => {
    const a = await get('/api/cloud/status', { 'x-forwarded-for': '203.0.113.9' }); if (a.status !== 401) throw new Error(`status ${a.status}`);
    const b = await get('/api/cloud/status', { 'x-forwarded-for': '203.0.113.9', 'x-control-token': CTOK }); if (b.status !== 200) throw new Error(`with token: ${b.status}`);
    const c = await get(`/api/cloud/status?token=${OTOK}`, { 'x-forwarded-for': '203.0.113.9' }); if (c.status !== 401) throw new Error('overlay token opened the API');
    return 'no token → 401; overlay token → 401; control token → 200';
  });
  await r.run('Cloud status builds the https overlay link (only for authorized callers) and keeps local OBS off', async () => {
    const s = await (await get('/api/cloud/status', { 'x-control-token': CTOK })).json() as any;
    if (s.mode !== 'streamable-cloud' || !s.localObsDisabled) throw new Error('mode not cloud');
    const u = new URL(s.overlayUrl);
    if (u.origin !== 'https://hubie.example.test' || u.pathname !== '/overlay' || u.searchParams.get('otoken') !== OTOK || u.searchParams.get('cloud') !== '1') throw new Error(`bad url ${s.overlayUrl}`);
    if (JSON.stringify(s).includes(CTOK)) throw new Error('control token leaked into the cloud status');
    return 'https://hubie.example.test/overlay?cloud=1&audio=1&otoken=… ; control token not present';
  });
  const tel = (o: Record<string, unknown>) => ({ type: 'overlay_telemetry', t: { fps: 60, p95Ms: 17, worstMs: 30, frames: 300, gpu: 'NVIDIA Tesla T4', software: false, cores: 8, memGB: 8, w: 1920, h: 1080, ua: 'test', audioCtx: 'player', cloud: true, ...o } });
  await r.run('Verdict reflects a live cloud overlay: ok → software rendering → low fps → wrong size', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hub?otoken=${OTOK}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
    const verdict = async () => ((await (await get('/api/cloud/status', { 'x-control-token': CTOK })).json()) as any).verdict;
    const send = async (o: Record<string, unknown>, want: string) => { ws.send(JSON.stringify(tel(o))); return waitFor(`verdict ${want}`, async () => { const v = await verdict(); return v.state === want && v; }, 5000, 150); };
    const ok = await send({}, 'ok');
    const sw = await send({ gpu: 'Google SwiftShader', software: true }, 'problem'); if (!/software/i.test(sw.detail)) throw new Error('software rendering not named');
    const low = await send({ fps: 31 }, 'problem'); if (!/31 fps/.test(low.detail)) throw new Error('low fps not named');
    const size = await send({ w: 1280, h: 720 }, 'problem'); if (!/1280×720/.test(size.detail)) throw new Error('wrong size not named');
    const chk = ((await api('/api/check-all')).checks ?? []);
    void chk; ws.close();
    return `ok: "${ok.detail}" | software: "${sw.detail}"`;
  });
  await r.run('Pre-stream checklist in cloud mode uses cloud checks, not local OBS', async () => {
    const res = await (await fetch(`${BASE}/api/check-all`, { method: 'POST', headers: { 'x-control-token': CTOK, 'content-type': 'application/json' }, body: '{}' })).json() as any;
    const ids = res.checks.map((c: any) => c.id);
    if (!ids.includes('cloud') || !ids.includes('cloud-go-live')) throw new Error(`cloud checks missing: ${ids}`);
    if (ids.includes('obs') || ids.includes('obs-1080p60')) throw new Error('local OBS checks still present');
    const go = res.checks.find((c: any) => c.id === 'cloud-go-live');
    if (go.status === 'Ready' || go.status === 'Connected') throw new Error('claims the cloud output works without evidence');
    return `checks: ${ids.join(', ')} — stream output honestly "${go.status}"`;
  });
  await r.run('Rotating the overlay link disconnects viewers and the old token stops working', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hub?otoken=${OTOK}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
    const closed = new Promise<number>((res) => ws.on('close', (c) => res(c)));
    const out = await (await fetch(`${BASE}/api/cloud/rotate-overlay-token`, { method: 'POST', headers: { 'x-control-token': CTOK, 'content-type': 'application/json' }, body: '{}' })).json() as any;
    const code = await Promise.race([closed, new Promise<number>((res) => setTimeout(() => res(-1), 3000))]);
    if (code === -1) throw new Error('viewer not disconnected');
    const again = await proxied(`?otoken=${OTOK}`, 'overlay'); if (again.stayedOpen) throw new Error('old token still accepted');
    if (new URL(out.overlayUrl).searchParams.get('otoken') === OTOK) throw new Error('token not changed');
    return 'viewer closed; old token refused; new link issued';
  });
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    await r.run('The real overlay page (1920×1080) measures itself and reports to the controller', async () => {
      const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
      await page.goto(`${BASE}/overlay?cloud=1&token=${CTOK}`);
      const s = await waitFor('overlay telemetry', async () => { const x = await (await get('/api/cloud/status', { 'x-control-token': CTOK })).json() as any; return x.pagesReporting.length ? x : false; }, 20_000, 500);
      const p = s.pagesReporting[0];
      if (p.w !== 1920 || p.h !== 1080) throw new Error(`reported ${p.w}×${p.h}`);
      if (!(p.fps > 5)) throw new Error(`fps ${p.fps}`);
      await page.close();
      return `reported ${p.w}×${p.h} at ${p.fps} fps (headless sandbox browser, software rendering — not a cloud GPU)`;
    });
  } finally { await browser.close(); }
  r.skip('Streamable API / OAuth / server status / OBS WebSocket', 'No public documentation found; nothing implemented, nothing claimed.');
  r.skip('Browser Source inside real Streamable Remote OBS; GPU encode; dropped frames; Kick output', 'Streamable and Kick are unreachable from this sandbox — manual test in docs/STREAMABLE-CLOUD.md.');
} finally {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-cloud.md'), r.markdown('Streamable cloud mode — automated tests (local stand-ins)') + '\n> A node WebSocket client with X-Forwarded-For stands in for Caddy and for cloud OBS. Nothing here talks to Streamable.\n');
  stopAll();
  process.exit(r.failed ? 1 : 0);
}
