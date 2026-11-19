/** Control-panel API for the ElevenLabs key ring. Full keys are only ever accepted here, never returned. */
import type { Hub } from './hub.ts';
import type { Logger } from '../../../packages/shared/src/node.ts';
import { writeEnv } from '../../../packages/shared/src/config.ts';
import { listElevenVoices, fetchKeyUsage, explainElevenLabsError } from '../../../services/tts/src/tts.ts';
import type { VoiceService } from '../../../services/tts/src/tts.ts';
import { DEFAULT_MODEL } from '../../../services/tts/src/voicePersonality.ts';
import type { KeyRing } from '../../../services/tts/src/keyring.ts';
import type { UsageLimiter } from '../../../services/ai/src/usage.ts';

export function registerVoiceKeysApi(d: { hub: Hub; log: Logger; ring: KeyRing; voice: () => VoiceService; rebuild: () => void; limiter?: () => UsageLimiter | undefined }) {
  const api = d.hub.apiHandlers;
  const ring = d.ring;
  const err = (code: string, message: string) => ({ ok: false, error: { code, message } });

  const snapshot = () => {
    const v = d.voice();
    return {
      ok: true,
      keys: ring.view(),
      activeKey: ring.view().find((k) => k.active)?.name ?? null,
      totalKeys: ring.all().length,
      enabledKeys: ring.all().filter((k) => k.enabled).length,
      engine: v.activeEngine,
      engines: v.status(),
      localFallback: (process.env.TTS_FALLBACKS ?? 'browser').split(',')[0] || 'browser',
      localFallbackActive: v.activeEngine !== 'elevenlabs' && v.activeEngine !== 'none',
      silent: v.silentCount,
      failovers: ring.history.slice(-30).reverse(),
      errors: ring.errors.slice(-30).reverse(),
      lastSuccessAt: ring.lastSuccessAt,
      lastError: v.lastError, lastErrorCode: v.lastErrorCode,
      charsSent: ring.totalChars,
      estimatedCredits: ring.estimatedCredits(process.env.ELEVENLABS_MODEL || DEFAULT_MODEL),
      hourlyCap: Number(process.env.ELEVENLABS_MAX_CHARS_PER_HOUR || 100000),
      note: 'Characters/credits are Hubie\'s own count of what it sent; "used / limit" per key comes from ElevenLabs when the key has the user_read permission. Separate keys on the same ElevenLabs account share one allowance.',
    };
  };
  api.set('GET /api/voice/keys', () => snapshot());

  api.set('POST /api/voice/keys/add', async (_r, b) => {
    const key = String(b.key ?? '').trim(); const name = String(b.name ?? '').trim();
    if (!key) return err('empty', 'Paste the ElevenLabs API key first.');
    if (!/^[A-Za-z0-9_\-]{16,}$/.test(key)) return err('format', 'That does not look like an ElevenLabs API key (a long string of letters and numbers, often starting with sk_).');
    const e = ring.add(name, key);
    d.log.info(`ElevenLabs key "${e.name}" added`);
    let tested: { ok: boolean; message: string } = { ok: false, message: 'saved, not tested yet' };
    try { await listElevenVoices({ ...process.env, ELEVENLABS_API_KEY: key }); ring.get(e.id)!.status = 'ok'; ring.get(e.id)!.detail = 'key accepted'; tested = { ok: true, message: 'ElevenLabs accepted this key.' }; }
    catch (x) { const ex = explainElevenLabsError(x); if (ex.code === 'invalid_key') { ring.markFailed(e, 'invalid_key', ex.message); } tested = { ok: false, message: ex.message }; }
    try { ring.setUsage(ring.get(e.id)!, await fetchKeyUsage(process.env, key)); } catch { /* usage needs user_read — optional */ }
    d.voice().resetBreakers();
    if (!process.env.TTS_PROVIDER || process.env.TTS_PROVIDER !== 'elevenlabs') { writeEnv({ TTS_PROVIDER: 'elevenlabs' }); d.rebuild(); }
    ring.saveNow();
    return { ...snapshot(), added: e.id, tested };
  });

  api.set('POST /api/voice/keys/update', (_r, b) => {
    const ok = ring.update(String(b.id), { name: b.name === undefined ? undefined : String(b.name), enabled: b.enabled === undefined ? undefined : !!b.enabled, key: b.key ? String(b.key) : undefined });
    if (!ok) return err('not_found', 'No such key.');
    d.voice().resetBreakers(); return snapshot();
  });
  api.set('POST /api/voice/keys/remove', (_r, b) => ring.remove(String(b.id)) ? snapshot() : err('cannot_remove', 'That key cannot be removed here (the Section 2 key is removed in Section 2) or does not exist.'));
  api.set('POST /api/voice/keys/reorder', (_r, b) => { ring.reorder(Array.isArray(b.ids) ? b.ids.map(String) : []); return snapshot(); });

  api.set('POST /api/voice/keys/test', async (_r, b) => {
    const k = ring.get(String(b.id)); if (!k) return err('not_found', 'No such key.');
    let message = 'ElevenLabs accepted this key.';
    try {
      await listElevenVoices({ ...process.env, ELEVENLABS_API_KEY: k.key });
      if (k.status === 'invalid' || k.status === 'unknown' || k.status === 'unavailable') { k.status = 'ok'; k.detail = 'key accepted'; k.until = 0; }
    } catch (x) {
      const ex = explainElevenLabsError(x); message = ex.message;
      if (ex.code === 'invalid_key' || ex.code === 'permissions') ring.markFailed(k, ex.code, ex.message);
      else if (ex.code === 'quota') ring.markFailed(k, 'quota', ex.message);
      else if (ex.code === 'rate_limit') ring.markFailed(k, 'rate_limit', ex.message);
      else { k.status = 'unavailable'; k.detail = ex.message.slice(0, 120); }
    }
    try {
      const u = await fetchKeyUsage(process.env, k.key); ring.setUsage(k, u);
      if (u.limit > 0 && u.used >= u.limit) ring.markFailed(k, 'quota', 'plan characters used up');
    } catch { /* usage endpoint optional */ }
    ring.saveNow(); d.voice().resetBreakers();
    return { ...snapshot(), message };
  });

  api.set('POST /api/voice/keys/refresh-usage', async () => {
    let got = 0;
    for (const k of ring.all()) { try { ring.setUsage(k, await fetchKeyUsage(process.env, k.key)); got++; } catch { /* needs user_read */ } }
    return { ...snapshot(), usageKnownFor: got };
  });

  api.set('POST /api/voice/failover-settings', (_r, b) => {
    const up: Record<string, string> = {};
    if (b.hourlyCap !== undefined) { const n = Math.round(Number(b.hourlyCap)); if (!(n >= 0 && n <= 1_000_000)) return err('range', 'Hourly character limit must be 0 (off) to 1,000,000.'); up.ELEVENLABS_MAX_CHARS_PER_HOUR = String(n); }
    if (b.localFallback !== undefined) { const v = String(b.localFallback); if (!['browser', 'espeak', 'none'].includes(v)) return err('bad', 'Local voice must be browser, espeak or none.'); up.TTS_FALLBACKS = v; }
    writeEnv(up); d.rebuild(); return snapshot();
  });
}
