/**
 * ElevenLabs key ring: any number of keys, each with a name, priority, enable switch and live status.
 * Stored in data/elevenlabs-keys.json (mode 0600) — never in logs, never sent to the browser in full.
 * The key saved by the old single-key wizard (ELEVENLABS_API_KEY) is merged in as the "Primary" entry.
 *
 * Failover rules (see ElevenLabsTTS.synth):
 *  - quota/credits exhausted → key "exhausted" until its monthly reset (if known) or a recheck interval; next key is tried at once
 *  - invalid / missing-permission key → "invalid" (not retried until the user edits/tests it)
 *  - rate limit (429) → "rate_limited" with growing cool-down; next key is tried
 *  - network / timeout / 5xx → NOT blamed on the key (transient); caller backs off
 *  - keys that provably share one account allowance (same plan limit + same reset + same used count from the subscription
 *    endpoint, or both reporting quota exhaustion back-to-back) are marked together so Hubie doesn't ping-pong between them
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type KeyStatus = 'unknown' | 'ok' | 'exhausted' | 'invalid' | 'rate_limited' | 'unavailable';
export interface KeyUsage { used: number; limit: number; resetAt?: number; checkedAt: number; tier?: string }
export interface KeyEntry {
  id: string; name: string; key: string; enabled: boolean; priority: number;
  status: KeyStatus; detail: string; since: number; until: number; rateHits: number;
  usage?: KeyUsage; shareGroup?: string;
  requests: number; chars: number; failures: number; lastOkAt: number; lastUsedAt: number;
  source?: 'env';
}
export interface FailoverEvent { at: number; from: string; to: string; reason: string; code: string }
export interface PublicKey {
  id: string; name: string; masked: string; enabled: boolean; priority: number; status: KeyStatus; detail: string; since: number; until: number;
  usage?: KeyUsage; sharesAllowanceWith: string[]; requests: number; chars: number; failures: number; lastOkAt: number; active: boolean; fromWizard: boolean;
}

export const maskKey = (k: string) => (k.length > 10 ? `${k.slice(0, 3)}…${k.slice(-4)}` : '••••');
const RECHECK_EXHAUSTED_MS = 60 * 60_000;

export class KeyRing {
  private keys: KeyEntry[] = [];
  history: FailoverEvent[] = [];
  errors: Array<{ at: number; keyName: string; code: string; message: string }> = [];
  activeId = '';
  lastSuccessAt = 0;
  totalChars = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string, private envKey: () => string | undefined) { this.load(); }

  private load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.keys = (j.keys ?? []).filter((k: KeyEntry) => k && k.key && k.id);
      this.history = j.history ?? []; this.totalChars = j.totalChars ?? 0; this.lastSuccessAt = j.lastSuccessAt ?? 0;
      for (const k of this.keys) { k.rateHits ??= 0; k.requests ??= 0; k.chars ??= 0; k.failures ??= 0; }
    } catch { /* first run */ }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 300);
    this.saveTimer.unref?.();
  }
  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ keys: this.keys, history: this.history.slice(-200), totalChars: this.totalChars, lastSuccessAt: this.lastSuccessAt }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* disk problems must never break speech */ }
  }

  /** All keys including the wizard key (env), in priority order. */
  all(): KeyEntry[] {
    const env = this.envKey();
    let wiz = this.keys.find((k) => k.source === 'env');
    if (env) {
      if (!wiz) {
        const dup = this.keys.find((k) => k.key === env);
        if (dup) dup.source = 'env';
        else { wiz = this.blank('Primary key', env, 0); wiz.source = 'env'; this.keys.push(wiz); }
      } else if (wiz.key !== env) { wiz.key = env; wiz.status = 'unknown'; wiz.detail = ''; wiz.until = 0; }
    } else if (wiz) { this.keys = this.keys.filter((k) => k !== wiz); }
    return [...this.keys].sort((a, b) => a.priority - b.priority);
  }

  private blank(name: string, key: string, priority: number): KeyEntry {
    return { id: crypto.randomUUID().slice(0, 8), name, key, enabled: true, priority, status: 'unknown', detail: '', since: Date.now(), until: 0, rateHits: 0, requests: 0, chars: 0, failures: 0, lastOkAt: 0, lastUsedAt: 0 };
  }

  get(id: string) { return this.all().find((k) => k.id === id); }

  add(name: string, key: string): KeyEntry {
    const all = this.all();
    const dup = all.find((k) => k.key === key);
    if (dup) return dup;
    const e = this.blank(name.trim().slice(0, 40) || `Backup ${all.length}`, key.trim(), (all.at(-1)?.priority ?? 0) + 1);
    this.keys.push(e); this.save(); return e;
  }

  update(id: string, patch: { name?: string; enabled?: boolean; key?: string }) {
    const k = this.get(id); if (!k) return false;
    if (patch.name !== undefined) k.name = patch.name.trim().slice(0, 40) || k.name;
    if (patch.enabled !== undefined) { k.enabled = patch.enabled; if (patch.enabled && k.status === 'invalid') { k.status = 'unknown'; k.detail = ''; } }
    if (patch.key && patch.key !== k.key && k.source !== 'env') { k.key = patch.key.trim(); k.status = 'unknown'; k.detail = ''; k.until = 0; k.usage = undefined; k.shareGroup = undefined; }
    this.save(); return true;
  }

  remove(id: string) {
    const k = this.keys.find((x) => x.id === id);
    if (!k || k.source === 'env') return false; // the wizard key is removed from section 2
    this.keys = this.keys.filter((x) => x !== k); this.save(); return true;
  }

  /** New order; unknown ids ignored, the rest keep relative order after the listed ones. */
  reorder(ids: string[]) {
    const all = this.all(); let p = 0;
    for (const id of ids) { const k = all.find((x) => x.id === id); if (k) k.priority = p++; }
    for (const k of all) if (!ids.includes(k.id)) k.priority = p++;
    this.save();
  }

  /** Keys that may be tried right now, best first. Expired cool-downs become eligible again. */
  eligible(now = Date.now()): KeyEntry[] {
    return this.all().filter((k) => {
      if (!k.enabled) return false;
      if (k.status === 'invalid') return false;
      if ((k.status === 'exhausted' || k.status === 'rate_limited') && k.until > now) return false;
      return true;
    });
  }

  private setStatus(k: KeyEntry, status: KeyStatus, detail: string, until = 0) { k.status = status; k.detail = detail; k.since = Date.now(); k.until = until; this.save(); }

  noteSuccess(k: KeyEntry, chars: number, fromCache = false) {
    if (fromCache) return;
    k.requests++; k.chars += chars; this.totalChars += chars; k.lastOkAt = k.lastUsedAt = Date.now(); this.lastSuccessAt = k.lastOkAt; k.rateHits = 0;
    if (k.usage) k.usage.used += chars;
    if (k.status !== 'ok') this.setStatus(k, 'ok', 'working');
    if (this.activeId !== k.id) { const prev = this.keys.find((x) => x.id === this.activeId); if (prev) this.recordSwitch(prev, k, 'switched'); this.activeId = k.id; }
    this.save();
  }

  private recordSwitch(from: KeyEntry, to: KeyEntry, code: string) {
    this.history.push({ at: Date.now(), from: from.name, to: to.name, reason: from.detail || code, code });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  noteError(k: KeyEntry | null, code: string, message: string) {
    this.errors.push({ at: Date.now(), keyName: k?.name ?? '—', code, message: message.slice(0, 200) });
    if (this.errors.length > 100) this.errors.splice(0, this.errors.length - 100);
    if (k) k.failures++;
  }

  /** Mark a key from an ElevenLabs error code. Returns true when the key should be skipped for the rest of this request. */
  markFailed(k: KeyEntry, code: string, message: string, now = Date.now()): boolean {
    this.noteError(k, code, message);
    if (code === 'quota') {
      const until = k.usage?.resetAt && k.usage.resetAt * 1000 > now ? k.usage.resetAt * 1000 : now + RECHECK_EXHAUSTED_MS;
      this.setStatus(k, 'exhausted', 'out of credits / quota', until);
      // every key that shares this key's allowance is exhausted too — don't waste requests on them
      if (k.shareGroup) for (const o of this.keys) if (o !== k && o.shareGroup === k.shareGroup) this.setStatus(o, 'exhausted', `shares the exhausted allowance of "${k.name}"`, until);
      return true;
    }
    if (code === 'invalid_key' || code === 'permissions') { this.setStatus(k, 'invalid', code === 'permissions' ? 'key lacks Text-to-Speech permission' : 'invalid or revoked key'); return true; }
    if (code === 'rate_limit') {
      k.rateHits++;
      this.setStatus(k, 'rate_limited', 'rate limited — cooling down', now + Math.min(300_000, 5_000 * 2 ** Math.min(k.rateHits, 6)));
      return true;
    }
    return false;
  }

  /** The error that follows another key's quota error within the same request ⇒ they very likely share an allowance. */
  noteShared(a: KeyEntry, b: KeyEntry) {
    const g = a.shareGroup ?? b.shareGroup ?? `g${crypto.randomUUID().slice(0, 4)}`;
    a.shareGroup = g; b.shareGroup = g; this.save();
  }

  switched(from: KeyEntry, to: KeyEntry, code: string) { this.recordSwitch(from, to, code); this.activeId = to.id; this.save(); }

  setUsage(k: KeyEntry, u: KeyUsage) { k.usage = u; this.regroup(); this.save(); }
  private regroup() {
    const withUsage = this.keys.filter((k) => k.usage);
    for (const a of withUsage) for (const b of withUsage) {
      if (a === b) continue;
      if (a.usage!.limit === b.usage!.limit && a.usage!.resetAt === b.usage!.resetAt && a.usage!.used === b.usage!.used && a.usage!.limit > 0 && a.usage!.used > 0 && !!a.usage!.resetAt) {
        // identical limit + reset time + a non-zero used count is real evidence of one account; fresh 0/limit keys prove nothing
        const g = a.shareGroup ?? b.shareGroup ?? `g${crypto.randomUUID().slice(0, 4)}`; a.shareGroup = g; b.shareGroup = g;
      }
    }
  }

  view(now = Date.now()): PublicKey[] {
    return this.all().map((k) => ({
      id: k.id, name: k.name, masked: maskKey(k.key), enabled: k.enabled, priority: k.priority,
      status: (k.status === 'exhausted' || k.status === 'rate_limited') && k.until <= now && k.until > 0 ? 'unknown' : k.status,
      detail: k.detail, since: k.since, until: k.until, usage: k.usage,
      sharesAllowanceWith: k.shareGroup ? this.keys.filter((o) => o !== k && o.shareGroup === k.shareGroup).map((o) => o.name) : [],
      requests: k.requests, chars: k.chars, failures: k.failures, lastOkAt: k.lastOkAt, active: k.id === this.activeId, fromWizard: k.source === 'env',
    }));
  }

  /** Characters → ElevenLabs credits estimate (1 credit per character for standard models; Flash/Turbo are half price on most plans). */
  estimatedCredits(model: string) { const f = /flash|turbo/i.test(model) ? 0.5 : 1; return Math.round(this.totalChars * f); }
}
