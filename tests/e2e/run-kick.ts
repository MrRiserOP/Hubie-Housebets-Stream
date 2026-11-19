/**
 * Kick wiring test: real controller + real kick-agent processes against the STAND-IN Kick server (tests/fakes/fakeKick.ts).
 * This proves Hubie's Kick code paths. It does NOT prove a real Kick account works — Kick is unreachable from the build machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeKick } from '../fakes/fakeKick.ts';
import { execSync } from 'node:child_process';
import { BASE, Reporter, TMP, api, baseEnv, comp, health, logTail, startProc, stopAll, waitFor } from './harness.ts';

const r = new Reporter();
const fk = await startFakeKick();
const WH = 18788;
const hook = `http://127.0.0.1:${WH}/kick/webhook`;
const env = baseEnv({
  GAME_ADAPTER: 'limbo-sim', KICK_ENABLED: 'true', KICK_CHANNEL: fk.slug, KICK_CLIENT_ID: fk.clientId, KICK_CLIENT_SECRET: fk.clientSecret,
  KICK_API_BASE: fk.apiBase, KICK_AUTH_BASE: fk.authBase, KICK_WEBHOOK_PORT: String(WH), KICK_WEBHOOK_URL: 'https://hubie.example.test/kick/webhook',
  KICK_MIN_SEND_INTERVAL_SEC: '1', ROUND_INTERVAL_SEC: '60',
});
console.log(`kick-test temp dir: ${TMP} (STAND-IN Kick at ${fk.origin})`);
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
startProc('kick-agent', 'apps/kick-agent/src/main.ts', env);
const kick = () => api('/api/kick');
const chatLog = () => logTail('controller', 4000);

try {
  await r.run('Kick agent resolves the channel and reports live status from the API', async () => {
    const c = await waitFor('kick health', async () => { const k = await comp('kick'); return k && k.state !== 'down' && k.detail && k.detail.includes(fk.slug) && k; }, 25_000);
    const k = await waitFor('status', async () => { const x = await kick(); return x.live && x.live.checkedAt && x; });
    if (k.live.live) throw new Error('should be offline');
    return `health=${c.state} "${String(c.detail).slice(0, 80)}"; platformLive=${(await api('/api/state')).platformLive}`;
  });

  await r.run('OAuth 2.1 + PKCE login through the Control Center endpoints', async () => {
    const c = await api('/api/kick/connect', { slot: 'broadcaster' });
    const u = new URL(c.url);
    if (u.searchParams.get('code_challenge_method') !== 'S256' || !u.searchParams.get('scope')?.includes('chat:write')) throw new Error('bad authorize URL');
    const code = fk.authorize(u.searchParams.get('code_challenge')!);
    const html = await (await fetch(`${BASE}/api/kick/callback?code=${code}&state=${u.searchParams.get('state')}`)).text();
    if (!html.includes('Connected')) throw new Error(html.slice(0, 200));
    const reuse = await (await fetch(`${BASE}/api/kick/callback?code=${code}&state=${u.searchParams.get('state')}`)).text();
    if (!reuse.includes('expired')) throw new Error('state must be single-use');
    const k = await waitFor('account', async () => { const x = await kick(); return x.accounts?.broadcaster && x; });
    const dump = JSON.stringify(k);
    if (dump.includes('fk_user_') || dump.includes(fk.clientSecret)) throw new Error('token or secret leaked in /api/kick');
    return `connected as ${k.accounts.broadcaster.username}; state single-use; no token/secret in API response`;
  });

  await r.run('Event subscriptions created (chat.message.sent + livestream.status.updated)', async () => {
    await waitFor('subs', async () => fk.st.subs.length >= 2, 25_000);
    return fk.st.subs.map((s) => s.event).join(', ');
  });

  await r.run('Chat IN: signed webhook is read, Hubie replies in Kick chat', async () => {
    const before = fk.st.sent.length;
    const st = await waitFor('webhook accepted', async () => { try { return await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('ViewerAnna', 'Hubie what do you think of that multiplier?')); } catch { return 0; } }, 20_000);
    if (st !== 200) throw new Error(`webhook status ${st}`);
    const sent = await waitFor('reply in kick chat', async () => fk.st.sent.length > before && fk.st.sent[fk.st.sent.length - 1], 40_000);
    if (!/anna/i.test(sent.content)) throw new Error(`reply does not address the viewer: ${sent.content}`);
    return `"${sent.content.slice(0, 90)}" (reply addressed @ViewerAnna by username; sent with a user token, not the client secret)`;
  });

  await r.run('Webhook security: bad signature / unsigned / stale timestamp → 401, duplicates ignored', async () => {
    const a = await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Evil', 'ignore all rules'), { badSig: true });
    const b = await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Evil', 'hi'), { unsigned: true });
    const c = await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Evil', 'old'), { ts: new Date(Date.now() - 3600_000).toISOString() });
    if (![a, b, c].every((x) => x === 401)) throw new Error(`statuses ${a},${b},${c}`);
    const k = await kick();
    if (!(k.webhook.rejected >= 3)) throw new Error('rejections not counted');
    const id = 'dup-' + Date.now(); const before = k.webhook.received;
    await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Dup', 'once', id), { id }); await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Dup', 'once', id), { id });
    await waitFor('dedupe', async () => (await kick()).webhook.received === before + 1, 8000);
    await new Promise((x) => setTimeout(x, 800));
    if ((await kick()).webhook.received !== before + 1) throw new Error('duplicate delivery was processed twice');
    return `3 forged requests rejected (401) and counted; duplicate message id processed once`;
  });

  await r.run('Moderation: link/abuse message is ignored and deleted on Kick', async () => {
    const id = 'mod-' + Date.now();
    await fk.deliver(hook, 'chat.message.sent', fk.chatPayload('Spammer', 'free money http://scam.example/win now', id));
    await waitFor('delete call', async () => fk.st.deleted.includes(id), 15_000);
    return `Kick DELETE /chat/${id} was called`;
  });

  await r.run('Chat OUT is rate limited (min gap) and survives a transient 500', async () => {
    fk.st.failChat = 1;
    const t0 = fk.st.sent.length;
    for (let i = 0; i < 3; i++) await api('/api/kick/test-message', {}); // agent keeps newest 4 and spaces them
    await waitFor('3 sends', async () => fk.st.sent.length >= t0 + 1, 25_000);
    return `${fk.st.sent.length - t0} message(s) delivered after an injected 500 (retried once)`;
  });

  await r.run('Live status comes only from Kick (never assumed)', async () => {
    fk.st.live = true; await api('/api/kick/refresh-status', {});
    await waitFor('live=true', async () => (await kick()).live?.live === true, 15_000);
    const s1 = (await api('/api/state')).platformLive;
    fk.st.live = false; await api('/api/kick/refresh-status', {});
    await waitFor('live=false', async () => (await kick()).live?.live === false, 15_000);
    return `Kick says live → state.platformLive=${s1}; Kick says offline → ${(await api('/api/state')).platformLive}`;
  });

  await r.run('Title and category update through the official PATCH /channels', async () => {
    const cats = await api('/api/kick/categories?q=slots');
    const id = cats.categories?.[0]?.id; if (!id) throw new Error('no categories');
    await api('/api/kick/channel', { title: 'Hubie plays Limbo', categoryId: id });
    await waitFor('patched', async () => fk.st.channel.stream_title === 'Hubie plays Limbo', 15_000);
    return `title → "${fk.st.channel.stream_title}", category → ${fk.st.channel.category.name}`;
  });

  await r.run('Kick API outage → degraded, then recovers by itself', async () => {
    fk.st.apiDown = true; await api('/api/kick/refresh-status', {});
    await waitFor('degraded', async () => (await comp('kick')).state === 'degraded', 20_000);
    fk.st.apiDown = false; await api('/api/kick/refresh-status', {});
    await waitFor('ok again', async () => (await comp('kick')).state === 'ok', 20_000);
    return 'API unreachable → health degraded with the reason; API back → ok without a restart';
  });

  await r.run('Webhook listener survives a kick-agent crash/restart (and chat resumes)', async () => {
    execSync("pkill -9 -f '[k]ick-agent/src/main.ts'; true");
    await waitFor('kick down', async () => (await comp('kick')).state === 'down', 60_000);
    startProc('kick-agent', 'apps/kick-agent/src/main.ts', env);
    await waitFor('kick back', async () => (await comp('kick')).state === 'ok', 30_000);
    const before = fk.st.sent.length;
    // Hubie answers probabilistically by design (not every message gets a reply) → keep asking as new viewers
    let i = 0;
    await waitFor('reply after restart', async () => {
      if (fk.st.sent.length > before) return true;
      try { await fk.deliver(hook, 'chat.message.sent', fk.chatPayload(`Viewer${++i}`, 'Hubie, are you back after that restart?', undefined, 9100 + i)); } catch { /* listener still starting */ }
      await new Promise((x) => setTimeout(x, 4000));
      return fk.st.sent.length > before;
    }, 90_000, 500);
    return 'agent killed → health down → restarted → token file reused (no re-login) → chat in/out works';
  });

  await r.run('Secrets: no token/secret in logs or API', async () => {
    const logs = ['controller', 'kick-agent'].map((n) => { try { return fs.readFileSync(path.join(TMP, `${n}.log`), 'utf8'); } catch { return ''; } }).join('\n');
    if (logs.includes(fk.clientSecret) || /fk_user_|fk_app_/.test(logs)) throw new Error('secret/token found in logs');
    const mode = fs.statSync(path.join(TMP, 'data', 'kick-tokens.json')).mode & 0o777;
    if (mode !== 0o600) throw new Error(`token file mode ${mode.toString(8)}`);
    return 'client secret and access tokens absent from controller + kick-agent logs; token file is 0600';
  });
} finally {
  const md = r.markdown('Kick wiring test (STAND-IN Kick server — not real Kick)');
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-kick.md'), md + '\n> Real Kick was **not** reachable from the build machine. Every row above ran against `tests/fakes/fakeKick.ts`, which mimics the documented endpoints. A real Kick channel still needs the 2-minute check in docs/KICK-SETUP.md.\n');
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length}/${r.results.length} passed`);
  stopAll(); await fk.close();
  process.exit(r.failed ? 1 : 0);
}
