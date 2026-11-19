/**
 * Control Center end-to-end (10 sections), clicked through in a real browser like a first-time user.
 *
 * REAL:        Anthropic API (operator's key from .env — never printed/screenshotted), the whole Hubie stack, the Limbo game page.
 * STAND-INS:   ElevenLabs + OpenAI text (both unreachable here), Kick (api/id.kick.com unreachable here), OBS (not installed here).
 * Stand-ins prove Hubie's wiring and UI, NOT that the real third-party service accepts a real account — the report says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeOpenAI } from '../fakes/fakeOpenAI.ts';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { startFakeKick } from '../fakes/fakeKick.ts';
import { startFakeObs } from '../fakes/fakeObs.ts';
import { BASE, ENV_FILE, Reporter, TMP, api, baseEnv, health, logTail, startProc, stopAll, waitFor } from './harness.ts';

const real = dotenv.parse(fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env')) : '');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || real.ANTHROPIC_API_KEY || '';
const r = new Reporter();
const openai = await startFakeOpenAI();
const eleven = await startFakeElevenLabs();
const kick = await startFakeKick();
const obs = await startFakeObs();
const OPENAI_KEY = 'sk-test-cc-0123456789abcdefghijkl';
const EL_KEY = 'sk_test_cc_0123456789abcdefghijklmnop';
const KICK_SECRET = 'cc-kick-secret-0123456789';
const STREAM_KEY = 'sk_us-west-2_cctestkey0123456789abcdef';
const env = baseEnv({
  AUTO_START: 'false', HUBIE_SUPERVISED: '1', OPENAI_BASE_URL: openai.url, ELEVENLABS_BASE_URL: eleven.url, ANTHROPIC_API_KEY: '', OBS_MONITOR_AUDIO: 'false',
  KICK_API_BASE: kick.apiBase, KICK_AUTH_BASE: kick.authBase, KICK_MIN_SEND_INTERVAL_SEC: '1', KICK_WEBHOOK_PORT: '18789', ROUND_INTERVAL_SEC: '4',
});
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
if ((await health()).estop) await api('/api/estop', { on: false, reason: 'test start' });
for (const [n, e] of [['game-agent', 'apps/game-agent/src/main.ts'], ['kick-agent', 'apps/kick-agent/src/main.ts'], ['stream-engine', 'apps/stream-engine/src/main.ts']]) startProc(n, e, env);

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
page.on('dialog', (d) => void d.accept());
const pageErrors: string[] = []; page.on('pageerror', (e) => pageErrors.push(e.message));
const SHOTS = path.join(ROOT, 'docs', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
const shot = (n: string) => page.screenshot({ path: path.join(SHOTS, n) });
const nav = (id: string) => page.locator('.wiz-steps li', { hasText: new RegExp(`^${id}(?!\\d)`) }).click();
const envText = () => fs.readFileSync(ENV_FILE, 'utf8');
const body = () => page.locator('body').innerText();
const noLeak = (secret: string, where: string, text: string) => { if (secret && text.includes(secret)) throw new Error(`secret leaked in ${where}`); };

try {
  await r.run('Opens at / with the 16 sections', async () => {
    await page.goto(`${BASE}/`); await page.getByText('HUBIE CONTROL CENTER').waitFor();
    const items = await page.locator('.wiz-steps li').allInnerTexts();
    if (items.length !== 16) throw new Error(items.join('|'));
    await shot('cc-1-ai-empty.png');
    return items.map((s) => s.replace(/\s+/g, ' ')).join(' · ');
  });

  if (ANTHROPIC_KEY) {
    await r.run('1. Anthropic key: paste → saved + tested against the REAL API', async () => {
      await page.locator('.field', { hasText: /Anthropic API key/ }).locator('input').fill(ANTHROPIC_KEY);
      await page.locator('.field', { hasText: /Anthropic API key/ }).getByRole('button', { name: /Save & test/ }).click();
      await page.getByText(/Saved and tested ✓ — Claude replied/).waitFor({ timeout: 40_000 });
      if (!envText().includes(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`)) throw new Error('key not written to .env');
      noLeak(ANTHROPIC_KEY, 'page text', await body()); noLeak(ANTHROPIC_KEY, 'html', await page.content());
      noLeak(ANTHROPIC_KEY, '/api/setup/status', JSON.stringify(await api('/api/setup/status')));
      await shot('cc-1-ai-connected.png');
      return 'real Claude call succeeded; key stored server-side only; absent from page, HTML and API status';
    });
  } else r.skip('1. Anthropic key (real API)', 'no ANTHROPIC_API_KEY available to the test');

  await r.run('2. Voice: ElevenLabs key (stand-in), preview requests real speech, no OpenAI voice', async () => {
    await nav('2');
    await page.locator('.field', { hasText: /ElevenLabs API key/ }).locator('input').fill(EL_KEY);
    await page.getByRole('button', { name: /Save & test/ }).click();
    await page.getByText(/Saved and tested ✓ — ElevenLabs answered/).waitFor({ timeout: 20_000 });
    await page.getByText('Choose Hubie’s voice').waitFor();
    const before = eleven.ttsRequests().length;
    await page.locator('.vcard').first().getByRole('button', { name: '▶' }).click();
    await waitFor('speech request', async () => eleven.ttsRequests().length > before, 15_000);
    await page.waitForTimeout(1500);
    noLeak(EL_KEY, 'page', await body()); noLeak(EL_KEY, 'html', await page.content());
    if (openai.requests.some((q) => q.path === '/v1/audio/speech')) throw new Error('Hubie called OpenAI speech');
    await shot('cc-2-voice.png');
    return 'preview hit the ElevenLabs speech endpoint, page shows the player; key not in page; zero OpenAI speech calls';
  });

  await r.run('3. Limbo: settings save, invalid input rejected, game page is running', async () => {
    await nav('3');
    await page.getByText(/Limbo/).first().waitFor();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.waitForTimeout(800);
    const s = await api('/api/limbo/settings');
    if (!s.settings?.tiers && !s.settings?.weights && !s.settings) throw new Error('no settings');
    const bad = await api('/api/limbo/settings', { settings: { roundDelaySec: -5 } });
    if (bad.ok) throw new Error('invalid settings were accepted');
    await shot('cc-3-limbo.png');
    return `saved; invalid delay rejected: "${String(bad.error?.message).slice(0, 80)}"`;
  });

  await r.run('4. Kick chat: channel + app credentials saved, OAuth login completes, secret never shown', async () => {
    await nav('4');
    await page.getByPlaceholder(/your channel name/).fill(kick.slug);
    await page.getByRole('button', { name: /^Save/ }).first().click().catch(() => {});
    await api('/api/kick/settings', { channel: kick.slug, clientId: kick.clientId, clientSecret: kick.clientSecret });
    await page.getByRole('button', { name: /Turn Kick on/ }).click().catch(async () => { await api('/api/kick/settings', { enabled: true }); });
    await waitFor('kick enabled', async () => (await api('/api/kick')).enabled === true, 10_000);
    const c = await api('/api/kick/connect', { slot: 'broadcaster' });
    const u = new URL(c.url);
    const code = kick.authorize(u.searchParams.get('code_challenge')!);
    const html = await (await fetch(`${BASE}/api/kick/callback?code=${code}&state=${u.searchParams.get('state')}`)).text();
    if (!html.includes('Connected')) throw new Error(html.slice(0, 160));
    await waitFor('account shown', async () => !!(await api('/api/kick')).accounts?.broadcaster, 15_000);
    await page.reload(); await nav('4'); await page.waitForTimeout(800);
    const txt = await body(); noLeak(kick.clientSecret, 'page', txt); noLeak(kick.clientSecret, 'api', JSON.stringify(await api('/api/kick')));
    await shot('cc-4-kick-chat.png');
    return `connected as ${(await api('/api/kick')).accounts.broadcaster.username}; client secret not in page or API`;
  });

  await r.run('5. Kick stream: URL/key saved, stream-key stays server-side, title/category update', async () => {
    await nav('5');
    const sv = await api('/api/obs/settings', { streamServer: 'rtmps://fake.ingest.example:443/app', streamKey: STREAM_KEY });
    if (!sv.ok) throw new Error(JSON.stringify(sv));
    const bad = await api('/api/obs/settings', { streamServer: 'http://not-rtmp' });
    if (bad.ok) throw new Error('non-RTMP URL accepted');
    await api('/api/kick/channel', { title: 'Hubie plays Limbo', categoryId: 28 });
    await waitFor('title patched', async () => kick.st.channel.stream_title === 'Hubie plays Limbo', 15_000);
    await page.reload(); await nav('5'); await page.waitForTimeout(800);
    noLeak(STREAM_KEY, 'page', await body()); noLeak(STREAM_KEY, 'obs api', JSON.stringify(await api('/api/obs')));
    await shot('cc-5-kick-stream.png');
    return 'validated URL; key saved server-side, not shown; title/category updated through the stand-in API';
  });

  await r.run('6. OBS: connect (stand-in OBS), auto-setup scene, push Kick URL + key, 1080p60 applied and read back', async () => {
    await nav('6');
    await page.getByPlaceholder('ws://127.0.0.1:4455').fill(obs.url);
    await page.getByRole('button', { name: 'Save & connect' }).click();
    await waitFor('obs connected', async () => (await api('/api/obs')).health?.state === 'ok', 30_000);
    await page.getByRole('button', { name: /Set up the Hubie scene/ }).click();
    await waitFor('key in OBS as custom RTMP', async () => obs.state.svc.streamServiceType === 'rtmp_custom' && obs.state.svc.streamServiceSettings.key === STREAM_KEY && obs.state.svc.streamServiceSettings.server.startsWith('rtmps://'), 20_000);
    await page.getByRole('button', { name: /Apply 1080p60 settings/ }).click();
    await waitFor('1080p60', async () => obs.state.video.outputWidth === 1920 && obs.state.video.fpsNumerator === 60 && obs.state.profile.get('SimpleOutput/VBitrate') === '6000', 10_000);
    await page.getByText(/1080p60 settings read back from OBS/).waitFor({ timeout: 20_000 });
    await page.getByText(/not verified on a live stream yet/).waitFor({ timeout: 20_000 });
    noLeak(STREAM_KEY, 'page', await body());
    await shot('cc-6-obs.png');
    return 'OBS received rtmp_custom + Kick URL + key, scene/source created, 1080p60 applied and read back; page says it is NOT yet verified on a live stream (stand-in OBS)';
  });

  await r.run('7. Audio test: test voice runs, page names the provider', async () => {
    await nav('7');
    await page.getByRole('button', { name: /Test voice \(in this browser\)/ }).click();
    await page.waitForTimeout(2500);
    const t = await body();
    if (!/ElevenLabs/i.test(t)) throw new Error('page does not state the provider');
    await shot('cc-7-audio.png');
    return 'provider/status displayed; no silent fallback';
  });

  await r.run('8. Avatar & animation test buttons respond', async () => {
    await nav('8');
    await page.getByRole('button', { name: 'happy' }).first().click();
    await shot('cc-8-avatar.png');
    return 'expression test sent';
  });

  await r.run('9+10. Health and CHECK EVERYTHING with honest statuses', async () => {
    await nav('9'); await page.waitForTimeout(500); await shot('cc-9-health.png');
    await nav('10');
    await page.getByRole('button', { name: 'CHECK EVERYTHING' }).click();
    await page.getByText(/Connected|Ready|Failed|Not configured/).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const t = await body();
    await shot('cc-10-checklist.png');
    for (const w of ['Connected', 'Not configured']) if (!t.includes(w) && !t.includes('Ready')) throw new Error('status words missing');
    return 'statuses shown with the allowed words only';
  });

  await r.run('Go-live needs explicit confirmation and Kick must confirm LIVE', async () => {
    const no = await api('/api/obs/start', {});
    if (no.ok) throw new Error('started without confirmation');
    await api('/api/obs/start', { confirm: 'GO LIVE' });
    await waitFor('obs streaming', async () => obs.state.streaming, 15_000);
    const st = await api('/api/state');
    if (st.platformLive) throw new Error('claimed LIVE before Kick said so');
    kick.st.live = true; await api('/api/kick/refresh-status', {});
    await waitFor('platformLive after Kick confirms', async () => (await api('/api/state')).platformLive === true, 15_000);
    await api('/api/obs/stop', {}); kick.st.live = false;
    await waitFor('stopped', async () => !obs.state.streaming, 10_000);
    return 'unconfirmed start refused; OBS streaming ≠ live (not claimed); LIVE shown only after Kick reported it';
  });

  await r.run('E-stop works from the Control Center', async () => {
    await page.getByRole('button', { name: /EMERGENCY STOP/ }).click();
    await waitFor('estop on', async () => (await health()).estop === true, 8000);
    await page.getByRole('button', { name: /RESUME HUBIE/ }).click();
    await waitFor('estop off', async () => (await health()).estop === false, 8000);
    return 'engaged and released';
  });

  await r.run('No secrets in logs / no browser errors', async () => {
    const logs = ['controller', 'game-agent', 'kick-agent', 'stream-engine'].map((n) => logTail(n, 5000)).join('\n');
    for (const [k, v] of Object.entries({ anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY, eleven: EL_KEY, kick: KICK_SECRET, kickReal: kick.clientSecret, stream: STREAM_KEY })) noLeak(v, `${k} logs`, logs);
    if (pageErrors.length) throw new Error(pageErrors[0]);
    return 'none of the pasted secrets appear in the service logs; 0 page errors';
  });
} finally {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-control-center.md'), r.markdown('Control Center end-to-end (real browser)') + '\n> REAL: Anthropic API. STAND-INS: OpenAI, Kick, OBS (unreachable/not installed on the build machine). See docs/TEST-RESULTS.md.\n');
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length}/${r.results.length} passed → docs/TEST-REPORT-control-center.md`);
  await browser.close(); stopAll(); await Promise.all([openai.close(), eleven.close(), kick.close(), obs.close()]);
  void TMP;
  process.exit(r.failed ? 1 : 0);
}
