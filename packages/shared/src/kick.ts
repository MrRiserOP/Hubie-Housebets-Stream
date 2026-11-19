/**
 * Kick public API (official): https://docs.kick.com · https://github.com/KickEngineering/KickDevDocs
 *   OAuth 2.1 + PKCE on id.kick.com · REST on api.kick.com/public/v1 · events by signed webhooks.
 * Only documented endpoints are used:
 *   POST id.kick.com/oauth/token                 (authorization_code, refresh_token, client_credentials)
 *   GET  /users                                  (the account behind a user token)
 *   GET  /channels?slug=                         (broadcaster id, title, category, live status; stream key with streamkey:read)
 *   PATCH /channels                              (stream_title, category_id — channel:write)
 *   GET  /categories?q=                          (category search)
 *   GET  /livestreams?broadcaster_user_id=       (is the channel live right now)
 *   POST /chat                                   (send a chat message — chat:write)
 *   DELETE /chat/{message_id}                    (moderation:chat_message:manage)
 *   POST /moderation/bans                        (timeout/ban — moderation:ban)
 *   GET/POST/DELETE /events/subscriptions        (webhook subscriptions — events:subscribe or app token)
 *   GET  /public-key                             (to verify webhook signatures)
 * Tokens are stored in data/kick-tokens.json (owner-only). They are never sent to a browser or logged.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KICK_API = () => process.env.KICK_API_BASE || 'https://api.kick.com/public/v1';
export const KICK_ID = () => process.env.KICK_AUTH_BASE || 'https://id.kick.com';

/** Human names for what each permission is used for (wizard + status). */
export const SCOPE_LABEL: Record<string, string> = {
  'user:read': 'read your account', 'channel:read': 'read channel + live status', 'channel:write': 'update title/category', 'chat:write': 'send chat messages',
  'events:subscribe': 'receive chat events', 'moderation:chat_message:manage': 'remove chat messages', 'moderation:ban': 'time out users',
};
/** Permissions Hubie cannot read/send chat without. */
export const KICK_REQUIRED_SCOPES = ['user:read', 'chat:write', 'events:subscribe'] as const;

/** Scopes per account role (least privilege). */
export const KICK_SCOPES = {
  /** your channel (title, category, live status, chat events) — also posts chat if no separate bot account */
  broadcaster: ['user:read', 'channel:read', 'channel:write', 'chat:write', 'events:subscribe', 'moderation:chat_message:manage', 'moderation:ban'],
  /** optional separate chat account for Hubie's messages */
  bot: ['user:read', 'chat:write'],
} as const;
export type KickSlot = keyof typeof KICK_SCOPES;

export interface KickToken { access_token: string; refresh_token?: string; expires_at: number; scope: string; user_id?: number; username?: string }
interface Store { broadcaster?: KickToken; bot?: KickToken; app?: KickToken }

export class KickError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); this.name = 'KickError'; }
}

export function kickTokenFile(dataDir: string) { return path.join(dataDir, 'kick-tokens.json'); }

export class KickApi {
  constructor(private o: { clientId: string; clientSecret: string; tokenFile: string; log?: (m: string) => void }) {}

