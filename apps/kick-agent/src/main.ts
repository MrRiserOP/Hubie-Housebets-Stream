/**
 * Kick agent: Kick chat in (official signed webhooks) + chat out (official REST), live status, channel title/category,
 * moderation and subscription upkeep. (The public webhook address is managed by the controller — apps/controller/src/tunnel.ts.)
 *
 * Why webhooks: Kick's supported way to receive chat is the `chat.message.sent` webhook event. Kick POSTs every chat
 * message to a public HTTPS address set in your Kick developer app. This process listens ONLY for those signed POSTs
 * (on 127.0.0.1:8788 by default) — the Control Center itself is never exposed.
 */
import http from 'node:http';
import { HubClient, makeLogger, env, envBool, envNum, DATA_DIR, Backoff, sleep } from '../../../packages/shared/src/node.ts';
import { KickApi, KickError, kickTokenFile, verifyKickSignature, KICK_PUBLIC_KEY_FALLBACK } from '../../../packages/shared/src/kick.ts';
import type { KickStreamStatus } from '../../../packages/shared/src/protocol.ts';

const log = makeLogger('kick-agent');
const hub = new HubClient('kick-agent', log).start();
hub.on((m) => { if (m.type === 'reload_config') { log.info(`reloading: ${m.reason}`); setTimeout(() => process.exit(0), 300); } });
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

const slug = env('KICK_CHANNEL').trim().toLowerCase();
const clientId = env('KICK_CLIENT_ID'), clientSecret = env('KICK_CLIENT_SECRET');
const WEBHOOK_PORT = envNum('KICK_WEBHOOK_PORT', 8788);
const WEBHOOK_BIND = env('KICK_WEBHOOK_BIND', '127.0.0.1');
const EVENTS = ['chat.message.sent', 'livestream.status.updated'];

let status: { s: 'ok' | 'degraded' | 'down' | 'disabled'; d: string } = { s: 'down', d: 'starting' };
const beat = (s: typeof status.s, d: string) => { status = { s, d }; hub.heartbeat('kick', s, d); };
setInterval(() => hub.heartbeat('kick', status.s, status.d), 10_000).unref();

if (!envBool('KICK_ENABLED')) {
  log.info('KICK_ENABLED=false — Kick agent idle');
  beat('disabled', 'Kick is turned off');
} else if (!clientId || !clientSecret || !slug) {
  const missing = [!clientId && 'Client ID', !clientSecret && 'Client Secret', !slug && 'channel name'].filter(Boolean).join(', ');
  log.warn(`Kick not configured: missing ${missing}`);
  beat('down', `Not configured — missing ${missing} (Control Center → 4)`);
} else {
  void run();
}

