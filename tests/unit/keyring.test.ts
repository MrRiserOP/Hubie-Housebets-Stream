// ElevenLabs multi-key failover against the STAND-IN server (tests/fakes/fakeElevenLabs.ts). Proves Hubie's logic, not ElevenLabs' service.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { ElevenLabsTTS, createVoice, fetchKeyUsage, BrowserTTS, VoiceService } from '../../services/tts/src/tts.ts';
import { KeyRing } from '../../services/tts/src/keyring.ts';
import { UsageLimiter } from '../../services/ai/src/usage.ts';

let el: Awaited<ReturnType<typeof startFakeElevenLabs>>; let dir: string; let n = 0;
const env = (o: Record<string, string> = {}) => ({ ELEVENLABS_BASE_URL: el.url, TTS_TIMEOUT_MS: '5000', ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb', ...o });
const mk = (wizardKey?: string) => { const f = path.join(dir, `ring-${++n}.json`); const ring = new KeyRing(f, () => wizardKey); return { ring, f, tts: new ElevenLabsTTS(env(wizardKey ? { ELEVENLABS_API_KEY: wizardKey } : {}), new UsageLimiter(0), ring) }; };
const say = (tts: ElevenLabsTTS, t: string) => tts.synth({ id: `x${++n}`, text: `${t} ${n} ${Math.random()}`, tone: 'friendly', rate: 1 }, dir);
const hits = (key: string) => el.ttsRequests().filter((r) => r.key === key).length;
beforeAll(async () => { el = await startFakeElevenLabs(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-test-')); });
afterAll(async () => { await el.close(); });

describe('key ring', () => {
  it('merges the Section-2 key as "Primary", orders by priority, supports many keys, never reveals full keys', () => {
    const { ring } = mk('sk_acct_main_aaaaaaaaaaaaaaaaaaaa');
    for (let i = 0; i < 12; i++) ring.add(`Backup ${i}`, `sk_acct_b${i}_xxxxxxxxxxxxxxxxxxxx`);
    expect(ring.all().length).toBe(13); expect(ring.all()[0].name).toBe('Primary key');
    ring.reorder([ring.all()[3].id]); expect(ring.all()[0].name).toBe('Backup 2');
    const view = JSON.stringify(ring.view());
    expect(view).not.toContain('xxxxxxxxxxxxxxxxxxxx'); expect(view).not.toContain('aaaaaaaaaaaaaaaaaaaa'); expect(view).toContain('…');
    expect(ring.remove(ring.all().find((k) => k.source === 'env')!.id)).toBe(false); // wizard key is removed in Section 2
  });
  it('persists to disk with owner-only permissions', () => {
    const { ring, f } = mk(); ring.add('Disk', 'sk_acct_disk_xxxxxxxxxxxxxxxxxxxx'); ring.saveNow();
    expect(fs.statSync(f).mode & 0o077).toBe(0);
    expect(new KeyRing(f, () => undefined).all()[0].name).toBe('Disk');
  });
  it('EXHAUSTED key → instantly retries the same line on the next key, records the switch, and stops hitting the dead key', async () => {
    const { ring, tts } = mk(); el.setAccount('ex1', 50); el.setAccount('ok1', 100000);
    const a = ring.add('Main', 'sk_acct_ex1_aaaaaaaaaaaaaaaaaaaa'); ring.add('Backup', 'sk_acct_ok1_bbbbbbbbbbbbbbbbbbbb');
    const r = await say(tts, 'This line is longer than the fifty characters the first account has left in total'); // exhausts the tiny first account
    expect(r.provider).toBe('elevenlabs'); expect(r.file).toBeTruthy();
    expect(ring.get(a.id)!.status).toBe('exhausted');
    expect(ring.history.at(-1)).toMatchObject({ from: 'Main', to: 'Backup', code: 'quota' });
    const before = hits('sk_acct_ex1_aaaaaaaaaaaaaaaaaaaa');
    for (let i = 0; i < 4; i++) await say(tts, 'more speech');
    expect(hits('sk_acct_ex1_aaaaaaaaaaaaaaaaaaaa')).toBe(before); // no endless retries of an exhausted key
    expect(ring.view().find((k) => k.active)!.name).toBe('Backup');
  });
  it('out-of-credits reported as HTTP 401 quota_exceeded is "exhausted", not "invalid key"', async () => {
    const { ring, tts } = mk(); const a = ring.add('Q401', 'sk_quota401_aaaaaaaaaaaaaaaaaaaa'); ring.add('Next', 'sk_acct_ok2_bbbbbbbbbbbbbbbbbbbb');
    await say(tts, 'hello there'); expect(ring.get(a.id)!.status).toBe('exhausted');
  });
  it('INVALID key → marked invalid, skipped, never retried; next key speaks', async () => {
    const { ring, tts } = mk(); const bad = ring.add('Bad', 'sk_invalid_aaaaaaaaaaaaaaaaaaaaaa'); ring.add('Good', 'sk_acct_ok3_bbbbbbbbbbbbbbbbbbbb');
    await say(tts, 'first'); await say(tts, 'second');
    expect(ring.get(bad.id)!.status).toBe('invalid'); expect(hits('sk_invalid_aaaaaaaaaaaaaaaaaaaaaa')).toBe(1);
  });
  it('missing-permission key → invalid with a clear reason', async () => {
    const { ring, tts } = mk(); const k = ring.add('NoPerm', 'sk_noperm_aaaaaaaaaaaaaaaaaaaaaa'); ring.add('Good', 'sk_acct_ok4_bbbbbbbbbbbbbbbbbbbb');
    await say(tts, 'hi'); expect(ring.get(k.id)).toMatchObject({ status: 'invalid' }); expect(ring.get(k.id)!.detail).toMatch(/permission/);
  });
  it('RATE LIMIT → cool-down on that key, next key speaks, key returns after the cool-down', async () => {
    const { ring, tts } = mk(); const k = ring.add('Busy', 'sk_ratelimit_aaaaaaaaaaaaaaaaaaaa'); ring.add('Calm', 'sk_acct_ok5_bbbbbbbbbbbbbbbbbbbb');
    el.rateLimit('sk_ratelimit_aaaaaaaaaaaaaaaaaaaa', 1);
    const r = await say(tts, 'throttled'); expect(r.provider).toBe('elevenlabs');
    expect(ring.get(k.id)).toMatchObject({ status: 'rate_limited' }); expect(ring.get(k.id)!.until).toBeGreaterThan(Date.now());
    expect(ring.eligible().map((x) => x.name)).not.toContain('Busy');
    ring.get(k.id)!.until = Date.now() - 1; // cool-down over
    expect(ring.eligible()[0].name).toBe('Busy');
    await say(tts, 'back again'); expect(ring.get(k.id)!.status).toBe('ok');
  });
  it('SHARED quota: two keys on one account are marked together and the dead allowance is not pinged twice; a different account takes over', async () => {
    const { ring, tts } = mk(); el.setAccount('shared', 40); el.setAccount('other', 100000);
    const a1 = ring.add('Shared A', 'sk_acct_shared_aaaaaaaaaaaaaaaaaaa'), a2 = ring.add('Shared B', 'sk_acct_shared_bbbbbbbbbbbbbbbbbbb'); ring.add('Other account', 'sk_acct_other_cccccccccccccccccccc');
    await say(tts, 'a line that is clearly longer than forty characters in length so it exhausts the shared allowance');
    expect(ring.get(a1.id)!.status).toBe('exhausted'); expect(ring.get(a2.id)!.status).toBe('exhausted');
    expect(ring.get(a1.id)!.shareGroup).toBeTruthy(); expect(ring.get(a1.id)!.shareGroup).toBe(ring.get(a2.id)!.shareGroup);
    const hitsA2 = hits('sk_acct_shared_bbbbbbbbbbbbbbbbbbb'); await say(tts, 'next'); await say(tts, 'and next');
    expect(hits('sk_acct_shared_bbbbbbbbbbbbbbbbbbb')).toBe(hitsA2);
    expect(ring.view().find((k) => k.id === a1.id)!.sharesAllowanceWith).toEqual(['Shared B']);
  });
  it('shared allowance is detected up-front from the subscription endpoint, so the second key is never even tried', async () => {
    const { ring, tts } = mk(); el.setAccount('pre', 30, 5); el.setAccount('free2', 100000);
    const a1 = ring.add('Pre A', 'sk_acct_pre_aaaaaaaaaaaaaaaaaaaaaa'), a2 = ring.add('Pre B', 'sk_acct_pre_bbbbbbbbbbbbbbbbbbbbbb'); ring.add('Free', 'sk_acct_free2_cccccccccccccccccc');
    ring.setUsage(a1, await fetchKeyUsage(env(), a1.key)); ring.setUsage(a2, await fetchKeyUsage(env(), a2.key));
    expect(a1.shareGroup).toBeTruthy(); expect(a1.shareGroup).toBe(a2.shareGroup);
    await say(tts, 'long long long long long long long long long long long long long long');
    expect(hits('sk_acct_pre_bbbbbbbbbbbbbbbbbbbbbb')).toBe(0); expect(ring.get(a2.id)!.status).toBe('exhausted');
  });
  it('usage per key comes from the subscription endpoint; keys without user_read just show no usage', async () => {
    const { ring } = mk(); el.setAccount('use', 5000, 1234); const k = ring.add('Use', 'sk_acct_use_aaaaaaaaaaaaaaaaaaaaaa');
    ring.setUsage(k, await fetchKeyUsage(env(), k.key)); expect(ring.view()[0].usage).toMatchObject({ used: 1234, limit: 5000 });
    await expect(fetchKeyUsage(env(), 'sk_nouser_aaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toBeTruthy();
  });
  it('a temporary outage (HTTP 500) is NOT blamed on any key and does not burn the backups', async () => {
    const { ring, tts } = mk(); const a = ring.add('One', 'sk_acct_ok6_aaaaaaaaaaaaaaaaaaaaaa'); const b = ring.add('Two', 'sk_acct_ok7_bbbbbbbbbbbbbbbbbbbbbb');
    el.failNext(5, 500); await expect(say(tts, 'outage')).rejects.toBeTruthy();
    expect(ring.get(a.id)!.status).not.toBe('exhausted'); expect(ring.get(a.id)!.status).not.toBe('invalid'); expect(hits('sk_acct_ok7_bbbbbbbbbbbbbbbbbbbbbb')).toBe(0); void b;
    el.failNext(0); expect((await say(tts, 'recovered')).provider).toBe('elevenlabs');
  });
  it('disabled keys are never used', async () => {
    const { ring, tts } = mk(); const a = ring.add('Off', 'sk_acct_off_aaaaaaaaaaaaaaaaaaaaaa'); ring.add('On', 'sk_acct_on_bbbbbbbbbbbbbbbbbbbbbbb'); ring.update(a.id, { enabled: false });
    await say(tts, 'only the enabled key'); expect(hits('sk_acct_off_aaaaaaaaaaaaaaaaaaaaaa')).toBe(0);
  });
  it('ALL keys exhausted → one clear error; voice service falls back to the local engine; nothing crashes; silent if no local engine', async () => {
    const { ring } = mk(); el.setAccount('dead1', 1); el.setAccount('dead2', 1);
    ring.add('D1', 'sk_acct_dead1_aaaaaaaaaaaaaaaaaaaaa'); ring.add('D2', 'sk_acct_dead2_bbbbbbbbbbbbbbbbbbbbb');
    const out = fs.mkdtempSync(path.join(dir, 'v-'));
    const voice = createVoice(env({ TTS_PROVIDER: 'elevenlabs', TTS_FALLBACKS: 'browser' }), out, undefined, ring);
    const r1 = await voice.synth({ id: 'z1', text: 'everything is out of credits now', tone: 'friendly', rate: 1 });
    expect(r1.provider).toBe('browser'); expect(voice.lastErrorCode).toBe('quota'); expect(ring.view().every((k) => k.status === 'exhausted')).toBe(true);
    const hitsBefore = el.ttsRequests().length; await voice.synth({ id: 'z2', text: 'second try', tone: 'friendly', rate: 1 });
    expect(el.ttsRequests().length).toBe(hitsBefore); // circuit breaker: no hammering of exhausted keys
    const silent = createVoice(env({ TTS_PROVIDER: 'elevenlabs', TTS_FALLBACKS: 'none' }), out, undefined, ring);
    const r2 = await silent.synth({ id: 'z3', text: 'no local voice configured at all', tone: 'friendly', rate: 1 });
    expect(r2).toEqual({ provider: 'none' }); expect(silent.silentCount).toBe(1);
  });
  it('adding a fresh backup key after exhaustion restores ElevenLabs once the breaker is reset', async () => {
    const { ring } = mk(); el.setAccount('dead3', 1); ring.add('D3', 'sk_acct_dead3_aaaaaaaaaaaaaaaaaaaaa');
    const voice = createVoice(env({ TTS_PROVIDER: 'elevenlabs', TTS_FALLBACKS: 'browser' }), fs.mkdtempSync(path.join(dir, 'v-')), undefined, ring);
    expect((await voice.synth({ id: 'y1', text: 'dead account here', tone: 'friendly', rate: 1 })).provider).toBe('browser');
    ring.add('Fresh', 'sk_acct_fresh3_bbbbbbbbbbbbbbbbbbbb'); voice.resetBreakers();
    expect((await voice.synth({ id: 'y2', text: 'now it works again', tone: 'friendly', rate: 1 })).provider).toBe('elevenlabs');
  });
  it('estimated credits counts only characters actually sent to ElevenLabs (cache hits are free)', async () => {
    const { ring, tts } = mk(); ring.add('Count', 'sk_acct_cnt_aaaaaaaaaaaaaaaaaaaaaa');
    await tts.synth({ id: 'c1', text: 'count these characters', tone: 'friendly', rate: 1 }, dir);
    const after1 = ring.totalChars; await tts.synth({ id: 'c2', text: 'count these characters', tone: 'friendly', rate: 1 }, dir);
    expect(after1).toBe('count these characters'.length); expect(ring.totalChars).toBe(after1);
  });
  it('the key never appears in error text', async () => {
    const { ring, tts } = mk(); ring.add('Leak', 'sk_invalid_leakcheck123456789012'); 
    await tts.synth({ id: 'l', text: 'leak test', tone: 'friendly', rate: 1 }, dir).catch(() => {});
    expect(JSON.stringify(ring.errors)).not.toContain('leakcheck123456789012');
  });
});
void BrowserTTS; void VoiceService;

describe('shared-allowance heuristic is not fooled by fresh keys', () => {
  it('two unrelated keys that both show 0 used are NOT grouped', async () => {
    const { ring } = mk();
    const a = ring.add('A', 'sk_fresh_aaaaaaaaaaaaaaaaaaaaaaaa'), b = ring.add('B', 'sk_fresh_bbbbbbbbbbbbbbbbbbbbbbbb');
    ring.setUsage(a, { used: 0, limit: 10000, resetAt: 1_900_000_000_000, checkedAt: 1 }); ring.setUsage(b, { used: 0, limit: 10000, resetAt: 1_900_000_000_000, checkedAt: 1 });
    expect(a.shareGroup).toBeFalsy(); expect(b.shareGroup).toBeFalsy();
  });
});
