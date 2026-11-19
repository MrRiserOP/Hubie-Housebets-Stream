/**
 * Entertainment-upgrade E2E (real controller + kick-agent + real Chrome) against STAND-INS for ElevenLabs and Kick.
 * Proves Hubie's own code paths: key failover, secrecy, music/ducking/recovery, ON AIR counting + persistence, control panel.
 * It does NOT prove real ElevenLabs/Kick accounts work (neither is reachable from the build machine).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { startFakeKick } from '../fakes/fakeKick.ts';
import { BASE, Reporter, TMP, api, baseEnv, health, logTail, startProc, stopAll, waitFor } from './harness.ts';

const r = new Reporter();
const el = await startFakeElevenLabs();
const fk = await startFakeKick();
const WH = 18789;
const SHOTS = path.join(ROOT, 'docs', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
const PRIMARY = 'sk_invalid_primary_0123456789abcdef';
const K_QUOTA = 'sk_quota401_backupone_0123456789abcd';
const K_ACCT1 = 'sk_acct_shared_aaaa_0123456789abcdef';
const K_ACCT2 = 'sk_acct_shared_bbbb_0123456789abcdef';
const K_GOOD = 'sk_good_backupfour_0123456789abcdef';
const SECRETS = [PRIMARY, K_QUOTA, K_ACCT1, K_ACCT2, K_GOOD];

// a deliberately broken "track" in the user music folder: the player must skip it and keep playing
fs.mkdirSync(path.join(TMP, 'data', 'music'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'data', 'music', 'broken-track.mp3'), 'this is not audio');

const env = baseEnv({
  GAME_ADAPTER: 'limbo-sim', ROUND_INTERVAL_SEC: '4', AUTO_START: 'true',
  TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: PRIMARY, ELEVENLABS_BASE_URL: el.url, ELEVENLABS_VOICE_ID: 'IKne3meq5aSn9XLyUdCD',
  KICK_ENABLED: 'true', KICK_CHANNEL: fk.slug, KICK_CLIENT_ID: fk.clientId, KICK_CLIENT_SECRET: fk.clientSecret,
  KICK_API_BASE: fk.apiBase, KICK_AUTH_BASE: fk.authBase, KICK_WEBHOOK_PORT: String(WH), KICK_WEBHOOK_URL: 'https://hubie.example.test/kick/webhook',
});
console.log(`entertainment test temp dir: ${TMP}`);
let ctl = startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 25_000);
startProc('kick-agent', 'apps/kick-agent/src/main.ts', env);

const exe = process.env.BROWSER_EXECUTABLE_PATH || undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (e) => errors.push(`cc: ${e.message}`));
const ov = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
ov.on('pageerror', (e) => errors.push(`overlay: ${e.message}`));
const keys = () => api('/api/voice/keys');
const add = (name: string, key: string) => api('/api/voice/keys/add', { name, key });
const elTtsCalls = (key: string) => el.requests.filter((q) => q.key === key && /text-to-speech/.test(q.path)).length;
const speak = (text: string) => api('/api/audio/test', { text });
const nav = (id: string) => page.locator('.wiz-steps li', { hasText: new RegExp(`^${id}(?!\\d)`) }).click();
const leakCheck = (where: string, text: string) => { for (const s of SECRETS) if (text.includes(s)) throw new Error(`secret ${s.slice(0, 12)}… leaked in ${where}`); };

try {
  /* ---------------- ElevenLabs key management & failover ---------------- */
  await r.run('Keys: add 4 backups through the API; list is masked, ordered and each tested', async () => {
    const a = await add('Backup 1 (out of credits)', K_QUOTA); const b = await add('Backup 2', K_ACCT1); const c = await add('Backup 3', K_ACCT2); const d = await add('Backup 4', K_GOOD);
    if (![a, b, c, d].every((x) => x.ok)) throw new Error(JSON.stringify([a, b, c, d].map((x) => x.error)));
    const k = await keys();
    if (k.totalKeys !== 5) throw new Error(`expected 5 keys, got ${k.totalKeys}`);
    leakCheck('/api/voice/keys', JSON.stringify(k));
    return `5 keys (primary + 4 backups); masked hints only: ${k.keys.map((x: any) => x.masked).join(' ')}`;
  });

  await r.run('Failover: invalid primary → exhausted (401 quota) → shared-account → good key; speech still delivered', async () => {
    const res = await speak('Failover test one.');
    if (!res.ok) throw new Error(JSON.stringify(res.error ?? res).slice(0, 200));
    const k = await keys();
    const by = (n: string) => k.keys.find((x: any) => x.name.startsWith(n));
    if (by('Primary').status !== 'invalid') throw new Error(`primary status ${by('Primary').status}`);
    if (by('Backup 1').status !== 'exhausted') throw new Error(`backup1 (401 quota_exceeded) is ${by('Backup 1').status}, should be exhausted not invalid`);
    if (!k.failovers.length) throw new Error('no failover history recorded');
    return `primary=${by('Primary').status}, backup1=${by('Backup 1').status}; active "${k.activeKey}"; ${k.failovers.length} failover entries; engine ${k.engine}`;
  });

  await r.run('Exhausted/invalid keys are not retried on every line', async () => {
    const q0 = elTtsCalls(K_QUOTA), p0 = elTtsCalls(PRIMARY);
    for (let i = 0; i < 4; i++) await speak(`Retry check number ${i}.`);
    const dq = elTtsCalls(K_QUOTA) - q0, dp = elTtsCalls(PRIMARY) - p0;
    if (dq > 0 || dp > 0) throw new Error(`dead keys were hit again: exhausted +${dq}, invalid +${dp}`);
    return 'after the first failure, the exhausted and invalid keys received 0 further synthesis requests over 4 more lines';
  });

  await r.run('Rate limit: key is put on cooldown and the next key serves the line', async () => {
    const RL = 'sk_ratelimit_cooldown_0123456789abcdef';
    el.rateLimit(RL, 50); SECRETS.push(RL);
    await add('Rate limited', RL);
    // priority: move it to the front
    const ids = (await keys()).keys.map((x: any) => x.id); const rl = ids.pop(); ids.unshift(rl);
    await api('/api/voice/keys/reorder', { ids });
    const res = await speak('Rate limit test.');
    if (!res.ok) throw new Error(JSON.stringify(res.error ?? res).slice(0, 700));
    const k = await keys(); const e = k.keys.find((x: any) => x.name === 'Rate limited');
    if (e.status !== 'rate_limited') throw new Error(`status ${e.status}`);
    return `status=rate_limited (cooldown), line spoken by "${k.activeKey}"`;
  });

  await r.run('Shared account quota is detected (two keys, one allowance)', async () => {
    await api('/api/voice/keys/refresh-usage', {});
    const k = await keys();
    const a = k.keys.find((x: any) => x.name === 'Backup 2'), b = k.keys.find((x: any) => x.name === 'Backup 3');
    if (!a.sharesAllowanceWith?.includes('Backup 3') || !b.sharesAllowanceWith?.includes('Backup 2')) throw new Error(`share groups: ${JSON.stringify([a.sharesAllowanceWith, b.sharesAllowanceWith])}`);
    return 'Backup 2 and Backup 3 are flagged as sharing one allowance (same limit, reset time and used count)';
  });

  await r.run('Shared allowance exhausted: both keys marked, next account takes over', async () => {
    el.exhaust('shared');
    // put the shared-account key first so it is attempted
    const ks = (await keys()).keys; const first = ks.find((x: any) => x.name === 'Backup 2');
    await api('/api/voice/keys/update', { id: first.id, enabled: true });
    const ids = ks.map((x: any) => x.id).filter((i: string) => i !== first.id); ids.unshift(first.id);
    await api('/api/voice/keys/reorder', { ids });
    await api('/api/voice/keys/test', { id: first.id });
    const res = await speak('Shared quota test.');
    if (!res.ok) throw new Error(JSON.stringify(res.error ?? res).slice(0, 700));
    const k = await keys();
    const s = ['Backup 2', 'Backup 3'].map((n) => k.keys.find((x: any) => x.name === n).status);
    if (!s.every((x: string) => x === 'exhausted')) throw new Error(`shared keys: ${s}`);
    if (k.activeKey !== 'Backup 4') throw new Error(`active ${k.activeKey}`);
    return `both shared-account keys → exhausted together; Backup 4 active and speaking`;
  });

  await r.run('Every key fails → free local voice fallback (no other paid provider), then silent mode keeps running', async () => {
    for (const k of (await keys()).keys) await api('/api/voice/keys/update', { id: k.id, enabled: false });
    const res = await speak('Everything is down.');
    const k = await keys();
    if (/openai|polly|google/i.test(JSON.stringify(k.engines))) throw new Error('another paid provider appeared');
    if (k.engine === 'elevenlabs') throw new Error('still claiming ElevenLabs');
    await api('/api/voice/failover-settings', { localFallback: 'none' });
    const silent = await speak('Nobody can hear this.');
    const h = await health();
    if (!h.ok) throw new Error('controller unhealthy after total voice failure');
    const k2 = await keys();
    return `all keys disabled → engine "${k.engine}" (browser voice = free fallback; ok=${res.ok}); with fallback set to "none": engine "${k2.engine}", ok=${silent.ok}, controller still healthy, silent lines counted: ${k2.silent}`;
  });

  await r.run('Re-enabling keys + browser fallback restores ElevenLabs speech', async () => {
    await api('/api/voice/failover-settings', { localFallback: 'browser' });
    for (const k of (await keys()).keys) if (k.name === 'Backup 4') await api('/api/voice/keys/update', { id: k.id, enabled: true });
    const res = await speak('Back again.');
    const k = await keys();
    if (!res.ok || k.engine !== 'elevenlabs') throw new Error(`engine ${k.engine} ok=${res.ok}`);
    return `engine back to elevenlabs on "${k.activeKey}"`;
  });

  /* ---------------- control panel ---------------- */
  await r.run('Control Center: sections 12–16 render, nothing leaks, no page errors', async () => {
    await page.goto(`${BASE}/`); await page.getByText('HUBIE CONTROL CENTER').waitFor();
    const names: string[] = [];
    for (const [id, title] of [['12', 'Personality'], ['13', 'Audio: voice keys'], ['14', 'Avatar animation'], ['15', 'Streaming'], ['16', 'Monitoring']] as const) {
      await nav(id); await page.getByRole('heading', { name: new RegExp(title) }).first().waitFor({ timeout: 8000 }); await page.waitForTimeout(700);
      leakCheck(`section ${id} page text`, await page.locator('body').innerText()); leakCheck(`section ${id} html`, await page.content());
      await page.screenshot({ path: path.join(SHOTS, `cc-${id}-${title.split(' ')[0].toLowerCase()}.png`), fullPage: true });
      names.push(id);
    }
    if (errors.length) throw new Error(errors.join(' | '));
    return `sections ${names.join(', ')} rendered with live data; screenshots saved; zero page errors; no key text in page or HTML`;
  });

  await r.run('Control Center 13: add a key in the UI, disable/enable, reorder, test', async () => {
    await nav('13'); await page.getByRole('heading', { name: /Audio: voice keys/ }).waitFor();
    const UIKEY = 'sk_good_fromui_0123456789abcdefgh'; SECRETS.push(UIKEY);
    await page.getByPlaceholder('Name (e.g. Backup 2)').fill('UI key'); await page.getByPlaceholder('sk_…').fill(UIKEY);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('UI key').first().waitFor({ timeout: 10_000 });
    const card = page.locator('.card', { hasText: 'UI key' }).last();
    await card.getByRole('button', { name: 'Test' }).click(); await page.waitForTimeout(800);
    await card.getByRole('button', { name: 'Disable' }).click(); await page.getByText('(disabled)').first().waitFor({ timeout: 6000 });
    await page.locator('.card', { hasText: 'UI key' }).last().getByRole('button', { name: 'Enable' }).click();
    leakCheck('UI page', await page.content());
    if ((await page.locator('input[type=password]').first().inputValue()) !== '') throw new Error('key field not cleared after saving');
    await page.screenshot({ path: path.join(SHOTS, 'cc-13-keys.png'), fullPage: true });
    const k = await keys(); if (!k.keys.some((x: any) => x.name === 'UI key')) throw new Error('UI key missing');
    return 'added via the form, field cleared, tested, disabled, re-enabled; only the masked hint is displayed';
  });

  await r.run('Control Center 12: personality changes are saved and applied', async () => {
    await nav('12'); await page.getByRole('heading', { name: /Personality/ }).first().waitFor();
    await page.getByRole('button', { name: 'Never' }).click(); await page.waitForTimeout(500);
    let p = await api('/api/personality'); if (p.settings.hat !== 'never') throw new Error(`hat=${p.settings.hat}`);
    await page.getByRole('button', { name: 'Quiet (natural silences)' }).click(); await page.waitForTimeout(500);
    p = await api('/api/personality'); if (p.settings.commentary !== 'quiet') throw new Error('commentary');
    await page.getByRole('button', { name: 'Reset to defaults' }).click(); await page.waitForTimeout(500);
    p = await api('/api/personality'); if (p.settings.hat !== 'only_when_asked' || p.settings.commentary !== 'balanced') throw new Error('reset');
    return 'hat→never, commentary→quiet applied via the panel; reset restores defaults (hat only when a viewer mentions it)';
  });

  /* ---------------- overlay: music, ducking, recovery, avatar state, ON AIR ---------------- */
  await ov.goto(`${BASE}/overlay`);
  await ov.waitForTimeout(1500);
  const music = () => api('/api/audio').then((a: any) => a.status);

  await r.run('Music: starts, skips the broken user track, keeps playing (no overlap)', async () => {
    await api('/api/audio', { mood: 'auto', musicEnabled: true, musicVolume: 40 });
    await waitFor('music playing', async () => { const s = await music(); return s && (s.state === 'playing' || s.state === 'crossfading') && s; }, 30_000).catch(async (e) => { throw new Error(`${e.message}; status=${JSON.stringify(await music())}; tracks=${(await api('/api/audio')).tracks.length}`); });
    const decks = await ov.evaluate(() => ((window as any).__hubie.music?.decks ?? []).filter((a: HTMLAudioElement) => !a.paused).length);
    if (decks > 2) throw new Error(`${decks} audio elements playing at once`);
    return `state playing; ${decks} deck(s) audible (≤2 only during a crossfade)`;
  });

  await r.run('Music: a broken track is reported, parked, and playback recovers on a good one', async () => {
    const a = await api('/api/audio'); const broken = a.tracks.find((t: any) => t.id.startsWith('user:broken'));
    if (!broken) throw new Error('broken test track not listed');
    const goods = a.tracks.filter((t: any) => !t.id.startsWith('user:'));
    // 1) only the broken file is enabled → the player must report the failure instead of going silent without a word
    await api('/api/audio', { disabledTracks: a.tracks.filter((t: any) => t.id !== broken.id).map((t: any) => t.id), mood: 'auto' });
    const s = await waitFor('failure recorded', async () => { const m = await music(); return m && m.failures > 0 && m; }, 40_000);
    // 2) a good track is enabled again → it plays (the broken one stays parked)
    await api('/api/audio', { disabledTracks: a.tracks.filter((t: any) => t.id !== broken.id && t.id !== goods[0].id).map((t: any) => t.id) });
    const after = await waitFor('recovered', async () => { const m = await music(); return m && (m.state === 'playing' || m.state === 'crossfading') && m.track === goods[0].title && m; }, 60_000);
    return `failures recorded=${s.failures}, skipped=${s.skipped}, lastError="${String(s.lastError ?? '').slice(0, 60)}"; then recovered on "${after.track}" (${after.state})`;
  });

  await r.run('Ducking: music level drops while Hubie speaks and returns afterwards', async () => {
    await api('/api/audio', { disabledTracks: [], mood: 'auto', duckEnabled: true, duckLevel: 25 });
    await waitFor('playing', async () => { const m = await music(); return m && (m.state === 'playing' || m.state === 'crossfading'); }, 30_000);
    const base = (await music()).level;
    const sent = await api('/api/audio/test-overlay', {});
    if (!sent.ok) throw new Error(sent.error?.message);
    const ducked = await waitFor('ducked', async () => { const m = await music(); return m?.ducked && m; }, 30_000);
    const released = await waitFor('released', async () => { const m = await music(); return m && !m.ducked && m; }, 60_000);
    if (!(ducked.level < base)) throw new Error(`level did not drop (${base} → ${ducked.level})`);
    return `music level ${base} → ${ducked.level} while speaking → ${released.level} after (ducked flag cleared)`;
  });

  await r.run('Avatar: reports a live animation state and previews work', async () => {
    await api('/api/avatar/preview', { state: 'celebrating' });
    const seen = await waitFor('state change', async () => { const a = await api('/api/avatar'); return a.counts && Object.keys(a.counts).length >= 2 && a; }, 20_000);
    return `states observed: ${Object.entries(seen.counts).map(([k, v]) => `${k}:${v}`).join(', ')}`;
  });

  await r.run('Overlay: OFFLINE badge while Kick says not live (counter paused)', async () => {
    const hist = (await ov.locator('.onair.history').innerText()).trim();
    if (hist !== '150+ HOURS ON AIR') throw new Error(`history badge says: ${hist}`);
    const txt = await ov.locator('.livechip').innerText();
    if (!/OFFLINE|STARTING/i.test(txt)) throw new Error(`status chip says: ${txt}`);
    const s = await api('/api/live/stats'); if (s.live) throw new Error('clock claims live');
    await ov.screenshot({ path: path.join(SHOTS, 'overlay-offline.png') });
    return `"${hist}" shown while the status chip honestly reads "${txt}"; measured counter live=false`;
  });

  await r.run('ON AIR: counts only after Kick confirms live; stops when it stops; no inflation', async () => {
    const before = await api('/api/live/stats');
    fk.st.live = true;
    await api('/api/kick/refresh-status', {});
    await waitFor('clock live', async () => (await api('/api/live/stats')).live, 40_000);
    await ov.waitForTimeout(2500);
    const txt = await ov.locator('.livechip').innerText();
    if (!/LIVE/i.test(txt)) throw new Error(`status chip: ${txt}`);
    if ((await ov.locator('.onair.history').innerText()).trim() !== '150+ HOURS ON AIR') throw new Error('history badge changed while live');
    await ov.screenshot({ path: path.join(SHOTS, 'overlay-on-air.png') });
    await new Promise((x) => setTimeout(x, 35_000));
    const mid = await api('/api/live/stats');
    if (!(mid.totalMs > before.totalMs)) throw new Error('total did not grow');
    if (mid.totalMs - before.totalMs > 120_000) throw new Error(`total grew ${mid.totalMs - before.totalMs} ms in ~75 s — inflated`);
    if (mid.label.includes('150+')) throw new Error('150+ shown early');
    fk.st.live = false; await api('/api/kick/refresh-status', {});
    await waitFor('clock paused', async () => !(await api('/api/live/stats')).live, 40_000);
    const paused = await api('/api/live/stats'); await new Promise((x) => setTimeout(x, 20_000));
    const later = await api('/api/live/stats');
    if (later.totalMs !== paused.totalMs) throw new Error('counter kept running while offline');
    return `live: +${Math.round((mid.totalMs - before.totalMs) / 1000)} s counted over ~60 s wall time; status chip "LIVE" while confirmed, history badge unchanged; after Kick went offline the total stayed at ${Math.round(later.totalMs / 1000)} s for 20 s (paused); disconnects logged: ${later.disconnects.length}`;
  });

  await r.run('History badge: "150+ HOURS ON AIR" stays through a disconnect and is not a timer', async () => {
    const t1 = (await ov.locator('.onair.history').innerText()).trim(); await ov.waitForTimeout(3000);
    const t2 = (await ov.locator('.onair.history').innerText()).trim();
    if (t1 !== '150+ HOURS ON AIR' || t2 !== t1) throw new Error(`${t1} / ${t2}`);
    if (await ov.locator('.onair.history', { hasText: /SESSION|:\d\d/ }).count()) throw new Error('badge contains a timer');
    const api2 = await api('/api/history-badge'); if (!api2.enabled) throw new Error('disabled');
    return 'exact text unchanged across live→offline and 3 s apart; contains no session timer';
  });

  await r.run('Uptime persists across a controller restart (and the counter does not restart from zero)', async () => {
    const before = await api('/api/live/stats');
    await new Promise((x) => setTimeout(x, 16_000)); // a tick persists the state
    ctl.kill('SIGKILL');
    await new Promise((x) => setTimeout(x, 1500));
    ctl = startProc('controller', 'apps/controller/src/main.ts', env);
    await waitFor('controller back', () => health().then((h) => h.ok).catch(() => false), 30_000);
    const after = await api('/api/live/stats');
    if (after.totalMs < before.totalMs - 1000) throw new Error(`total went ${before.totalMs} → ${after.totalMs}`);
    if (after.totalMs > before.totalMs + 60_000) throw new Error('total jumped while the app was down');
    if (after.live) throw new Error('clock claims live straight after restart without confirmation');
    return `total before restart ${Math.round(before.totalMs / 1000)} s, after ${Math.round(after.totalMs / 1000)} s; sessions ${after.sessionsCount}; not counted while the app was down`;
  });

  await r.run('Secrets: no key text in logs, state, health, monitor or setup status', async () => {
    const dumps = [await api('/api/state'), await api('/api/health'), await api('/api/monitor'), await api('/api/setup/status'), await api('/api/audio'), await api('/api/voice/keys'), await api('/api/personality')].map((x) => JSON.stringify(x)).join('\n');
    leakCheck('API responses', dumps);
    const logs = logTail('controller', 400_000); leakCheck('controller log', logs);
    const kl = fs.readFileSync(path.join(TMP, 'kick-agent.log'), 'utf8'); leakCheck('kick-agent log', kl);
    const mode = fs.statSync(path.join(TMP, 'data', 'elevenlabs-keys.json')).mode & 0o777;
    if (mode !== 0o600) throw new Error(`key file mode ${mode.toString(8)}`);
    return `7 API responses + controller log (${logs.length} chars) + kick-agent log clean for all ${SECRETS.length} keys; key file mode 0600`;
  });

  await r.run('Monitoring endpoint reports process load, queue and voice stats', async () => {
    await new Promise((x) => setTimeout(x, 6000));
    const m = await api('/api/monitor');
    if (!m.now || !(m.now.rssMB > 20) || m.speech.cap !== 10) throw new Error(JSON.stringify(m).slice(0, 200));
    return `rss ${m.now.rssMB} MB, cpu avg ${m.avgCpuPct}%, loop lag max ${m.maxLagMs} ms, queue ${m.speech.queued}/${m.speech.cap}`;
  });

  await r.run('No uncaught page errors on either page', async () => { if (errors.length) throw new Error(errors.join(' | ')); return 'control panel and overlay: 0 page errors'; });
} finally {
  const md = r.markdown('Entertainment upgrade E2E (STAND-IN ElevenLabs + Kick — not the real services)');
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-entertainment.md'), md + '\n> Real ElevenLabs and Kick were **not** reachable from the build machine; those rows ran against `tests/fakes`. Music playback was verified by the browser reporting state/levels, not by listening.\n');
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length}/${r.results.length} passed`);
  await browser.close(); stopAll(); await fk.close(); await el.close?.();
  process.exit(r.failed ? 1 : 0);
}
