/**
 * Voice service. Replaceable providers behind one interface, with a fallback
 * chain, per-provider circuit breaker, disk cache and an hourly usage cap.
 *
 *  elevenlabs — THE voice. ElevenLabs text-to-speech (configurable voice ID + settings, per-emotion delivery).
 *               Key stays on the server. There is no OpenAI voice anywhere in Hubie.
 *  espeak     — local/offline robotic voice. NOT in the default chain; opt-in only.
 *  browser    — no server audio; overlay uses Web Speech (demo mode / last resort).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Emotion } from '../../../packages/shared/src/protocol.ts';
import { UsageLimiter } from '../../ai/src/usage.ts';
import { KeyRing, type KeyEntry, type KeyUsage } from './keyring.ts';
import { DEFAULT_VOICE_ID, DEFAULT_MODEL, PREFERRED_VOICE_NAMES, settingsFor, DEFAULT_SETTINGS, type VoiceSettings } from './voicePersonality.ts';

const execFileP = promisify(execFile);

export interface TTSRequest { id: string; text: string; tone: Emotion; rate: number; voice?: string }
export interface TTSResult { file?: string; mime?: string; browserSpeech?: boolean; provider: string; durationMs?: number; cached?: boolean }

export interface TTSProvider {
  name: string;
  available(): Promise<boolean>;
  synth(req: TTSRequest, outDir: string): Promise<TTSResult>;
}

/** Normalise text for speech: multipliers, symbols, usernames. */
export function speechText(text: string): string {
  return text
    .replace(/(\d)\s?[x×](?![a-z])/gi, '$1 times')
    .replace(/&/g, ' and ')
    .replace(/(\w)_(?=\w)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ElevenLabsError extends Error {
  constructor(message: string, public code: string, public status = 0, public retryable = true) { super(message); }
}
export const elevenBase = (env: Record<string, string | undefined>) => (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');

/** Turn any failure into a short, beginner-readable explanation (never includes the key). */
export function explainElevenLabsError(e: unknown): { code: string; message: string; retryable: boolean } {
  if (e instanceof ElevenLabsError) return { code: e.code, message: e.message, retryable: e.retryable };
  const msg = (e as Error)?.message ?? String(e);
  if ((e as Error)?.name === 'AbortError' || /timed out|abort/i.test(msg)) return { code: 'timeout', message: 'ElevenLabs took too long to answer (network slow or ElevenLabs busy). Hubie will retry.', retryable: true };
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network|tunnel/i.test(msg)) return { code: 'network', message: 'Cannot reach api.elevenlabs.io from this computer (internet or firewall).', retryable: true };
  return { code: 'unknown', message: msg.slice(0, 200), retryable: true };
}

async function elFetch(env: Record<string, string | undefined>, p: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new ElevenLabsError('No ElevenLabs API key saved. Paste it in Control Center section 2.', 'missing_key', 0, false);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? Number(env.TTS_TIMEOUT_MS || 20000));
  try {
    const res = await fetch(`${elevenBase(env)}${p}`, { ...init, signal: ctl.signal, headers: { 'xi-api-key': key, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      let detail = ''; let status = '';
      try { const j: any = await res.clone().json(); status = j?.detail?.status ?? ''; detail = j?.detail?.message ?? (typeof j?.detail === 'string' ? j.detail : ''); } catch { /* not json */ }
      const st = res.status;
      if (status === 'missing_permissions' || /missing_permission|permission/i.test(detail)) throw new ElevenLabsError(`This API key lacks a permission (${detail || 'missing_permissions'}). Create a key with Text to Speech and Voices (read) enabled.`, 'permissions', st, false);
      // ElevenLabs reports out-of-credits as HTTP 401 with status quota_exceeded — that is NOT an invalid key
      if (status === 'quota_exceeded' || (/quota|credits|characters? remaining/i.test(detail) && st !== 429 && status !== 'invalid_api_key')) throw new ElevenLabsError('ElevenLabs says this key is out of characters/credits (quota exceeded).', 'quota', st, false);
      if (st === 401 || status === 'invalid_api_key') throw new ElevenLabsError('ElevenLabs rejected the API key (invalid or revoked). Copy a fresh key from elevenlabs.io → Developers → API Keys.', 'invalid_key', st, false);
      if (st === 402 || /quota|credits|character/i.test(status + detail) && st !== 429) throw new ElevenLabsError('ElevenLabs says the account is out of characters/credits or the plan does not allow this. Check your ElevenLabs subscription.', 'quota', st, false);
      if (st === 404 || /voice.*not.*found/i.test(status + detail)) throw new ElevenLabsError('That voice ID was not found in your ElevenLabs account. Pick another voice in section 2.', 'voice_not_found', st, false);
      if (st === 422) throw new ElevenLabsError(`ElevenLabs rejected the request: ${detail || 'invalid settings'}.`, 'invalid_request', st, false);
      if (st === 429) throw new ElevenLabsError('ElevenLabs rate limit (too many requests at once). Hubie slows down and retries.', 'rate_limit', st, true);
      throw new ElevenLabsError(`ElevenLabs error ${st}${detail ? `: ${detail.slice(0, 120)}` : ''}.`, 'http_error', st, st >= 500);
    }
    return res;
  } finally { clearTimeout(t); }
}

export interface ElevenVoice { voice_id: string; name: string; category?: string; description?: string; preview_url?: string; labels?: Record<string, string> }
/** GET /v1/voices — the voices this account can use. Doubles as the cheapest "is the key valid" test. */
export async function listElevenVoices(env: Record<string, string | undefined>): Promise<ElevenVoice[]> {
  const j: any = await (await elFetch(env, '/v1/voices', { timeoutMs: 15000 })).json();
  return (j?.voices ?? []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, category: v.category, description: v.description, preview_url: v.preview_url, labels: v.labels }));
}

/** GET /v1/user/subscription — credits used/limit and reset time for a key (needs the user_read permission; may be unavailable). */
export async function fetchKeyUsage(env: Record<string, string | undefined>, key: string): Promise<KeyUsage> {
  const j: any = await (await elFetch({ ...env, ELEVENLABS_API_KEY: key }, '/v1/user/subscription', { timeoutMs: 10000 })).json();
  return { used: Number(j.character_count ?? 0), limit: Number(j.character_limit ?? 0), resetAt: j.next_character_count_reset_unix ? Number(j.next_character_count_reset_unix) : undefined, tier: j.tier, checkedAt: Date.now() };
}

export function pickBestVoice(voices: ElevenVoice[]): ElevenVoice | undefined {
  for (const n of PREFERRED_VOICE_NAMES) { const v = voices.find((x) => x.name?.split(/[\s-]/)[0] === n); if (v) return v; }
  return voices.find((v) => v.category === 'premade') ?? voices[0];
}

export function voiceSettingsFromEnv(env: Record<string, string | undefined>): VoiceSettings {
  const n = (k: string, d: number) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? v : d; };
  return { stability: n('ELEVENLABS_STABILITY', DEFAULT_SETTINGS.stability), similarity: n('ELEVENLABS_SIMILARITY', DEFAULT_SETTINGS.similarity), style: n('ELEVENLABS_STYLE', DEFAULT_SETTINGS.style), speed: n('ELEVENLABS_SPEED', DEFAULT_SETTINGS.speed), speakerBoost: env.ELEVENLABS_SPEAKER_BOOST !== 'false' };
}

