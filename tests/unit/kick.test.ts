// Kick API client against the STAND-IN server (tests/fakes/fakeKick.ts) — proves our code, not Kick's real service.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startFakeKick } from '../fakes/fakeKick.ts';
import { KickApi, KickError, verifyKickSignature, KICK_PUBLIC_KEY_FALLBACK } from '../../packages/shared/src/kick.ts';
import crypto from 'node:crypto';

let fk: Awaited<ReturnType<typeof startFakeKick>>; let api: KickApi; let tokenFile: string;
beforeAll(async () => {
  fk = await startFakeKick();
  process.env.KICK_API_BASE = fk.apiBase; process.env.KICK_AUTH_BASE = fk.authBase;
  tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kick-')), 'tok.json');
  api = new KickApi({ clientId: fk.clientId, clientSecret: fk.clientSecret, tokenFile });
});
afterAll(async () => { await fk.close(); });

describe('Kick OAuth 2.1 + PKCE (stand-in server)', () => {
  it('authorize URL carries PKCE S256 and requested scopes', () => {
    const p = KickApi.pkce(); const u = new URL(api.authorizeUrl('http://localhost:8787/api/kick/callback', ['user:read', 'chat:write'], p.challenge, p.state));
    expect(u.pathname).toBe('/oauth/authorize'); expect(u.searchParams.get('code_challenge_method')).toBe('S256'); expect(u.searchParams.get('scope')).toBe('user:read chat:write'); expect(u.searchParams.get('code_challenge')).toBe(p.challenge);
  });
  it('exchanges a code with the right verifier, stores the token owner-only, never exposes it in accounts()', async () => {
    const p = KickApi.pkce(); const code = fk.authorize(p.challenge);
    const t = await api.exchangeCode('broadcaster', code, 'http://localhost/cb', p.verifier);
    expect(t.username).toBe('HubieBot');
    expect(JSON.stringify(api.accounts())).not.toContain(t.access_token);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
  it('rejects a wrong PKCE verifier and a wrong client secret with readable errors', async () => {
    const p = KickApi.pkce(); const code = fk.authorize(p.challenge);
    await expect(api.exchangeCode('bot', code, 'x', 'wrong-verifier')).rejects.toBeInstanceOf(KickError);
    const bad = new KickApi({ clientId: fk.clientId, clientSecret: 'nope', tokenFile });
    await expect(bad.exchangeCode('bot', fk.authorize(p.challenge), 'x', p.verifier)).rejects.toThrow();
  });
  it('refreshes an expiring token automatically and retries a 401 once', async () => {
    const s = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); s.broadcaster.expires_at = Date.now() + 1000; fs.writeFileSync(tokenFile, JSON.stringify(s));
    const before = fk.st.tokenRequests.filter((r) => r.grant === 'refresh_token').length;
    await api.me('broadcaster');
    expect(fk.st.tokenRequests.filter((r) => r.grant === 'refresh_token').length).toBe(before + 1);
    // revoke server-side → 401 → forced refresh → ok
    fk.st.tokens.clear(); const s2 = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); fk.st.refreshes.set(s2.broadcaster.refresh_token, 'x');
    await expect(api.me('broadcaster')).resolves.toMatchObject({ name: 'HubieBot' });
  });
});

describe('Kick REST (stand-in server)', () => {
  it('channel lookup, live status, category search, title update', async () => {
    const ch = await api.channelBySlug(fk.slug); expect(Number(ch.broadcaster_user_id)).toBe(fk.bId);
    expect(await api.livestream(fk.bId)).toBeNull(); fk.st.live = true; expect((await api.livestream(fk.bId))?.viewer_count).toBe(12); fk.st.live = false;
    expect((await api.searchCategories('slots'))[0].name).toContain('Slots');
    await api.updateChannel({ stream_title: 'New title', category_id: 28 }); expect(fk.st.channel.stream_title).toBe('New title');
  });
  it('sends chat (reply id, 500-char cap) and reports 429 as a rate-limit error', async () => {
    await api.sendChat('x'.repeat(900), fk.bId, 'abc'); expect(fk.st.sent.at(-1)!.content.length).toBe(500); expect(fk.st.sent.at(-1)!.reply).toBe('abc');
    fk.st.rateLimitChat = 1; await expect(api.sendChat('hi', fk.bId)).rejects.toMatchObject({ status: 429 });
    fk.st.failChat = 1; await expect(api.sendChat('hi', fk.bId)).rejects.toMatchObject({ status: 500 });
  });
  it('moderation: delete message and timeout', async () => {
    await api.deleteMessage('bad-1'); await api.timeout(fk.bId, 55, 5, 'rules');
    expect(fk.st.deleted).toContain('bad-1'); expect(fk.st.bans.at(-1)).toMatchObject({ user_id: 55, duration: 5 });
  });
  it('event subscriptions (app token, client_credentials)', async () => {
    await api.subscribe(fk.bId, ['chat.message.sent', 'livestream.status.updated']);
    expect((await api.listSubscriptions()).map((s: any) => s.event).sort()).toEqual(['chat.message.sent', 'livestream.status.updated']);
    await api.unsubscribe(['sub1']); expect((await api.listSubscriptions()).length).toBe(1);
  });
  it('fetches the signature public key', async () => { expect(await api.publicKey()).toBe(fk.publicPem); });
});

describe('webhook signature verification', () => {
  const body = Buffer.from('{"hello":"world"}');
  it('accepts a correct signature, rejects tampering, wrong key and garbage', () => {
    const sign = (b: Buffer) => { const { publicKey, privateKey } = (sign as any).kp ??= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), sig: crypto.sign('sha256', Buffer.concat([Buffer.from('id1.2026-01-01T00:00:00Z.'), b]), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64') }; };
    const { pem, sig } = sign(body);
    expect(verifyKickSignature(pem, 'id1', '2026-01-01T00:00:00Z', body, sig)).toBe(true);
    expect(verifyKickSignature(pem, 'id1', '2026-01-01T00:00:00Z', Buffer.from('{"hello":"w0rld"}'), sig)).toBe(false);
    expect(verifyKickSignature(pem, 'id2', '2026-01-01T00:00:00Z', body, sig)).toBe(false);
    expect(verifyKickSignature(KICK_PUBLIC_KEY_FALLBACK, 'id1', '2026-01-01T00:00:00Z', body, sig)).toBe(false);
    expect(verifyKickSignature(pem, 'id1', 'x', body, 'not-base64!!')).toBe(false);
  });
});
