/**
 * "Connect Kick Chat" wizard test: real controller + real kick-agent + the real TunnelManager, driving a STAND-IN cloudflared
 * (tests/fakes/fake-cloudflared) and a STAND-IN Kick server. Proves the wizard logic, the Connected-only-when-tested rule, the
 * own-account chat fix, tunnel recovery and expired-login handling. It does NOT prove a real Kick account or a real
 * Cloudflare tunnel works — those are the manual checks listed in docs/KICK-SETUP.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeKick } from '../fakes/fakeKick.ts';
import { BASE, Reporter, TMP, api, baseEnv, health, startProc, stopAll, waitFor } from './harness.ts';

const r = new Reporter();
const fk = await startFakeKick();
const WH = 18790;
const hook = `http://127.0.0.1:${WH}/kick/webhook`;
const FULL = fk.st.scope;
const env = baseEnv({
  AUTO_START: 'false', GAME_ADAPTER: 'limbo-sim', KICK_ENABLED: 'true', KICK_CHANNEL: fk.slug, KICK_CLIENT_ID: fk.clientId, KICK_CLIENT_SECRET: fk.clientSecret,
  KICK_API_BASE: fk.apiBase, KICK_AUTH_BASE: fk.authBase, KICK_WEBHOOK_PORT: String(WH), KICK_MIN_SEND_INTERVAL_SEC: '1', ROUND_INTERVAL_SEC: '60',
  KICK_TUNNEL: 'cloudflared', CLOUDFLARED_PATH: path.join(ROOT, 'tests/fakes/fake-cloudflared'), KICK_TUNNEL_PROBE_BASE: `http://127.0.0.1:${WH}`,
});
console.log(`wizard-test temp dir: ${TMP} (STAND-IN Kick ${fk.origin}, STAND-IN cloudflared)`);
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
if ((await health()).estop) await api('/api/estop', { on: false, reason: 'test start' });
startProc('kick-agent', 'apps/kick-agent/src/main.ts', env);
const wiz = async () => api('/api/kick/wizard');
const step = async (id: string) => (await wiz()).steps.find((s: any) => s.id === id);
const login = async (scope?: string) => {
  if (scope !== undefined) fk.st.scope = scope;
  const c = await api('/api/kick/connect', { slot: 'broadcaster' });
  const u = new URL(c.url);
  const code = fk.authorize(u.searchParams.get('code_challenge')!);
  const html = await (await fetch(`${BASE}/api/kick/callback?code=${code}&state=${u.searchParams.get('state')}`)).text();
  if (!html.includes('Connected')) throw new Error(html.slice(0, 200));
};
const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));
/** Hubie answers by name every time (direct mention); other chat is probabilistic. */
const say = (user: string, text: string, senderId = 9001, id?: string) => fk.deliver(hook, 'chat.message.sent', fk.chatPayload(user, text, id, senderId));
let addr1 = '';