export class ElevenLabsTTS implements TTSProvider {
  name = 'elevenlabs';
  constructor(private env: Record<string, string | undefined>, private limiter: UsageLimiter, public ring?: KeyRing) {}
  async available() { return this.ring ? this.ring.all().some((k) => k.enabled) || !!this.env.ELEVENLABS_API_KEY : !!this.env.ELEVENLABS_API_KEY; }
  get voiceId() { return this.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID; }
  get model() { return this.env.ELEVENLABS_MODEL || DEFAULT_MODEL; }

  cacheKey(req: TTSRequest, voiceId: string, st: ReturnType<typeof settingsFor>) {
    return crypto.createHash('sha1').update(['el', this.model, voiceId, JSON.stringify(st), speechText(req.text)].join('|')).digest('hex').slice(0, 20);
  }

  /** One request with automatic key failover. Network/5xx trouble is retried briefly on the same key and never blamed on a key. */
  private async generate(voiceId: string, text: string, st: ReturnType<typeof settingsFor>): Promise<Buffer> {
    const url = `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const body = JSON.stringify({ text, model_id: this.model, voice_settings: st });
    const call = async (key: string) => {
      const res = await elFetch({ ...this.env, ELEVENLABS_API_KEY: key }, url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/mpeg' }, body });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new ElevenLabsError('ElevenLabs returned an empty audio file.', 'empty_audio', 200, true);
      return buf;
    };
    if (!this.ring) return call(this.env.ELEVENLABS_API_KEY ?? '');
    const ring = this.ring;
    const tried = new Set<string>();
    let lastErr: ElevenLabsError | null = null;
    let firstQuota: KeyEntry | null = null;
    let firstFail: KeyEntry | null = null;
    for (let round = 0; round < 12; round++) {
      const k = ring.eligible().find((x) => !tried.has(x.id));
      if (!k) break;
      tried.add(k.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const buf = await call(k.key);
          ring.noteSuccess(k, text.length);
          if (lastErr && firstFail) ring.switched(firstFail, k, lastErr.code);
          return buf;
        } catch (e) {
          const ex = explainElevenLabsError(e);
          const transient = ['network', 'timeout', 'http_error', 'empty_audio', 'unknown'].includes(ex.code) && ex.retryable;
          if (transient) {
            ring.noteError(k, ex.code, ex.message);
            if (attempt === 0) { await new Promise((r) => setTimeout(r, 400 + Math.random() * 400)); continue; }
            throw e; // outage: do not burn through the other keys, let the voice service back off / fall back to local TTS
          }
          if (['voice_not_found', 'invalid_request', 'usage_limit'].includes(ex.code)) throw e; // not the key's fault
          const skip = ring.markFailed(k, ex.code, ex.message);
          lastErr = e instanceof ElevenLabsError ? e : new ElevenLabsError(ex.message, ex.code, 0, ex.retryable);
          firstFail ??= k;
          if (ex.code === 'quota') { if (firstQuota && firstQuota !== k) ring.noteShared(firstQuota, k); firstQuota ??= k; }
          if (skip) break;
          throw e;
        }
      }
    }
    // every key tried and none worked
    const vs = ring.view();
    const allQuota = ring.all().filter((k) => k.enabled).every((k) => k.status === 'exhausted');
    throw new ElevenLabsError(allQuota ? 'Every ElevenLabs key is out of credits (or shares one exhausted allowance). Hubie is using the local voice until a key recovers.' : `No ElevenLabs key is usable right now (${vs.map((v) => `${v.name}: ${v.status}`).join(', ') || 'none configured'}).`, allQuota ? 'quota' : (lastErr?.code ?? 'missing_key'), 0, false);
  }

  async synth(req: TTSRequest, outDir: string): Promise<TTSResult> {
    const voiceId = req.voice || this.voiceId;
    const st = settingsFor(voiceSettingsFromEnv(this.env), req.tone, req.rate);
    const cacheDir = path.join(outDir, 'cache');
    const cached = path.join(cacheDir, `${this.cacheKey(req, voiceId, st)}.mp3`);
    if (fs.existsSync(cached)) { fs.utimesSync(cached, new Date(), new Date()); return { file: cached, mime: 'audio/mpeg', provider: this.name, cached: true }; }
    const text = speechText(req.text);
    if (!this.limiter.canSpend(text.length)) throw new ElevenLabsError('Hourly ElevenLabs character limit reached (ELEVENLABS_MAX_CHARS_PER_HOUR). Protects your credits.', 'usage_limit', 0, true);
    this.limiter.spend(text.length);
    const buf = await this.generate(voiceId, text, st);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, buf);
    return { file: cached, mime: 'audio/mpeg', provider: this.name };
  }
}

export class EspeakTTS implements TTSProvider {
  name = 'espeak';
  private bin: string | null | undefined;
  async available() {
    if (this.bin === undefined) {
      this.bin = null;
      for (const b of ['espeak-ng', 'espeak']) { try { await execFileP(b, ['--version']); this.bin = b; break; } catch { /* next */ } }
    }
    return !!this.bin;
  }
  async synth(req: TTSRequest, outDir: string): Promise<TTSResult> {
    if (!(await this.available())) throw new Error('espeak-ng not installed');
    const file = path.join(outDir, `${req.id}.wav`);
    const fast = req.tone === 'excited' || req.tone === 'hyped';
    await execFileP(this.bin!, ['-v', 'en-us+m3', '-s', String(Math.round((fast ? 185 : 160) * req.rate)), '-p', fast ? '52' : '40', '-g', '2', '-w', file, speechText(req.text)], { timeout: 15000 });
    const st = fs.statSync(file);
    return { file, mime: 'audio/wav', provider: this.name, durationMs: Math.round(((st.size - 44) / 2 / 22050) * 1000) };
  }
}

export class BrowserTTS implements TTSProvider {
  name = 'browser';
  async available() { return true; }
  async synth(): Promise<TTSResult> { return { browserSpeech: true, provider: this.name }; }
}

/** Fallback chain + circuit breaker per provider + cache cleanup. */
export class VoiceService {
  private down = new Map<string, number>();
  private fails = new Map<string, number>();
  lastError = '';
  lastErrorCode = '';
  lastOkAt = new Map<string, number>();
  served = new Map<string, number>();
  lastFallbackAt = 0;
  silentCount = 0;
  resetBreakers() { this.down.clear(); this.fails.clear(); }
  /** Which engine is speaking right now, and the state of every engine in the chain. */
  status() {
    const now = Date.now();
    return this.chain.map((p, i) => ({ name: p.name, primary: i === 0, downForMs: Math.max(0, (this.down.get(p.name) ?? 0) - now), failures: this.fails.get(p.name) ?? 0, lastOkAt: this.lastOkAt.get(p.name) ?? 0, served: this.served.get(p.name) ?? 0 }));
  }
  get activeEngine() { const now = Date.now(); return this.chain.find((p) => (this.down.get(p.name) ?? 0) <= now)?.name ?? 'none'; }
  constructor(public chain: TTSProvider[], private outDir: string, private onHealth?: (ok: boolean, detail: string) => void) {
    fs.mkdirSync(outDir, { recursive: true });
    setInterval(() => this.cleanup(), 5 * 60_000).unref();
  }

  get primaryName() { return this.chain[0]?.name ?? 'none'; }
  get isDemo() { return this.primaryName === 'browser' || this.primaryName === 'espeak'; }

  async synth(req: TTSRequest): Promise<TTSResult> {
    const errors: string[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      const p = this.chain[i];
      if ((this.down.get(p.name) ?? 0) > Date.now()) continue;
      if (!(await p.available())) continue;
      try {
        const r = await p.synth(req, this.outDir);
        if (this.fails.get(p.name)) this.onHealth?.(true, `${p.name} recovered`);
        this.fails.set(p.name, 0); this.lastOkAt.set(p.name, Date.now()); this.served.set(p.name, (this.served.get(p.name) ?? 0) + 1);
        if (i > 0 && !this.lastFallbackAt) this.lastFallbackAt = Date.now();
        if (i > 0 && p.name !== this.chain[0].name) this.onHealth?.(false, `using fallback voice: ${p.name} (${this.lastError})`);
        else this.onHealth?.(true, p.name);
        return r;
      } catch (e) {
        const ex = explainElevenLabsError(e);
        this.lastError = ex.message; this.lastErrorCode = ex.code;
        const n = (this.fails.get(p.name) ?? 0) + 1;
        this.fails.set(p.name, n);
        if (!ex.retryable) this.down.set(p.name, Date.now() + 10 * 60_000);
        else if (n >= 3) this.down.set(p.name, Date.now() + Math.min(300_000, 20_000 * 2 ** (n - 3)));
        errors.push(`${p.name}: ${ex.message}`);
      }
    }
    this.onHealth?.(false, `all voice providers failed: ${errors.join('; ')}`);
    this.silentCount++;
    return { provider: 'none' }; // no speech this line — the stream and the avatar carry on
  }

  private cleanup() {
    // per-utterance files: 10 min; cache: keep newest ~300 MB
    const cutoff = Date.now() - 10 * 60_000;
    for (const f of fs.readdirSync(this.outDir)) {
      const p = path.join(this.outDir, f);
      try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    const cdir = path.join(this.outDir, 'cache');
    if (!fs.existsSync(cdir)) return;
    const files = fs.readdirSync(cdir).map((f) => { const p = path.join(cdir, f); const st = fs.statSync(p); return { p, size: st.size, t: st.mtimeMs }; }).sort((a, b) => b.t - a.t);
    let total = 0;
    for (const f of files) { total += f.size; if (total > 300 * 1024 * 1024) { try { fs.unlinkSync(f.p); } catch { /* ignore */ } } }
  }
}

export function createVoice(env: Record<string, string | undefined>, outDir: string, onHealth?: (ok: boolean, d: string) => void, ring?: KeyRing): VoiceService {
  const limiter = new UsageLimiter(Number(env.ELEVENLABS_MAX_CHARS_PER_HOUR || 100000));
  const make = (name: string): TTSProvider | null => {
    switch (name.trim().toLowerCase()) {
      case 'elevenlabs': return new ElevenLabsTTS(env, limiter, ring);
      case 'espeak': return new EspeakTTS();
      case 'browser': return new BrowserTTS();
      default: return null; // anything else (including a leftover "openai") is ignored — there is no OpenAI voice
    }
  };
  const primary = env.TTS_PROVIDER === 'elevenlabs' || env.ELEVENLABS_API_KEY || ring?.all().length ? 'elevenlabs' : 'browser';
  const fb = env.TTS_FALLBACKS ?? 'browser';
  const names = [primary, ...fb.split(',')];
  const seen = new Set<string>();
  const chain = names.map(make).filter((p): p is TTSProvider => !!p && !seen.has(p.name) && !!seen.add(p.name));
  if (!seen.has('browser') && !/none|espeak/.test(fb)) chain.push(new BrowserTTS());
  return new VoiceService(chain, outDir, onHealth);
}
