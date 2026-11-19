/**
 * STAND-IN for Kick (NOT Kick itself). Implements the documented shapes of the endpoints Hubie uses so the wiring can be
 * tested offline: OAuth token endpoint (PKCE checked), REST under /public/v1, and signed webhook delivery using a
 * throw-away RSA key (Kick's real key is never involved). Passing tests against this prove Hubie's code paths, NOT that Kick
 * accepts the credentials of a real account.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export interface FakeKickOpts { clientId?: string; clientSecret?: string; slug?: string; broadcasterId?: number }
export async function startFakeKick(o: FakeKickOpts = {}) {
  const clientId = o.clientId ?? 'fake-client-id', clientSecret = o.clientSecret ?? 'fake-client-secret', slug = o.slug ?? 'hubietest', bId = o.broadcasterId ?? 4242;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const st = {
    codes: new Map<string, { challenge: string }>(), tokens: new Map<string, { kind: 'user' | 'app'; scope: string }>(), refreshes: new Map<string, string>(),
    tokenRequests: [] as Array<{ grant: string; ok: boolean }>, sent: [] as Array<{ content: string; reply?: string; auth: string }>, deleted: [] as string[], bans: [] as any[],
    subs: [] as Array<{ id: string; event: string; broadcaster_user_id: number }>, channel: { stream_title: 'Hubie', category: { id: 1, name: 'Just Chatting' } } as any,
    scope: 'user:read channel:read chat:write events:subscribe moderation:chat_message:manage moderation:ban channel:write', subError: '' as string, live: false, failChat: 0, rateLimitChat: 0, expireNext: false, apiDown: false, requests: [] as string[],
  };
  const sign = (id: string, ts: string, body: string) => crypto.sign('sha256', Buffer.from(`${id}.${ts}.${body}`), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
  const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  let n = 0;
  const mint = (kind: 'user' | 'app', scope: string) => { const t = `fk_${kind}_${++n}_${crypto.randomBytes(6).toString('hex')}`; st.tokens.set(t, { kind, scope }); return t; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname;
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    st.requests.push(`${req.method} ${p}`);
    if (st.apiDown) { req.destroy(); return; }
    if (p === '/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req)); const grant = f.get('grant_type') ?? '';
      const okClient = f.get('client_id') === clientId && f.get('client_secret') === clientSecret;
      if (!okClient) { st.tokenRequests.push({ grant, ok: false }); return json(401, { error: 'invalid_client' }); }
      if (grant === 'authorization_code') {
        const c = st.codes.get(f.get('code') ?? '');
        const v = f.get('code_verifier') ?? '';
        if (!c || crypto.createHash('sha256').update(v).digest('base64url') !== c.challenge) { st.tokenRequests.push({ grant, ok: false }); return json(400, { error: 'invalid_grant' }); }
        st.codes.delete(f.get('code')!);
        const t = mint('user', st.scope); const rt = `fr_${++n}`; st.refreshes.set(rt, t);
        st.tokenRequests.push({ grant, ok: true });
        return json(200, { access_token: t, refresh_token: rt, expires_in: st.expireNext ? 1 : 3600, token_type: 'Bearer', scope: st.scope });
      }
      if (grant === 'refresh_token') {
        if (!st.refreshes.has(f.get('refresh_token') ?? '')) { st.tokenRequests.push({ grant, ok: false }); return json(400, { error: 'invalid_grant' }); }
        const t = mint('user', st.scope); const rt = `fr_${++n}`; st.refreshes.set(rt, t);
        st.tokenRequests.push({ grant, ok: true });
        return json(200, { access_token: t, refresh_token: rt, expires_in: 3600, scope: st.scope });
      }
      if (grant === 'client_credentials') { st.tokenRequests.push({ grant, ok: true }); return json(200, { access_token: mint('app', ''), expires_in: 3600, token_type: 'Bearer' }); }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (!p.startsWith('/public/v1')) return json(404, {});
    const api = p.slice('/public/v1'.length);
    if (api === '/public-key') return json(200, { data: { public_key: publicPem } });
    const tok = st.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!tok) return json(401, { message: 'Unauthorized' });
    const body = ['POST', 'PATCH'].includes(req.method ?? '') ? JSON.parse((await readBody(req)) || '{}') : {};
    if (api === '/users') return json(200, { data: [{ user_id: 777, name: 'HubieBot' }] });
    if (api === '/channels' && req.method === 'GET') return json(200, { data: [{ broadcaster_user_id: bId, slug, ...st.channel, stream: { is_live: st.live, viewer_count: st.live ? 12 : 0 } }] });
    if (api === '/channels' && req.method === 'PATCH') { if (body.stream_title) st.channel.stream_title = body.stream_title; if (body.category_id) st.channel.category = { id: body.category_id, name: 'Slots & Casino' }; return json(204, {}); }
    if (api === '/categories') return json(200, { data: [{ id: 28, name: 'Slots & Casino' }, { id: 1, name: 'Just Chatting' }] });
    if (api === '/livestreams') return json(200, { data: st.live ? [{ broadcaster_user_id: bId, stream_title: st.channel.stream_title, viewer_count: 12, started_at: new Date().toISOString() }] : [] });
    if (api === '/chat' && req.method === 'POST') {
      if (st.rateLimitChat > 0) { st.rateLimitChat--; return json(429, {}); }
      if (st.failChat > 0) { st.failChat--; return json(500, { message: 'boom' }); }
      st.sent.push({ content: body.content, reply: body.reply_to_message_id, auth: req.headers.authorization ?? '' });
      return json(200, { data: { is_sent: true, message_id: `m${st.sent.length}` } });
    }
    if (api.startsWith('/chat/') && req.method === 'DELETE') { st.deleted.push(decodeURIComponent(api.slice(6))); return json(204, {}); }
    if (api === '/moderation/bans' && req.method === 'POST') { st.bans.push(body); return json(200, {}); }
    if (api === '/events/subscriptions') {
      if (req.method === 'GET') return json(200, { data: st.subs });
      if (req.method === 'POST') { if (st.subError) return json(200, { data: body.events.map((e: any) => ({ name: e.name, version: e.version, error: st.subError })) }); for (const e of body.events) st.subs.push({ id: `sub${st.subs.length + 1}`, event: e.name, broadcaster_user_id: body.broadcaster_user_id }); return json(200, { data: st.subs }); }
      if (req.method === 'DELETE') { const ids = url.searchParams.getAll('id'); st.subs = st.subs.filter((s) => !ids.includes(s.id)); return json(204, {}); }
    }
    json(404, { message: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  const origin = `http://127.0.0.1:${port}`;

  /** Deliver a webhook to Hubie's listener, signed by the stand-in key (or tampered on purpose). */
  async function deliver(targetUrl: string, type: string, payload: unknown, opt: { id?: string; badSig?: boolean; ts?: string; unsigned?: boolean } = {}) {
    const id = opt.id ?? crypto.randomUUID(), ts = opt.ts ?? new Date().toISOString(), body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'kick-event-message-id': id, 'kick-event-message-timestamp': ts, 'kick-event-type': type, 'kick-event-version': '1' };
    if (!opt.unsigned) headers['kick-event-signature'] = opt.badSig ? sign(id, ts, body + 'x') : sign(id, ts, body);
    return (await fetch(targetUrl, { method: 'POST', headers, body })).status;
  }
  const chatPayload = (user: string, text: string, id: string = crypto.randomUUID(), senderId = 9001) => ({ message_id: id, broadcaster: { user_id: bId, username: slug }, sender: { user_id: senderId, username: user, identity: { badges: [] } }, content: text, emotes: [] });
  const authorize = (challenge: string) => { const code = `code_${++n}`; st.codes.set(code, { challenge }); return code; };
  return { st, port, origin, apiBase: `${origin}/public/v1`, authBase: origin, clientId, clientSecret, slug, bId, publicPem, deliver, chatPayload, authorize, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