try {
  await r.run('Before anything is tested the wizard never says Connected', async () => {
    const w = await wiz();
    if (w.connected) throw new Error('connected=true with nothing tested');
    const ch = (await api('/api/health')).components.find((c: any) => c.name === 'kick');
    const chk = await api('/api/checklist').catch(() => null);
    const kickRow = (chk?.items ?? chk?.checks ?? []).find?.((x: any) => x.id === 'kick');
    if (kickRow && kickRow.status === 'Ready') throw new Error('checklist says Ready');
    return `connected=false; steps: ${w.steps.map((s: any) => `${s.id}:${s.state}`).join(' ')}; health=${ch?.state}`;
  });

  await r.run('Cloudflared auto-starts, the address is read, and the tunnel is verified reachable', async () => {
    const t = await waitFor('tunnel step done', async () => { const s = await step('tunnel'); return s.state === 'done' && s; }, 30_000);
    const w = await wiz();
    addr1 = w.panel.webhook;
    if (!/^https:\/\/fake-[a-z0-9-]+\.trycloudflare\.com\/kick\/webhook$/.test(addr1)) throw new Error(`address ${addr1}`);
    return `address ${addr1} · ${t.detail}`;
  });

  await r.run('Login that lacks the "receive chat events" permission is detected and named', async () => {
    await login('user:read channel:read chat:write');
    const s = await waitFor('account error', async () => { const x = await step('account'); return x.state === 'error' && x; }, 15_000);
    if (!/receive chat events/.test(s.detail)) throw new Error(s.detail);
    return `"${s.detail}" → fix: "${s.fix}"`;
  });

  await r.run('Reconnecting with every permission turns the step green', async () => {
    await login(FULL);
    const s = await waitFor('account done', async () => { const x = await step('account'); return x.state === 'done' && x; }, 15_000);
    return s.detail.slice(0, 120);
  });

  await r.run('Kick refusing the chat subscription (webhooks not enabled) is surfaced, not hidden', async () => {
    fk.st.subs = []; fk.st.subError = 'webhooks are not enabled for this app';
    await api('/api/kick/resubscribe', {});
    const s = await waitFor('subs error', async () => { const x = await step('subs'); return x.state === 'error' && x; }, 20_000);
    if (!/not enabled/.test(s.detail)) throw new Error(s.detail);
    fk.st.subError = '';
    await api('/api/kick/resubscribe', {});
    const ok = await waitFor('subs done', async () => { const x = await step('subs'); return x.state === 'done' && x; }, 20_000);
    return `error shown: "${s.detail.slice(0, 90)}…" → after enabling: "${ok.detail.slice(0, 70)}"`;
  });

  await r.run('Test Kick Chat posts a real message through the API, but is NOT "connected" until Kick delivers one back', async () => {
    const before = fk.st.sent.length;
    const t = await api('/api/kick/test', {});
    if (!t.ok) throw new Error(JSON.stringify(t));
    await waitFor('test message sent', async () => fk.st.sent.length > before, 15_000);
    const sent = fk.st.sent[fk.st.sent.length - 1];
    const sendStep = await waitFor('send step', async () => { const x = await step('send'); return x.state === 'done' && x; }, 15_000);
    const w = await wiz();
    if (w.connected) throw new Error('connected after send only');
    return `"${sent.content.slice(0, 50)}…" delivered (${sendStep.detail}); still connected=false because nothing has arrived from Kick yet`;
  });

  await r.run('Hubie\'s own echoed message is not treated as viewer chat', async () => {
    const before = (await api('/api/kick')).lastIn?.id;
    const own = fk.st.sent[fk.st.sent.length - 1];
    await say('HubieBot', own.content, 777); // echo of what Hubie just sent, from Hubie's own account id
    await say('HubieBot', own.content, 777, `m${fk.st.sent.length}`);
    await sleep(1500);
    const after = (await api('/api/kick')).lastIn?.id;
    if (after !== before) throw new Error('own message was processed as chat');
    return 'echo of Hubie\'s own message (same account id) ignored';
  });

  await r.run('Typing "hi Hubie" arrives as a signed webhook, Hubie answers in chat, and ONLY THEN Kick is Connected', async () => {
    const before = fk.st.sent.length;
    const st = await say('ViewerAnna', 'hi Hubie');
    if (st !== 200) throw new Error(`webhook ${st}`);
    const reply = await waitFor('Hubie reply', async () => fk.st.sent.length > before && fk.st.sent[fk.st.sent.length - 1], 40_000);
    const w = await waitFor('connected', async () => { const x = await wiz(); return x.connected && x; }, 20_000);
    const chk = await api('/api/checklist').catch(() => null);
    return `reply: "${reply.content.slice(0, 80)}" · all steps ${w.steps.map((s: any) => s.state).join(',')} · connected=${w.connected}`;
  });

  await r.run('Channel owner typing "hi Hubie" from the SAME account Hubie posts as still gets an answer', async () => {
    // Hubie posts as account 777 (the connected login). The owner's own typing comes from that same id.
    let i = 0; const before = fk.st.sent.length;
    await sleep(5500); // per-user gap for direct replies
    const st = await say('HubieBot', 'hi Hubie, it is me the owner', 777, `own-${Date.now()}`);
    if (st !== 200) throw new Error(`webhook ${st}`);
    const reply = await waitFor('reply to owner', async () => fk.st.sent.length > before && fk.st.sent[fk.st.sent.length - 1], 40_000);
    const k = await api('/api/kick');
    if (!/owner/.test(k.lastIn?.text ?? '')) throw new Error('owner message was dropped');
    return `owner message accepted; reply "${reply.content.slice(0, 70)}"`;
  });

  await r.run('Webhook step only counts for the address Kick used: a tunnel restart changes it and un-confirms it', async () => {
    execSync("pkill -f '[f]ake-cloudflared'; true");
    const gone = await waitFor('tunnel noticed', async () => { const t = (await api('/api/kick')).tunnelStatus; return (t.state === 'error' || t.url !== addr1.replace('/kick/webhook', '')) && t; }, 20_000);
    const t2 = await waitFor('new address', async () => { const t = (await api('/api/kick')).tunnelStatus; return t.state === 'running' && t.webhookUrl && t.webhookUrl !== addr1 && t; }, 40_000);
    const w = await wiz();
    if (w.connected) throw new Error('still connected on an address Kick has never used');
    const ws = w.steps.find((s: any) => s.id === 'webhook');
    if (ws.state === 'done' || !/CHANGED/.test(ws.detail)) throw new Error(`webhook step: ${ws.state} ${ws.detail}`);
    // Kick (here: the stand-in) delivers to the new address → confirmed again
    await sleep(5500);
    await say('ViewerBob', 'hi Hubie', 9002);
    const back = await waitFor('connected again', async () => { const x = await wiz(); return x.connected && x; }, 40_000);
    return `restart → new address ${t2.webhookUrl.slice(0, 48)}… → "${ws.detail.slice(0, 60)}…" → after a delivery on the new address: connected=${back.connected}`;
  });

  await r.run('Token expiry: an expired access token is refreshed silently', async () => {
    fk.st.expireNext = true; await login(FULL); fk.st.expireNext = false;
    const before = fk.st.tokenRequests.filter((t) => t.grant === 'refresh_token' && t.ok).length;
    await api('/api/kick/test', {});
    await waitFor('refresh used', async () => fk.st.tokenRequests.filter((t) => t.grant === 'refresh_token' && t.ok).length > before, 20_000);
    return 'access token (1 s lifetime) was renewed with the refresh token before sending';
  });

  await r.run('A revoked login is reported as "Reconnect", not silently dead', async () => {
    fk.st.expireNext = true; await login(FULL); fk.st.expireNext = false;
    fk.st.refreshes.clear(); // Kick no longer accepts the refresh token
    await sleep(1500);
    await api('/api/kick/test', {});
    const s = await waitFor('account error', async () => { const x = await step('account'); return x.state === 'error' && x; }, 25_000);
    const w = await wiz();
    if (w.connected) throw new Error('connected with a dead login');
    if (!/Reconnect/i.test(s.detail + (s.fix ?? ''))) throw new Error(s.detail);
    return `"${s.detail.slice(0, 110)}"`;
  });

  await r.run('No secrets in the wizard/status responses or logs', async () => {
    const dump = JSON.stringify([await wiz(), await api('/api/kick'), await api('/api/health')]);
    if (dump.includes(fk.clientSecret) || /fk_user_|fk_app_|fr_\d/.test(dump)) throw new Error('token or secret in an API response');
    const logs = ['controller', 'kick-agent'].map((n) => { try { return fs.readFileSync(path.join(TMP, `${n}.log`), 'utf8'); } catch { return ''; } }).join('\n');
    if (logs.includes(fk.clientSecret) || /fk_user_|fk_app_/.test(logs)) throw new Error('secret/token in logs');
    return 'client secret and tokens absent from /api/kick, /api/kick/wizard, /api/health and both logs';
  });

  await r.run('Control Center → section 4 shows the wizard, one address to copy, the status panel and Test Kick Chat', async () => {
    const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
    const errs: string[] = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/#4`);
    await page.getByRole('heading', { name: /Connect Kick Chat/ }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Test Kick Chat' }).waitFor();
    await page.getByRole('button', { name: 'Reconnect' }).waitFor();
    const text = await page.locator('section').innerText();
    for (const needle of ['Kick app details', 'Public address for Kick', 'Paste the address into your Kick app', 'Chat event subscription', 'Hubie hears you and answers', 'Receiving chat', 'Sending chat']) if (!text.includes(needle)) throw new Error(`missing "${needle}"`);
    const copyBtns = await page.locator('.copy code').allInnerTexts();
    const addr = (await wiz()).panel.webhook;
    if (!copyBtns.some((c) => c === addr)) throw new Error(`webhook address not shown for copying (${copyBtns.join(' | ')})`);
    if (/Connected — tested both ways/.test(text)) throw new Error('UI claims connected while the login is dead');
    fs.mkdirSync(path.join(ROOT, 'docs', 'screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'kick-wizard.png'), fullPage: true });
    await browser.close();
    if (errs.length) throw new Error(`page errors: ${errs[0]}`);
    return `wizard rendered; address shown once for copy; no false "Connected" while login is revoked`;
  });
} finally {
  const md = r.markdown('Connect Kick Chat wizard test (STAND-IN Kick + STAND-IN cloudflared — not the real services)');
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-kick-wizard.md'), md + '\n> Real Kick and a real Cloudflare tunnel were **not** reachable from the build machine. Rows above ran against `tests/fakes/fakeKick.ts` and `tests/fakes/fake-cloudflared`. A real account still needs the manual check in docs/KICK-SETUP.md.\n');
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length}/${r.results.length} passed`);
  stopAll(); await fk.close();
  process.exit(r.failed ? 1 : 0);
}