  /* ---------------- token storage ---------------- */
  private read(): Store { try { return JSON.parse(fs.readFileSync(this.o.tokenFile, 'utf8')); } catch { return {}; } }
  private write(s: Store) {
    fs.mkdirSync(path.dirname(this.o.tokenFile), { recursive: true });
    const tmp = `${this.o.tokenFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, this.o.tokenFile);
    try { fs.chmodSync(this.o.tokenFile, 0o600); } catch { /* windows */ }
  }
  saveToken(slot: KickSlot, t: KickToken) { const s = this.read(); s[slot] = t; this.write(s); }
  clear(slot: KickSlot) { const s = this.read(); delete s[slot]; this.write(s); }
  /** Public view: who is connected and with which scopes — never the tokens. */
  accounts() {
    const s = this.read();
    const v = (t?: KickToken) => (t ? { username: t.username ?? '', userId: t.user_id, scopes: t.scope.split(' ').filter(Boolean), expiresAt: t.expires_at } : null);
    return { broadcaster: v(s.broadcaster), bot: v(s.bot) };
  }
  hasUser(slot: KickSlot) { return !!this.read()[slot]?.access_token; }

  /* ---------------- OAuth ---------------- */
  static pkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, state: crypto.randomBytes(18).toString('base64url') };
  }
  authorizeUrl(redirectUri: string, scopes: readonly string[], challenge: string, state: string) {
    const q = new URLSearchParams({ client_id: this.o.clientId, response_type: 'code', redirect_uri: redirectUri, state, scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256' });
    return `${KICK_ID()}/oauth/authorize?${q}`;
  }
  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const res = await fetch(`${KICK_ID()}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, ...params }) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new KickError(res.status, explainOAuth(res.status, body), body);
    return body;
  }
  async exchangeCode(slot: KickSlot, code: string, redirectUri: string, verifier: string): Promise<KickToken> {
    const b = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    const tok: KickToken = { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + Number(b.expires_in ?? 3600) * 1000, scope: String(b.scope ?? '') };
    this.saveToken(slot, tok);
    try {
      const me = await this.me(slot);
      if (me) { tok.user_id = me.user_id; tok.username = me.name; this.saveToken(slot, tok); }
    } catch (e) { this.o.log?.(`could not read the connected Kick account: ${(e as Error).message}`); }
    return tok;
  }
  private async fresh(slot: KickSlot | 'app'): Promise<string> {
    const s = this.read();
    if (slot === 'app') {
      if (s.app && s.app.expires_at - Date.now() > 120_000) return s.app.access_token;
      const b = await this.tokenRequest({ grant_type: 'client_credentials' });
      s.app = { access_token: b.access_token, expires_at: Date.now() + Number(b.expires_in ?? 3600) * 1000, scope: String(b.scope ?? '') };
      this.write(s);
      return s.app.access_token;
    }
    const t = s[slot];
    if (!t) throw new KickError(401, `No Kick ${slot} account connected.`);
    if (t.expires_at - Date.now() > 120_000 || !t.refresh_token) return t.access_token;
    let b: any;
    try { b = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }); }
    catch (e) { if (e instanceof KickError && e.status >= 400 && e.status < 500) throw new KickError(401, `Kick login for the ${slot} account expired and could not be renewed — press Reconnect.`, e.body); throw e; }
    const nt: KickToken = { ...t, access_token: b.access_token, refresh_token: b.refresh_token ?? t.refresh_token, expires_at: Date.now() + Number(b.expires_in ?? 3600) * 1000, scope: String(b.scope ?? t.scope) };
    this.saveToken(slot, nt);
    this.o.log?.(`Kick ${slot} token refreshed`);
    return nt.access_token;
  }
  /** Which account sends chat: the bot account if connected, else the broadcaster account. */
  chatSlot(): KickSlot { return this.hasUser('bot') ? 'bot' : 'broadcaster'; }

  /* ---------------- REST ---------------- */
  async req(method: string, p: string, slot: KickSlot | 'app', body?: unknown, retried = false): Promise<any> {
    const token = await this.fresh(slot);
    const res = await fetch(`${KICK_API()}${p}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && !retried && slot !== 'app') {
      // token revoked/expired early → force a refresh once
      const s = this.read(); const t = s[slot]; if (t) { t.expires_at = 0; this.write(s); }
      return this.req(method, p, slot, body, true);
    }
    if (res.status === 429) throw new KickError(429, 'Kick is rate-limiting requests right now; Hubie will slow down.');
    const text = await res.text();
    let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    if (!res.ok) throw new KickError(res.status, `Kick ${method} ${p.split('?')[0]} failed (${res.status}): ${String(json.message ?? text).slice(0, 160)}`, json);
    return json;
  }
  async me(slot: KickSlot): Promise<{ user_id: number; name: string } | null> { return (await this.req('GET', '/users', slot)).data?.[0] ?? null; }
  async channelBySlug(slug: string, slot: KickSlot | 'app' = 'app') { return (await this.req('GET', `/channels?slug=${encodeURIComponent(slug)}`, slot)).data?.[0] ?? null; }
  async myChannel() { return (await this.req('GET', '/channels', 'broadcaster')).data?.[0] ?? null; }
  async livestream(broadcasterId: number) { return (await this.req('GET', `/livestreams?broadcaster_user_id=${broadcasterId}`, 'app')).data?.[0] ?? null; }
  async updateChannel(patch: { stream_title?: string; category_id?: number }) { return this.req('PATCH', '/channels', 'broadcaster', patch); }
  async searchCategories(q: string) { return (await this.req('GET', `/categories?q=${encodeURIComponent(q)}`, 'app')).data ?? []; }
  async sendChat(content: string, broadcasterId: number, replyTo?: string) {
    const r = await this.req('POST', '/chat', this.chatSlot(), { type: 'user', content: content.slice(0, 500), broadcaster_user_id: broadcasterId, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
    if (r.data && r.data.is_sent === false) throw new KickError(400, 'Kick did not deliver the message (is_sent=false).');
    return r.data;
  }
  async deleteMessage(messageId: string) { return this.req('DELETE', `/chat/${encodeURIComponent(messageId)}`, 'broadcaster'); }
  async timeout(broadcasterId: number, userId: number, minutes: number, reason: string) {
    return this.req('POST', '/moderation/bans', 'broadcaster', { broadcaster_user_id: broadcasterId, user_id: userId, duration: minutes, reason });
  }
  /** Event subscriptions use the channel owner's login when it has the events:subscribe permission, otherwise the app token. */
  subscriptionSlot(): KickSlot | 'app' {
    const b = this.accounts().broadcaster;
    return b && b.scopes.includes('events:subscribe') ? 'broadcaster' : 'app';
  }
  async listSubscriptions() { return (await this.req('GET', '/events/subscriptions', this.subscriptionSlot())).data ?? []; }
  /** Kick can answer 200 with an error for one event inside `data` — that is a failure, not a success. */
  async subscribe(broadcasterId: number, events: string[]) {
    const r = await this.req('POST', '/events/subscriptions', this.subscriptionSlot(), { broadcaster_user_id: broadcasterId, events: events.map((name) => ({ name, version: 1 })), method: 'webhook' });
    const bad = (r.data ?? []).filter((d: any) => d?.error);
    if (bad.length) throw new KickError(400, `Kick refused the chat subscription: ${bad.map((d: any) => `${d.name ?? d.event ?? 'event'} — ${d.error}`).join('; ')}. Check that webhooks are enabled in your Kick app (kick.com/settings/developer).`, r);
    return r;
  }
  async unsubscribe(ids: string[]) { if (ids.length) await this.req('DELETE', `/events/subscriptions?${ids.map((i) => `id=${encodeURIComponent(i)}`).join('&')}`, 'app'); }
  async publicKey(): Promise<string> {
    const res = await fetch(`${KICK_API()}/public-key`);
    const j: any = await res.json();
    const k = j.data?.public_key;
    if (!k) throw new Error('Kick public key not available');
    return k;
  }
}

/** Official Kick public key (from KickDevDocs → events/webhook-security). Used if /public-key can't be fetched. */
export const KICK_PUBLIC_KEY_FALLBACK = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

/** Kick webhook signature: RSA PKCS#1 v1.5 + SHA-256 over `${messageId}.${timestamp}.${rawBody}`. */
export function verifyKickSignature(publicKeyPem: string, messageId: string, timestamp: string, rawBody: Buffer, signatureB64: string): boolean {
  try {
    const data = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), rawBody]);
    return crypto.verify('sha256', data, { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

function explainOAuth(status: number, body: any): string {
  const msg = String(body?.error_description ?? body?.message ?? body?.error ?? '').slice(0, 160);
  if (/invalid_client|client/i.test(msg) || status === 401) return `Kick rejected the app credentials — check the Client ID and Client Secret (kick.com/settings/developer). ${msg}`;
  if (/redirect/i.test(msg)) return `Kick rejected the redirect address — it must exactly match the Redirect URL in your Kick app settings. ${msg}`;
  if (/grant|code|verifier/i.test(msg)) return `The login code expired or was already used — press Connect again. ${msg}`;
  return `Kick login failed (${status}). ${msg}`;
}