async function run() {
  const api = new KickApi({ clientId, clientSecret, tokenFile: kickTokenFile(DATA_DIR), log: (m) => log.info(m) });
  const act: { lastIn?: { user: string; text: string; at: number; id?: string }; lastOut?: { text: string; at: number; ok: boolean; error?: string; test?: boolean }; webhook: { received: number; rejected: number; lastAt?: number; lastError?: string }; subscriptions: string[]; subCheckedAt?: number; subError?: string; authError?: string } = { webhook: { received: 0, rejected: 0 }, subscriptions: [] };
  let broadcasterId = 0, chatUserId = 0, account = '';
  const report = () => hub.send({ type: 'kick_activity', ...act, account, channel: slug, broadcasterId });

  /* ---- who are we, which channel ---- */
  const resolve = async () => {
    const slot = api.chatSlot();
    const acc = api.accounts()[slot];
    account = acc?.username ?? '';
    chatUserId = acc?.userId ?? 0;
    const ch = await api.channelBySlug(slug, 'app').catch(() => (api.hasUser('broadcaster') ? api.channelBySlug(slug, 'broadcaster') : null));
    if (!ch) throw new KickError(404, `Kick channel "${slug}" was not found. Check the channel name (Control Center → 4).`);
    broadcasterId = Number(ch.broadcaster_user_id);
  };
  const startBackoff = new Backoff(5000, 120_000);
  while (true) {
    try { await resolve(); break; }
    catch (e) { const d = startBackoff.next() ?? 120_000; beat('down', (e as Error).message); log.error(`Kick setup failed: ${(e as Error).message}; retry in ${d}ms`); await sleep(d); }
  }
  log.info(`Kick channel ${slug} (broadcaster ${broadcasterId}); chat account: ${account || '(not connected — Hubie can read but not post)'}`);

  /* ---- webhook receiver (chat in + live status) ---- */
  let pubKey = KICK_PUBLIC_KEY_FALLBACK;
  api.publicKey().then((k) => { pubKey = k; }).catch((e) => log.warn(`using built-in Kick public key (${(e as Error).message})`));
  const seen = new Set<string>();
  const remember = (id: string) => { seen.add(id); if (seen.size > 5000) seen.delete(seen.values().next().value!); };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/kick/webhook') { res.writeHead(404).end(); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }).end('Hubie Kick webhook is reachable.'); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 256_000) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const h = (n: string) => String(req.headers[n] ?? '');
      const id = h('kick-event-message-id'), ts = h('kick-event-message-timestamp'), sig = h('kick-event-signature'), type = h('kick-event-type');
      const age = Math.abs(Date.now() - Date.parse(ts));
      if (!id || !sig || !ts || !(age < 5 * 60_000) || !verifyKickSignature(pubKey, id, ts, raw, sig)) {
        act.webhook.rejected++; act.webhook.lastError = !sig ? 'unsigned request' : !(age < 5 * 60_000) ? 'old or invalid timestamp' : 'bad signature';
        log.warn(`rejected webhook: ${act.webhook.lastError}`); report();
        res.writeHead(401).end(); return;
      }
      res.writeHead(200).end('ok'); // acknowledge fast; Kick retries otherwise
      if (seen.has(id)) return; // at-least-once delivery
      remember(id);
      act.webhook.received++; act.webhook.lastAt = Date.now();
      let p: any = {}; try { p = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (type === 'chat.message.sent') onChat(p);
      else if (type === 'livestream.status.updated') { setLive({ checkedAt: Date.now(), live: !!p.is_live, title: p.title, startedAt: p.started_at }); }
      report();
    });
  });
  server.on('error', (e) => { log.error(`webhook listener: ${e.message}`); beat('down', `Cannot listen for Kick events on port ${WEBHOOK_PORT}: ${e.message}`); });
  server.listen(WEBHOOK_PORT, WEBHOOK_BIND, () => log.info(`listening for Kick webhooks on http://${WEBHOOK_BIND}:${WEBHOOK_PORT}/kick/webhook`));

  /**
   * Hubie's own messages must not be answered. With a separate chat account that is simply "sent by that account".
   * When Hubie posts as the channel owner, the owner's OWN typing ("hi Hubie") must still reach Hubie, so only messages that
   * Kick confirmed as ours (message id) or that match something we sent in the last minute are skipped.
   */
  const sentIds = new Set<string>(); const sentTexts: Array<{ t: string; at: number }> = [];
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const rememberSent = (text: string, id?: string) => { if (id) { sentIds.add(id); if (sentIds.size > 200) sentIds.delete(sentIds.values().next().value!); } sentTexts.push({ t: norm(text.slice(0, 500)), at: Date.now() }); while (sentTexts.length > 30) sentTexts.shift(); };
  function isOwnMessage(id: string, senderId: number, text: string) {
    if (sentIds.has(id)) return true;
    if (!chatUserId || senderId !== chatUserId) return false;
    if (api.chatSlot() === 'bot') return true;
    const n = norm(text);
    return sentTexts.some((x) => Date.now() - x.at < 90_000 && x.t === n);
  }
  function onChat(p: any) {
    if (Number(p.broadcaster?.user_id) !== broadcasterId) return;
    const senderId = Number(p.sender?.user_id);
    const user = String(p.sender?.username ?? 'viewer');
    const text = String(p.content ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1');
    if (isOwnMessage(String(p.message_id), senderId, text)) return;
    act.lastIn = { user, text: text.slice(0, 200), at: Date.now(), id: String(p.message_id) };
    hub.send({ type: 'chat_in', message: { id: String(p.message_id), user, userId: String(senderId), text, at: Date.now(), source: 'kick', badges: (p.sender?.identity?.badges ?? []).map((b: any) => b.type ?? b.text).filter(Boolean) } });
  }

  /* ---- keep event subscriptions alive (Kick drops them after a day of failed deliveries) ---- */
  const ensureSubs = async () => {
    try {
      const subs: any[] = await api.listSubscriptions();
      const mine = subs.filter((s) => Number(s.broadcaster_user_id) === broadcasterId);
      const have = new Set(mine.map((s) => s.event));
      const missing = EVENTS.filter((e) => !have.has(e));
      if (missing.length) { await api.subscribe(broadcasterId, missing); log.info(`subscribed to ${missing.join(', ')}`); }
      act.subscriptions = (await api.listSubscriptions()).filter((x: any) => Number(x.broadcaster_user_id) === broadcasterId).map((x: any) => String(x.event)).filter((e: string) => EVENTS.includes(e));
      act.subCheckedAt = Date.now();
      if (!act.subscriptions.includes('chat.message.sent')) throw new KickError(0, 'Kick did not keep the chat subscription — check that webhooks are enabled in your Kick app and the address is saved there.');
      act.subError = undefined; act.authError = undefined;
    } catch (e) { noteError(e); act.subError = (e as Error).message; log.warn(`event subscription: ${act.subError}`); }
    report();
  };

  /** A 401 after a refresh attempt means the saved Kick login is no longer valid — say so plainly. */
  function noteError(e: unknown) { if (e instanceof KickError && e.status === 401) act.authError = e.message; }

  /* ---- live status (Kick API is the only source of truth for "LIVE") ---- */
  let live: KickStreamStatus = { checkedAt: 0, live: false };
  function setLive(s: KickStreamStatus) { live = { ...live, ...s }; hub.send({ type: 'kick_status', status: live }); }
  const pollLive = async () => {
    try {
      const failures: Error[] = [];
      const [ls, ch] = await Promise.all([api.livestream(broadcasterId).catch((e) => { failures.push(e); return null; }), api.channelBySlug(slug, 'app').catch((e) => { failures.push(e); return null; })]);
      if (failures.length === 2) throw failures[0]; // both calls failed → Kick is unreachable; do not pretend we know the live state
      setLive({ checkedAt: Date.now(), live: !!ls || !!ch?.stream?.is_live, title: ch?.stream_title ?? ls?.stream_title, category: ch?.category?.name ?? ls?.category?.name, viewers: ls?.viewer_count ?? ch?.stream?.viewer_count, startedAt: ls?.started_at, error: undefined });
      const canSend = !!account;
      beat(canSend ? 'ok' : 'degraded', `#${slug}${account ? ` · chat as ${account}` : ' · no chat account connected'}${act.subError ? ' · chat reading not set up' : ''} · ${live.live ? `LIVE (${live.viewers ?? 0} viewers)` : 'offline'}`);
    } catch (e) { setLive({ checkedAt: Date.now(), live: false, error: (e as Error).message }); beat('degraded', `Kick API: ${(e as Error).message}`); }
  };

  /* ---- chat out (rate-limited) ---- */
  const minGap = envNum('KICK_MIN_SEND_INTERVAL_SEC', 3) * 1000;
  const queue: Array<{ text: string; replyTo?: string; test?: boolean }> = [];
  let lastSend = 0;
  setInterval(async () => {
    if (!queue.length || Date.now() - lastSend < minGap) return;
    const item = queue.shift()!;
    lastSend = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { rememberSent(item.text); const r = await api.sendChat(item.text, broadcasterId, item.replyTo); rememberSent(item.text, r?.message_id ? String(r.message_id) : undefined); act.lastOut = { text: item.text, at: Date.now(), ok: true, test: item.test }; act.authError = undefined; log.info(`sent: ${item.text}`); break; }
      catch (e) {
        const transient = e instanceof KickError ? e.status >= 500 || e.status === 429 : true;
        if (attempt === 0 && transient) { await sleep(1500); continue; }
        noteError(e);
        act.lastOut = { text: item.text, at: Date.now(), ok: false, error: (e as Error).message.slice(0, 200), test: item.test };
        log.warn(`send failed: ${act.lastOut.error}`);
      }
    }
    report();
  }, 400).unref();

  hub.on(async (m) => {
    if (m.type === 'chat_out') { queue.push({ text: m.text, replyTo: m.replyTo }); if (queue.length > 4) queue.shift(); }
    if (m.type === 'estop' && m.on) queue.length = 0;
    if (m.type !== 'kick_command') return;
    try {
      if (m.command === 'update_channel') { await api.updateChannel({ ...(m.title ? { stream_title: m.title } : {}), ...(m.categoryId ? { category_id: m.categoryId } : {}) }); log.info('channel title/category updated'); await pollLive(); }
      if (m.command === 'delete_message' && m.messageId) { await api.deleteMessage(m.messageId); log.info(`moderation: deleted message ${m.messageId}`); }
      if (m.command === 'timeout' && m.userId) { await api.timeout(broadcasterId, m.userId, m.minutes ?? 5, m.reason ?? 'chat rules'); log.info(`moderation: timed out user ${m.userId}`); }
      if (m.command === 'resubscribe') await ensureSubs();
      if (m.command === 'status') await pollLive();
      if (m.command === 'send_test') queue.unshift({ text: m.text || 'Hubie test message ✔', test: true }); lastSend = 0;
      hub.send({ type: 'kick_activity', ...act, account, channel: slug, broadcasterId });
    } catch (e) { hub.send({ type: 'log', level: 'warn', msg: `Kick ${m.command} failed: ${(e as Error).message}`, from: 'kick-agent' }); act.subError = m.command === 'resubscribe' ? (e as Error).message : act.subError; report(); }
  });

  await pollLive();
  await ensureSubs();
  report();
  setInterval(pollLive, 30_000).unref();
  setInterval(ensureSubs, 30 * 60_000).unref();
}
