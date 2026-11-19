/**
 * STAND-IN for ElevenLabs (NOT ElevenLabs itself — api.elevenlabs.io is unreachable from the build machine).
 * Implements the documented shapes Hubie uses: GET /v1/voices, POST /v1/text-to-speech/{voice_id} (xi-api-key header,
 * JSON body {text, model_id, voice_settings}) returning real MP3 audio (espeak-ng → ffmpeg) so the browser, lip-sync and OBS
 * routing are exercised with real audio. Special keys: sk_invalid… → 401 invalid_api_key, sk_noperm… → 401 missing_permissions,
 * sk_noquota… → 402. Every request is recorded so tests can assert exactly what Hubie sent.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
export interface ElRequest { method: string; path: string; key: string; body: any; at: number }
export const FAKE_VOICES = [
  { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', category: 'premade', labels: { accent: 'australian', age: 'young', descriptive: 'hyped' } },
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', labels: { accent: 'british', age: 'middle_aged', descriptive: 'warm' } },
  { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', category: 'premade', labels: { accent: 'american', age: 'young', descriptive: 'playful' } },
  { voice_id: 'zzzzzzzzzzzzzzzzzzzz', name: 'Robot Gary', category: 'generated', labels: {} },
];

export async function startFakeElevenLabs(port = 0) {
  const requests: ElRequest[] = [];
  let failNext: { n: number; status: number } = { n: 0, status: 500 };
  /** accounts: keys named sk_acct_<account>_<suffix> all draw on ONE allowance (like keys on one ElevenLabs account). */
  const accounts = new Map<string, { limit: number; used: number; reset: number }>();
  const acctOf = (key: string) => key.match(/^sk_acct_([a-z0-9]+)_/)?.[1];
  const rate = new Map<string, number>(); // key prefix sk_ratelimit… → N more 429s
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-el-'));
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const key = String(req.headers['xi-api-key'] ?? '');
      let body: any = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push({ method: req.method ?? '', path: url.pathname + url.search, key, body, at: Date.now() });
      const json = (c: number, b: unknown) => res.writeHead(c, { 'content-type': 'application/json' }).end(JSON.stringify(b));
      if (!key) return json(401, { detail: { status: 'needs_authorization', message: 'Needs authorization' } });
      if (key.startsWith('sk_invalid')) return json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      if (key.startsWith('sk_noperm')) return json(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_read' } });
      if (key.startsWith('sk_noquota')) return json(402, { detail: { status: 'payment_required', message: 'quota exceeded' } });
      if (key.startsWith('sk_quota401')) return json(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000. You have 12 credits remaining, while 40 credits are required for this request.' } });
      if (key.startsWith('sk_ratelimit') && (rate.get(key) ?? 1) > 0) { rate.set(key, (rate.get(key) ?? 1) - 1); return json(429, { detail: { status: 'too_many_concurrent_requests', message: 'rate limited' } }); }
      const ac = acctOf(key);
      if (url.pathname === '/v1/user/subscription' && req.method === 'GET') {
        if (key.startsWith('sk_nouser')) return json(401, { detail: { status: 'missing_permissions', message: 'missing user_read' } });
        const a = ac ? accounts.get(ac) : undefined;
        return json(200, a ? { tier: 'creator', character_count: a.used, character_limit: a.limit, next_character_count_reset_unix: a.reset } : { tier: 'free', character_count: 0, character_limit: 10000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 86400 * 20 });
      }
      if (url.pathname === '/v1/voices' && req.method === 'GET') return json(200, { voices: FAKE_VOICES });
      const m = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)$/);
      if (m && req.method === 'POST') {
        if (failNext.n > 0) { failNext.n--; return json(failNext.status, { detail: { status: 'server_error', message: 'injected failure' } }); }
        if (ac) {
          const a = accounts.get(ac) ?? (accounts.set(ac, { limit: 100000, used: 0, reset: Math.floor(Date.now() / 1000) + 86400 * 20 }), accounts.get(ac)!);
          const len = String(body.text ?? '').length;
          if (a.used + len > a.limit) return json(401, { detail: { status: 'quota_exceeded', message: `This request exceeds your quota of ${a.limit}. You have ${Math.max(0, a.limit - a.used)} credits remaining, while ${len} credits are required for this request.` } });
          a.used += len;
        }
        if (!FAKE_VOICES.some((v) => v.voice_id === m[1])) return json(404, { detail: { status: 'voice_not_found', message: 'A voice with the voice_id was not found.' } });
        if (typeof body.text !== 'string' || !body.text || !body.model_id) return json(422, { detail: [{ msg: 'text and model_id required' }] });
        try {
          const delay = Number(process.env.FAKE_EL_DELAY_MS || 0); if (delay) await new Promise((r) => setTimeout(r, delay));
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const wav = path.join(tmp, `${id}.wav`), mp3 = path.join(tmp, `${id}.mp3`);
          const speed = Number(body.voice_settings?.speed ?? 1);
          const pitch = Math.round(40 + Number(body.voice_settings?.style ?? 0) * 30);
          await execFileP('espeak-ng', ['-v', 'en-us+m3', '-s', String(Math.round(165 * speed)), '-p', String(pitch), '-w', wav, body.text]);
          await execFileP('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k', '-ar', '44100', mp3]);
          const buf = fs.readFileSync(mp3); fs.rmSync(wav, { force: true }); fs.rmSync(mp3, { force: true });
          return void res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(buf);
        } catch (e) { return json(500, { detail: { status: 'server_error', message: (e as Error).message } }); }
      }
      json(404, { detail: { status: 'not_found', message: `Unknown path ${url.pathname}` } });
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const p = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${p}`, requests,
    ttsRequests: () => requests.filter((r) => r.path.startsWith('/v1/text-to-speech/')),
    failNext: (n: number, status = 500) => { failNext = { n, status }; },
    setAccount: (name: string, limit: number, used = 0) => accounts.set(name, { limit, used, reset: Math.floor(Date.now() / 1000) + 86400 * 20 }),
    exhaust: (name: string) => { const a = accounts.get(name) ?? { limit: 100000, used: 0, reset: Math.floor(Date.now() / 1000) + 86400 * 20 }; a.used = a.limit; accounts.set(name, a); },
    rateLimit: (key: string, n: number) => rate.set(key, n),
    accountUsed: (name: string) => accounts.get(name)?.used ?? 0,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
