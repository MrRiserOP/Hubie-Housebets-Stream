/**
 * Setup wizard API. Everything sensitive stays server-side:
 *  - the OpenAI key is written to the server's .env (chmod 600) and only ever
 *    returned masked ("sk-…abcd")
 *  - tests run on the server and return human-readable results
 * Access: localhost, or any client presenting CONTROL_TOKEN (see hub.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publicConfig, writeEnv, mask } from '../../../packages/shared/src/config.ts';
import { testOpenAIConnection, explainOpenAIError } from '../../../services/ai/src/openai.ts';
import { ElevenLabsTTS, listElevenVoices, pickBestVoice, explainElevenLabsError, voiceSettingsFromEnv } from '../../../services/tts/src/tts.ts';
import { PREVIEW_LINE, DEFAULT_VOICE_ID, DEFAULT_MODEL, MODELS, PREFERRED_VOICE_NAMES, EMOTION_STYLES } from '../../../services/tts/src/voicePersonality.ts';
import { UsageLimiter } from '../../../services/ai/src/openai.ts';
import { testAnthropicConnection, listAnthropicModels, DEFAULT_ANTHROPIC_MODEL } from '../../../services/ai/src/anthropic.ts';
import type { Hub } from './hub.ts';
import type { Logger } from '../../../packages/shared/src/node.ts';
import type { HealthRegistry } from './health.ts';
import type { Situation } from '../../../services/ai/src/types.ts';

export interface SetupDeps {
  hub: Hub;
  log: Logger;
  health: HealthRegistry;
  ttsDir: string;
  rebuildProviders: () => void;
  isDemo: () => { llm: boolean; voice: boolean };
  generateTestLine: () => Promise<{ text: string; provider: string; error?: string }>;
  synthTestLine: (text: string) => Promise<{ url?: string; provider: string; error?: string }>;
  start: () => void;
  stop: () => void;
  started: () => boolean;
}

const previewLimiter = new UsageLimiter(40); // max 40 voice previews per hour

export function registerSetupApi(d: SetupDeps) {
  const api = d.hub.apiHandlers;

  api.set('GET /api/setup/status', () => ({
    config: publicConfig(),
    setupDone: process.env.SETUP_DONE === 'true',
    demo: d.isDemo(),
    started: d.started(),
    voice: { provider: 'elevenlabs', keySet: !!process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, defaultVoiceId: DEFAULT_VOICE_ID, model: process.env.ELEVENLABS_MODEL || DEFAULT_MODEL, models: MODELS, settings: voiceSettingsFromEnv(process.env) },
    health: d.health.all(),
  }));

  api.set('POST /api/setup/openai-key', async (_req, body) => {
    const key = String(body.key ?? '').trim();
    if (!key) return { ok: false, error: { code: 'empty', message: 'Paste your OpenAI API key first.' } };
    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) return { ok: false, error: { code: 'format', message: 'That does not look like an OpenAI API key. Keys start with "sk-" and are long (copy it with the copy button on platform.openai.com).' } };
    // test BEFORE saving so a typo doesn't replace a working key
    const test = await testOpenAIConnection({ ...process.env, OPENAI_API_KEY: key });
    if (!test.ok && test.error && ['invalid_key', 'format'].includes(test.error.code)) return { ok: false, saved: false, test };
    writeEnv({ OPENAI_API_KEY: key, ...(process.env.LLM_PROVIDER === 'mock' ? { LLM_PROVIDER: 'auto' } : {}) }); // text backup brain only — never voice
    d.rebuildProviders();
    d.log.info(`OpenAI key saved (${mask(key)}); test ${test.ok ? 'passed' : `failed: ${test.error?.code}`}`);
    return { ok: test.ok, saved: true, masked: mask(key), test };
  });

  api.set('POST /api/setup/openai-key/remove', () => {
    writeEnv({ OPENAI_API_KEY: '' });
    d.rebuildProviders();
    d.log.info('OpenAI key removed');
    return { ok: true };
  });

  /* ---- Anthropic (brain only — Anthropic has no text-to-speech) ---- */
  api.set('POST /api/setup/anthropic-key', async (_req, body) => {
    const key = String(body.key ?? '').trim();
    if (!key) return { ok: false, error: { code: 'empty', message: 'Paste your Anthropic API key first.' } };
    if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) return { ok: false, error: { code: 'format', message: 'That does not look like an Anthropic API key. Keys start with "sk-ant-" (copy it from console.anthropic.com → API Keys).' } };
    const test = await testAnthropicConnection({ ...process.env, ANTHROPIC_API_KEY: key });
    if (!test.ok && test.error && ['invalid_key', 'format'].includes(test.error.code)) return { ok: false, saved: false, test };
    writeEnv({ ANTHROPIC_API_KEY: key, ...(['mock', ''].includes(process.env.LLM_PROVIDER ?? '') ? { LLM_PROVIDER: 'auto' } : {}) });
    d.rebuildProviders();
    d.log.info(`Anthropic key saved (${mask(key)}); test ${test.ok ? 'passed' : `failed: ${test.error?.code}`}`);
    return { ok: test.ok, saved: true, masked: mask(key), test };
  });
  api.set('POST /api/setup/anthropic-key/remove', () => {
    writeEnv({ ANTHROPIC_API_KEY: '' });
    d.rebuildProviders();
    d.log.info('Anthropic key removed');
    return { ok: true };
  });
  api.set('POST /api/setup/test-anthropic', async () => testAnthropicConnection(process.env));

  api.set('GET /api/setup/ai-models', async () => {
    const out: { anthropic: string[]; openai: string[]; error?: string } = { anthropic: [], openai: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4.1-mini'] };
    try { out.anthropic = (await listAnthropicModels(process.env)).filter((m) => /^claude-/.test(m)); } catch (e) { out.error = (e as Error).message.slice(0, 160); }
    if (!out.anthropic.length && process.env.ANTHROPIC_API_KEY) out.anthropic = [DEFAULT_ANTHROPIC_MODEL];
    return out;
  });

  api.set('POST /api/setup/ai', (_req, body) => {
    const up: Record<string, string> = {};
    if (body.provider !== undefined) {
      const p = String(body.provider);
      if (!['auto', 'anthropic', 'openai', 'mock'].includes(p)) return { ok: false, error: { message: 'Unknown provider' } };
      up.LLM_PROVIDER = p;
    }
    const model = (v: unknown) => String(v ?? '').trim().slice(0, 80);
    if (body.anthropicModel !== undefined) { if (!/^[a-z0-9.\-]+$/i.test(model(body.anthropicModel))) return { ok: false, error: { message: 'Bad model name' } }; up.ANTHROPIC_MODEL = model(body.anthropicModel); }
    if (body.openaiModel !== undefined) { if (!/^[a-z0-9.\-]+$/i.test(model(body.openaiModel))) return { ok: false, error: { message: 'Bad model name' } }; up.OPENAI_MODEL = model(body.openaiModel); }
    if (body.fallback !== undefined) up.LLM_FALLBACK = body.fallback ? 'true' : 'false';
    const changed = writeEnv(up);
    if (changed.length) d.rebuildProviders();
    return { ok: true, changed };
  });

  api.set('POST /api/setup/test-openai', async () => testOpenAIConnection(process.env));

  /* ---------------- ElevenLabs voice (section 2) ---------------- */
  api.set('POST /api/setup/elevenlabs-key', async (_req, body) => {
    const key = String(body.key ?? '').trim();
    if (!key) return { ok: false, error: { code: 'empty', message: 'Paste your ElevenLabs API key first.' } };
    if (!/^[A-Za-z0-9_\-]{20,}$/.test(key)) return { ok: false, error: { code: 'format', message: 'That does not look like an ElevenLabs API key (a long string, usually starting "sk_"). Copy it from elevenlabs.io → Developers → API Keys.' } };
    // test BEFORE saving so a typo doesn't replace a working key
    let voices: Awaited<ReturnType<typeof listElevenVoices>> = [];
    try { voices = await listElevenVoices({ ...process.env, ELEVENLABS_API_KEY: key }); }
    catch (e) {
      const ex = explainElevenLabsError(e);
      if (['invalid_key', 'permissions', 'format'].includes(ex.code)) return { ok: false, saved: false, error: ex };
      // network trouble: save anyway so the user is not stuck, but say it is untested
      writeEnv({ ELEVENLABS_API_KEY: key, TTS_PROVIDER: 'elevenlabs' }); d.rebuildProviders();
      d.log.info(`ElevenLabs key saved (${mask(key)}) but NOT tested: ${ex.code}`);
      return { ok: false, saved: true, masked: mask(key), error: ex };
    }
    const best = pickBestVoice(voices);
    writeEnv({ ELEVENLABS_API_KEY: key, TTS_PROVIDER: 'elevenlabs', ...(process.env.ELEVENLABS_VOICE_ID ? {} : { ELEVENLABS_VOICE_ID: voices.find((v) => v.voice_id === DEFAULT_VOICE_ID)?.voice_id ?? best?.voice_id ?? DEFAULT_VOICE_ID }) });
    d.rebuildProviders();
    d.log.info(`ElevenLabs key saved (${mask(key)}); ${voices.length} voices available`);
    return { ok: true, saved: true, masked: mask(key), voices: voices.length };
  });
  api.set('POST /api/setup/elevenlabs-key/remove', () => { writeEnv({ ELEVENLABS_API_KEY: '', TTS_PROVIDER: 'browser' }); d.rebuildProviders(); d.log.info('ElevenLabs key removed'); return { ok: true }; });

  /** Voices this account can use, with the ones matching Hubie's personality first. */
  api.set('GET /api/setup/voices', async () => {
    if (!process.env.ELEVENLABS_API_KEY) return { ok: false, error: { code: 'missing_key', message: 'Save your ElevenLabs key first.' } };
    try {
      const all = await listElevenVoices(process.env);
      const rank = (n: string) => { const i = PREFERRED_VOICE_NAMES.indexOf(n.split(/[\s-]/)[0]); return i < 0 ? 99 : i; };
      const voices = [...all].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      return { ok: true, current: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, recommended: voices.filter((v) => rank(v.name) < 99).slice(0, 6).map((v) => v.voice_id), voices };
    } catch (e) { return { ok: false, error: explainElevenLabsError(e) }; }
  });

  api.set('POST /api/setup/voice', (_req, body) => {
    const up: Record<string, string> = {};
    const num = (k: string, v: unknown, lo: number, hi: number) => { if (v === undefined) return; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); up[k] = String(n); };
    try {
      if (body.voiceId !== undefined) { const v = String(body.voiceId).trim(); if (!/^[A-Za-z0-9]{10,40}$/.test(v)) return { ok: false, error: { message: 'Voice IDs are 20-character codes like IKne3meq5aSn9XLyUdCD (copy it from the list or elevenlabs.io → Voices → ID).' } }; up.ELEVENLABS_VOICE_ID = v; }
      if (body.model !== undefined) { const m = String(body.model); if (!/^eleven_[a-z0-9_]+$/.test(m)) return { ok: false, error: { message: 'Unknown model' } }; up.ELEVENLABS_MODEL = m; }
      num('ELEVENLABS_STABILITY', body.stability, 0, 1); num('ELEVENLABS_SIMILARITY', body.similarity, 0, 1); num('ELEVENLABS_STYLE', body.style, 0, 1); num('ELEVENLABS_SPEED', body.speed, 0.7, 1.2);
      if (body.speakerBoost !== undefined) up.ELEVENLABS_SPEAKER_BOOST = body.speakerBoost ? 'true' : 'false';
    } catch (e) { return { ok: false, error: { message: (e as Error).message } }; }
    writeEnv(up);
    d.rebuildProviders();
    return { ok: true, changed: Object.keys(up) };
  });

  api.set('POST /api/setup/voice-preview', async (_req, body) => {
    if (!process.env.ELEVENLABS_API_KEY) return { ok: false, error: { code: 'missing_key', message: 'Save your ElevenLabs key first. (Without it Hubie can only use the browser voice, which is labelled as a fallback.)' } };
    if (!previewLimiter.canSpend(1)) return { ok: false, error: { message: 'Preview limit reached for this hour (protects your credits).' } };
    previewLimiter.spend(1);
    const voiceId = body.voiceId ? String(body.voiceId) : undefined;
    if (voiceId && !/^[A-Za-z0-9]{10,40}$/.test(voiceId)) return { ok: false, error: { message: 'Bad voice id' } };
    const tone = (String(body.tone ?? 'playful') in EMOTION_STYLES ? String(body.tone ?? 'playful') : 'playful') as keyof typeof EMOTION_STYLES;
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const [k, e] of [['stability', 'ELEVENLABS_STABILITY'], ['similarity', 'ELEVENLABS_SIMILARITY'], ['style', 'ELEVENLABS_STYLE'], ['speed', 'ELEVENLABS_SPEED']] as const) if (body[k] !== undefined && Number.isFinite(Number(body[k]))) env[e] = String(Number(body[k]));
    if (body.model && /^eleven_[a-z0-9_]+$/.test(String(body.model))) env.ELEVENLABS_MODEL = String(body.model);
    const text = tone === 'hyped' ? "Oh my goodness, chat! Did you SEE that?! Absolutely massive! The hat just flew off!" : tone === 'sarcastic' ? 'Oh sure. Another loss. Totally unexpected. I am shocked. Truly.' : String(body.text ?? '').trim().slice(0, 200) || PREVIEW_LINE;
    try {
      const r = await new ElevenLabsTTS(env, new UsageLimiter(0)).synth({ id: crypto.randomUUID().slice(0, 8), text, tone, rate: 1, voice: voiceId }, d.ttsDir);
      return { ok: true, provider: 'elevenlabs', voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, url: `/tts/${path.relative(d.ttsDir, r.file!).split(path.sep).join('/')}`, cached: !!r.cached };
    } catch (e) {
      return { ok: false, error: explainElevenLabsError(e) };
    }
  });

  api.set('POST /api/setup/stream', (_req, body) => {
    const updates: Record<string, string> = {};
    const str = (k: string, v: unknown) => { if (v !== undefined) updates[k] = String(v).trim(); };
    if (body.obs) {
      str('OBS_ENABLED', body.obs.enabled ? 'true' : 'false');
      str('OBS_WS_URL', body.obs.url);
      if (body.obs.password) str('OBS_WS_PASSWORD', body.obs.password);
      if (body.obs.streamServer !== undefined) str('OBS_STREAM_SERVER', body.obs.streamServer);
      if (body.obs.streamKey) str('OBS_STREAM_KEY', body.obs.streamKey);
    }
    if (body.game) {
      // the stream game is the simulated Limbo; 'local-demo' is a developer test page
      const m0 = String(body.game.mode ?? 'limbo-sim');
      str('GAME_ADAPTER', m0 === 'local-demo' ? 'local-demo' : 'limbo-sim');
    }
    if (body.showTitle) str('SHOW_TITLE', String(body.showTitle).slice(0, 60));
    const changed = writeEnv(updates);
    const reload = (prefix: RegExp, role: 'stream-engine' | 'game-agent') => {
      if (changed.some((k) => prefix.test(k))) d.hub.broadcast({ type: 'reload_config', reason: `settings changed: ${changed.join(', ')}` }, [role]);
    };
    reload(/^OBS_/, 'stream-engine');
    reload(/^(GAME_ADAPTER|GAME_FALLBACK)/, 'game-agent');
    if (changed.includes('OBS_ENABLED')) d.health.setEnabled('obs', process.env.OBS_ENABLED === 'true');
    return { ok: true, changed: changed.map((k) => k) };
  });

  api.set('POST /api/setup/test', async (_req, body) => {
    const what = String(body.what ?? '');
    const h = (n: string) => d.health.all().find((c) => c.name === n);
    switch (what) {
      case 'ai': {
        const r = await d.generateTestLine();
        return { ok: !r.error, detail: r.error ? r.error : `${r.provider === 'mock' ? 'Built-in demo lines (no AI key)' : r.provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'} says: “${r.text}”`, text: r.text, provider: r.provider };
      }
      case 'voice': {
        const r = await d.synthTestLine("Testing, testing. One, two, three. The sloth is in the building.");
        return { ok: !r.error && !!r.url, url: r.url, provider: r.provider, detail: r.error ?? (r.url ? `Voice generated by ${r.provider}` : 'No server audio (demo mode uses the browser voice)') };
      }
      case 'avatar': {
        d.hub.broadcast({ type: 'combo', combo: 'celebration' });
        d.hub.broadcast({ type: 'fx', fx: 'sparkles' });
        const n = d.hub.count('overlay') + d.hub.count('avatar') + d.hub.count('control');
        return { ok: n > 0, detail: n > 0 ? `Celebration animation sent to ${n} Hubie screen(s).` : 'No Hubie screen is open. Open the overlay page (button below) and try again.' };
      }
      case 'game': {
        // give a (re)starting game agent a few seconds to report in
        for (let i = 0; i < 16 && (h('game-agent')?.state === 'unknown' || h('game-browser')?.state === 'unknown' || d.hub.count('game-agent') === 0); i++) await new Promise((r) => setTimeout(r, 500));
        const ga = h('game-agent'), gb = h('game-browser');
        const paused = ga?.state === 'degraded' && /paused/.test(ga?.detail ?? '');
        const ok = (ga?.state === 'ok' || paused) && gb?.state === 'ok';
        return { ok, detail: ok ? `Game ready: ${gb?.detail}${paused ? ' (waits for START)' : ''}` : `Game agent: ${ga?.state ?? 'not running'} ${ga?.detail ?? ''} · game browser: ${gb?.state ?? '?'} ${gb?.detail ?? ''}` };
      }
      case 'obs': case 'kick': {
        const c = h(what);
        if (!c || c.state === 'disabled') return { ok: true, skipped: true, detail: `${what === 'obs' ? 'OBS' : 'Kick'} is not enabled.` };
        return { ok: c.state === 'ok', detail: `${c.state}: ${c.detail ?? ''}` };
      }
    }
    return { ok: false, detail: 'unknown test' };
  });

  api.set('POST /api/setup/finish', () => { writeEnv({ SETUP_DONE: 'true' }); return { ok: true }; });
  api.set('POST /api/show/start', () => { writeEnv({ SETUP_DONE: 'true' }); d.start(); return { ok: true, started: true }; });
  api.set('POST /api/show/stop', () => { d.stop(); return { ok: true, started: false }; });
}

/** Write a fresh CONTROL_TOKEN if one is needed (used by the VPS installer via CLI). */
export function ensureEnvFileExists(file: string, example: string) {
  if (!fs.existsSync(file) && fs.existsSync(example)) { fs.copyFileSync(example, file); try { fs.chmodSync(file, 0o600); } catch { /* windows */ } }
}

export type { Situation };
