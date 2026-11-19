/**
 * Hubie controller — the brain and hub.
 *   - serves overlay/avatar/control/setup UI + TTS audio
 *   - WebSocket hub for game-agent, kick-agent, stream-engine and overlay pages
 *   - show/commentary director, speech queue, safety, memory, health, e-stop
 *   - setup wizard API (keys stay server-side)
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTROLLER_PORT, ROOT, ENV_FILE, DATA_DIR, env, envBool, envNum, makeLogger } from '../../../packages/shared/src/node.ts';
import { DEFAULT_HISTORY_BADGE, DEFAULT_AVATAR_SETTINGS, AVATAR_STATES, type AvatarSettings } from '../../../packages/shared/src/protocol.ts';
import type { AudioSettings, MusicTrack, MusicStatus, OverlayTelemetry, ChatMessage, Combo, ComponentName, Expression, GameEvent, OverlayState, HubMessage, ObsReadiness, KickStreamStatus } from '../../../packages/shared/src/protocol.ts';
import { COMBOS, EXPRESSIONS, DEFAULT_APPEARANCE, type Appearance } from '../../../packages/shared/src/protocol.ts';
import { Memory } from '../../../services/memory/src/memory.ts';
import { createLLM, describeBrain, type ResilientLLM } from '../../../services/ai/src/providers.ts';
import { createVoice, type VoiceService } from '../../../services/tts/src/tts.ts';
import { DEFAULT_PERSONALITY, ALL_STYLES } from '../../../services/ai/src/personality.ts';
import { LiveClock, formatLiveTotal } from './liveClock.ts';
import { KeyRing } from '../../../services/tts/src/keyring.ts';
import { registerVoiceKeysApi } from './voiceKeysApi.ts';
import { DEFAULT_VOICE_ID, DEFAULT_MODEL } from '../../../services/tts/src/voicePersonality.ts';
import { checkOutbound } from '../../../services/safety/src/safety.ts';
import { Hub } from './hub.ts';
import { SpeechQueue } from './speech.ts';
import { Director } from './director.ts';
import { HealthRegistry, AvatarMonitor } from './health.ts';
import { registerSetupApi, ensureEnvFileExists } from './setupApi.ts';
import { KickApi, KICK_SCOPES, kickTokenFile, type KickSlot } from '../../../packages/shared/src/kick.ts';
import { TunnelManager } from './tunnel.ts';
import { KickVerifier, buildWizard } from './kickWizard.ts';
import { checkInbound } from '../../../services/safety/src/safety.ts';
import { loadLimboSettings, saveLimboSettings, resetLimboSettings } from '../../../packages/game-adapters/src/limboSettings.ts';
import { writeEnv } from '../../../packages/shared/src/config.ts';

const log = makeLogger('controller');
const DATA = DATA_DIR;
const ESTOP_FILE = path.join(DATA, 'ESTOP');
const TTS_DIR = path.join(DATA, 'tts-cache');
fs.mkdirSync(DATA, { recursive: true });
if (!process.env.HUBIE_ENV_FILE) ensureEnvFileExists(ENV_FILE, path.join(ROOT, '.env.example'));

let stateTimer: NodeJS.Timeout | null = null;
const disabled: ComponentName[] = [];
if (!envBool('KICK_ENABLED')) disabled.push('kick');
if (!envBool('OBS_ENABLED')) disabled.push('obs');
const health = new HealthRegistry(disabled);
health.onChange((c, prev) => {
  const lvl = c.state === 'down' ? 'warn' : 'info';
  log[lvl](`health: ${c.name} ${prev} → ${c.state}${c.detail ? ` (${c.detail})` : ''}`);
  memory.logEvent('health', { name: c.name, state: c.state, detail: c.detail });
  pushState();
});

const memory = new Memory(process.env.HUBIE_DB || path.join(DATA, 'hubie.db'));
const liveClock = new LiveClock(memory);

/* ---------------- AI + voice (rebuilt when the wizard changes settings) ---------------- */
let llm: ResilientLLM;
let voice: VoiceService;
const keyRing = new KeyRing(path.join(DATA_DIR, 'elevenlabs-keys.json'), () => process.env.ELEVENLABS_API_KEY);
const hasVoiceKey = () => !!process.env.ELEVENLABS_API_KEY || keyRing.all().some((k) => k.enabled);
const lipLog: Array<{ id: string; at: number; mode: string; peak: number; activeFrac: number; provider?: string }> = [];
let lastVoiceProvider = '';

function rebuildProviders() {
  llm = createLLM(process.env, (ok, d) => health.set('ai', ok ? 'ok' : 'degraded', d));
  voice = createVoice(process.env, TTS_DIR, (ok, d) => health.set('tts', ok ? 'ok' : 'degraded', d), keyRing);
  health.set('ai', llm.isDemo ? 'degraded' : 'ok', llm.isDemo ? 'No AI key set — using built-in demo lines. Add an Anthropic or OpenAI key in the control center.' : describeBrain(process.env, llm));
  lastVoiceProvider = '';
  health.set('tts', voice.isDemo ? 'degraded' : 'ok', voice.isDemo
    ? `Voice not configured — add an ElevenLabs API key in Control Center section 2 (an Anthropic key does not include text-to-speech). Until then the overlay uses the browser's built-in voice, labelled "Browser voice (fallback — not ElevenLabs)".`
    : `ElevenLabs ${process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5'} · voice ${process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID}`);
  log.info(`providers: LLM=${llm.isDemo ? 'built-in demo lines' : llm.chain.join('→')} TTS=${voice.chain.map((c) => c.name).join('→')}`);
  pushState();
}

const hub = new Hub({
  port: CONTROLLER_PORT,
  staticDir: path.join(ROOT, 'dist'),
  ttsDir: TTS_DIR,
  extraStatic: { '/assets-hubie/': path.join(ROOT, 'assets/hubie'), '/demo-game/': path.join(ROOT, 'assets/demo-game'), '/limbo-sim/': path.join(ROOT, 'assets/limbo-sim'), '/music/': path.join(ROOT, 'assets/audio'), '/music-user/': path.join(DATA_DIR, 'music') },
  controlToken: () => env('CONTROL_TOKEN'),
  overlayToken: () => env('OVERLAY_TOKEN'),
  rootRedirect: () => '/setup', // the control center is the home page
  log,
});


/* ---------------- Streamable cloud mode ----------------
 * Streamable runs a full OBS on an NVIDIA GPU server. The only documented way to put Hubie into it is a Browser Source pointing at
 * a public overlay URL. The overlay page measures itself (fps, frame-time, WebGL renderer) and reports back, so the numbers below come
 * from the browser that is really rendering inside cloud OBS. Dropped frames / encoder load are NOT visible to Hubie — read them in
 * Remote OBS → View → Stats (docs/STREAMABLE-CLOUD.md).
 */
const telemetry = new Map<number, OverlayTelemetry & { at: number; viaToken: boolean; ip: string }>();
hub.onDisconnect((c) => { telemetry.delete(c.id); });
const cloudMode = () => env('STREAM_MODE') === 'streamable-cloud';
function ensureOverlayToken() {
  if (!process.env.OVERLAY_TOKEN) writeEnv({ OVERLAY_TOKEN: crypto.randomBytes(18).toString('hex') });
  return process.env.OVERLAY_TOKEN!;
}
function cloudOverlayUrl() {
  const host = env('PUBLIC_HOST');
  if (!host) return null;
  return `https://${host}/overlay?cloud=1&audio=1&otoken=${encodeURIComponent(ensureOverlayToken())}`;
}
function cloudVerdict() {
  const now = Date.now();
  const rows = [...telemetry.values()].filter((t) => now - t.at < 20_000);
  const cloud = rows.filter((t) => t.cloud && t.viaToken).sort((a, b) => b.at - a.at)[0];
  if (!cloud) return { state: 'waiting' as const, detail: rows.length ? 'Only local/non-cloud overlay pages are connected. Add the overlay URL as a Browser Source in Streamable Remote OBS.' : 'No overlay page has reported in yet.', cloud: null };
  const problems: string[] = [];
  if (cloud.software) problems.push(`the browser is rendering in software (${cloud.gpu}) — no GPU acceleration for browser sources`);
  if (cloud.fps < 54) problems.push(`overlay renders at ${cloud.fps} fps (need ~60)`);
  if (cloud.p95Ms > 25) problems.push(`95th-percentile frame time ${cloud.p95Ms} ms (need ≤ ~20)`);
  if (cloud.w !== 1920 || cloud.h !== 1080) problems.push(`browser source is ${cloud.w}×${cloud.h} (need 1920×1080)`);
  return { state: problems.length ? 'problem' as const : 'ok' as const, detail: problems.length ? problems.join('; ') : `Overlay renders at ${cloud.fps} fps, p95 ${cloud.p95Ms} ms, ${cloud.w}×${cloud.h}, GPU: ${cloud.gpu}.`, cloud };
}
hub.apiHandlers.set('GET /api/cloud/status', () => {
  const v = cloudVerdict();
  return {
    mode: cloudMode() ? 'streamable-cloud' : 'local', publicHost: env('PUBLIC_HOST') || null, overlayUrl: cloudOverlayUrl(),
    overlayTokenSet: !!process.env.OVERLAY_TOKEN, pagesReporting: [...telemetry.values()].filter((t) => Date.now() - t.at < 20_000).map((t) => ({ cloud: t.cloud, viewOnly: t.viaToken, fps: t.fps, w: t.w, h: t.h })), localObsDisabled: cloudMode(), verdict: v,
    kickLive: kickLive ? { live: kickLive.live, viewers: kickLive.viewers, checkedAt: kickLive.checkedAt, error: kickLive.error } : null,
    // what we have NOT verified — shown verbatim in the UI
    unverified: ['Streamable server CPU/RAM/GPU model (no documented API; read it in Remote OBS → View → Stats and the browser GPU string above)', 'Dropped frames and encoder load (Remote OBS Stats dock only)', 'Streamable API/OAuth control (no public documentation found)'],
  };
});
hub.apiHandlers.set('POST /api/cloud/mode', (_r, b) => { writeEnv({ STREAM_MODE: b.cloud ? 'streamable-cloud' : '' }); if (b.cloud) ensureOverlayToken(); return { ok: true, message: b.cloud ? 'Cloud mode on. Restart Hubie once so the local OBS controller stays off.' : 'Local mode.' }; });
hub.apiHandlers.set('POST /api/cloud/rotate-overlay-token', () => { writeEnv({ OVERLAY_TOKEN: crypto.randomBytes(18).toString('hex') }); for (const c of hub.clients) if ((c as any).viewerOnly) c.ws.close(1008, 'token rotated'); return { ok: true, overlayUrl: cloudOverlayUrl(), message: 'New overlay link created. Update the Browser Source URL in Streamable Remote OBS.' }; });


/* ---------------- ON AIR: accumulated LIVE time ---------------- */
function liveConfirm() {
  const now = Date.now();
  if (process.env.KICK_ENABLED === 'true') {
    if (!kickLive || kickLive.error) return { live: false, source: 'kick' as const, fresh: false, detail: kickLive?.error ? `Kick status error: ${kickLive.error}` : 'Kick status not received yet' };
    return { live: !!kickLive.live, source: 'kick' as const, fresh: now - kickLive.checkedAt < 100_000, detail: kickLive.live ? 'Kick API reports the channel live' : 'Kick API reports the channel offline' };
  }
  const r = obsState.readiness; // Kick isn't set up: OBS's own "streaming" flag is the best evidence available
  if (r?.connected) return { live: !!r.streaming, source: 'obs' as const, fresh: true, detail: r.streaming ? 'OBS output is active (Kick not connected, so not independently confirmed)' : 'OBS is not streaming' };
  return { live: false, source: 'none' as const, fresh: false, detail: 'No live signal (connect Kick in Section 4/5, or OBS)' };
}
setInterval(() => { const was = liveClock.live; liveClock.tick(liveConfirm()); if (was !== liveClock.live) log.info(`ON AIR: ${liveClock.live ? 'stream confirmed LIVE' : 'stream no longer live'} (${liveClock.lastDetail})`); pushState(); }, 15_000).unref();
hub.apiHandlers.set('GET /api/live/stats', () => ({ ok: true, ...liveClock.summary(), label: formatLiveTotal(liveClock.totalMs), appUptimeMs: Math.round(process.uptime() * 1000), note: 'Counts only time the stream is confirmed live. App uptime is shown separately and never counted.' }));


/* ---------------- Established-history badge: "150+ HOURS ON AIR" (operator-declared, static) ---------------- */
function historyBadge() {
  const v = memory.get<{ enabled?: boolean; text?: string }>('history_badge', {});
  return { enabled: v?.enabled ?? DEFAULT_HISTORY_BADGE.enabled, text: (typeof v?.text === 'string' && v.text.trim() ? v.text.trim().slice(0, 40) : DEFAULT_HISTORY_BADGE.text) };
}
hub.apiHandlers.set('GET /api/history-badge', () => ({ ok: true, ...historyBadge(), note: 'Shown on the overlay at all times as Hubie\'s established history. It is a stated figure, not measured by Hubie, and is independent of the live counter and of stream disconnects.' }));
hub.apiHandlers.set('POST /api/history-badge', (_r, b) => { const c = historyBadge(); memory.set('history_badge', { enabled: b.enabled === undefined ? c.enabled : !!b.enabled, text: b.text === undefined ? c.text : String(b.text) }); pushState(); return { ok: true, ...historyBadge() }; });

/* ---------------- Personality (Section 12) ---------------- */
hub.apiHandlers.set('GET /api/personality', () => ({
  ok: true, settings: director.personality, defaults: DEFAULT_PERSONALITY, lastHumour: director.lastHumour, humourStyles: ALL_STYLES,
  linesSinceHat: director.linesSinceHat, hatBlocked: speech.stats.hatBlocked ?? 0, regenerated: speech.stats.regenerated, dropped: speech.stats.dropped,
  conversation: director.conv.turns.slice(-12).reverse().map((t) => ({ user: t.user, said: t.text, reply: t.reply ?? null, tone: t.tone, at: t.at })), topics: director.conv.topics(),
}));
hub.apiHandlers.set('POST /api/personality', (_r, b) => { const s = director.setPersonality(b ?? {}); director.persist(); return { ok: true, settings: s }; });
hub.apiHandlers.set('POST /api/personality/reset', () => ({ ok: true, settings: director.setPersonality(DEFAULT_PERSONALITY) }));


/* ---------------- Audio settings + music playlist (Section 13) ---------------- */
const DEFAULT_AUDIO: AudioSettings = { musicEnabled: true, musicVolume: 22, voiceVolume: 100, duckEnabled: true, duckLevel: 30, mood: 'auto', disabledTracks: [] };
const clampPct = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d; };
let audioCache: AudioSettings | null = null;
function audioSettings(): AudioSettings {
  if (audioCache) return audioCache;
  const s = { ...DEFAULT_AUDIO, ...memory.get<Partial<AudioSettings>>('audio_settings', {}) };
  audioCache = { musicEnabled: !!s.musicEnabled, musicVolume: clampPct(s.musicVolume, 22), voiceVolume: clampPct(s.voiceVolume, 100), duckEnabled: !!s.duckEnabled, duckLevel: clampPct(s.duckLevel, 30),
    mood: (['auto', 'funky', 'electronic', 'chill', 'hype', 'ambient'] as const).includes(s.mood as any) ? s.mood : 'auto', disabledTracks: Array.isArray(s.disabledTracks) ? s.disabledTracks.map(String).slice(0, 200) : [] };
  return audioCache;
}
let tracksCache: { at: number; v: MusicTrack[] } | null = null;
function musicTracks(): MusicTrack[] {
  if (tracksCache && Date.now() - tracksCache.at < 20_000) return tracksCache.v;
  const out: MusicTrack[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/audio/playlist.json'), 'utf8'));
    for (const t of j.tracks ?? []) if (fs.existsSync(path.join(ROOT, 'assets/audio', t.file))) out.push({ id: t.id, url: `/music/${t.file}`, title: t.title, mood: t.mood, seconds: t.seconds });
  } catch { /* no bundled music */ }
  try { // your own licensed tracks: drop mp3/ogg/wav/m4a files into data/music
    const dir = path.join(DATA_DIR, 'music');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/\.(mp3|ogg|wav|m4a)$/i.test(f)) out.push({ id: `user:${f}`, url: `/music-user/${encodeURIComponent(f)}`, title: f.replace(/\.[^.]+$/, ''), mood: 'user', user: true });
  } catch { /* ignore */ }
  tracksCache = { at: Date.now(), v: out };
  return out;
}
const MOOD_BY_SEGMENT: Record<string, string> = { welcome: 'funky', gameplay: 'electronic', chat_time: 'chill', funny: 'funky', bonus_hype: 'hype', viewer_questions: 'chill', random_moment: 'chill', break: 'ambient', return: 'funky', shoutouts: 'funky', celebration: 'hype' };
let musicStatus: MusicStatus | null = null;
hub.apiHandlers.set('GET /api/audio', () => ({ ok: true, settings: audioSettings(), tracks: musicTracks(), autoMood: MOOD_BY_SEGMENT[director.s.segment] ?? 'funky', status: musicStatus, musicFolder: path.join(DATA_DIR, 'music'), license: 'Bundled tracks are original works generated by scripts/make-music.py (CC0). Add your own only if you hold the rights/licence for livestream use.' }));
hub.apiHandlers.set('POST /api/audio', (_r, b) => {
  const cur = audioSettings(); const n = { ...cur };
  if (b.musicEnabled !== undefined) n.musicEnabled = !!b.musicEnabled;
  if (b.duckEnabled !== undefined) n.duckEnabled = !!b.duckEnabled;
  for (const k of ['musicVolume', 'voiceVolume', 'duckLevel'] as const) if (b[k] !== undefined) n[k] = clampPct(b[k], cur[k]);
  if (b.mood !== undefined) n.mood = b.mood;
  if (Array.isArray(b.disabledTracks)) n.disabledTracks = b.disabledTracks;
  memory.set('audio_settings', n); audioCache = null; pushState(); return { ok: true, settings: audioSettings() };
});


/* ---------------- Avatar settings + live animation state (Section 14) ---------------- */
let avatarCache: AvatarSettings | null = null;
function avatarSettings(): AvatarSettings {
  if (avatarCache) return avatarCache;
  const s = { ...DEFAULT_AVATAR_SETTINGS, ...memory.get<Partial<AvatarSettings>>('avatar_settings', {}) };
  const n = Number(s.intensity);
  avatarCache = { intensity: Number.isFinite(n) ? Math.max(40, Math.min(160, Math.round(n))) : 100, idleLife: !!s.idleLife, talkGestures: !!s.talkGestures, reactions: !!s.reactions, cues: !!s.cues };
  return avatarCache;
}
const avatarStates = { now: 'idle' as string, since: Date.now(), counts: {} as Record<string, number>, lastChange: [] as Array<{ state: string; at: number }> };
hub.apiHandlers.set('GET /api/avatar', () => ({ ok: true, settings: avatarSettings(), defaults: DEFAULT_AVATAR_SETTINGS, state: avatarStates.now, since: avatarStates.since, counts: avatarStates.counts, recent: avatarStates.lastChange.slice(-12).reverse(), states: AVATAR_STATES }));
hub.apiHandlers.set('POST /api/avatar', (_r, b) => {
  const cur = avatarSettings(); const n = { ...cur };
  if (b.intensity !== undefined) n.intensity = Number(b.intensity);
  for (const k of ['idleLife', 'talkGestures', 'reactions', 'cues'] as const) if (b[k] !== undefined) n[k] = !!b[k];
  memory.set('avatar_settings', n); avatarCache = null; pushState(); return { ok: true, settings: avatarSettings() };
});
hub.apiHandlers.set('POST /api/avatar/preview', (_r, b) => {
  const st = String(b.state ?? '');
  const map: Record<string, () => void> = {
    listening: () => hub.broadcast({ type: 'avatar_cue', cue: 'listening' }), thinking: () => hub.broadcast({ type: 'avatar_cue', cue: 'thinking' }),
    laughing: () => hub.broadcast({ type: 'combo', combo: 'laughing' }), excited: () => hub.broadcast({ type: 'expression', expression: 'excited', holdMs: 3000 }),
    surprised: () => hub.broadcast({ type: 'combo', combo: 'surprise' }), disappointed: () => hub.broadcast({ type: 'combo', combo: 'bad_result' }),
    celebrating: () => hub.broadcast({ type: 'combo', combo: 'celebration' }), reacting: () => hub.broadcast({ type: 'combo', combo: 'suspicious' }),
  };
  if (!map[st]) return { ok: false, error: { message: 'Pick one of: ' + Object.keys(map).join(', ') } };
  map[st](); return { ok: true };
});

/* ---------------- emergency stop ---------------- */
let estop = fs.existsSync(ESTOP_FILE);
function setEstop(on: boolean, reason: string) {
  if (on === estop) return;
  estop = on;
  log.warn(`EMERGENCY STOP ${on ? 'ENGAGED' : 'released'}: ${reason}`);
  memory.logEvent('estop', { on, reason });
  if (on) {
    try { fs.writeFileSync(ESTOP_FILE, reason); } catch { /* ignore */ }
    speech.clear();
    hub.broadcast({ type: 'stop_speech', reason: 'estop' });
    hub.broadcast({ type: 'game_command', command: 'pause' }, ['game-agent']);
  } else {
    try { fs.unlinkSync(ESTOP_FILE); } catch { /* ignore */ }
    if (director.started) hub.broadcast({ type: 'game_command', command: 'resume' }, ['game-agent']);
  }
  hub.broadcast({ type: 'estop', on, reason });
  pushState();
}
setInterval(() => { const f = fs.existsSync(ESTOP_FILE); if (f !== estop) setEstop(f, 'ESTOP file'); }, 1000).unref();

/* ---------------- speech ---------------- */
let caption: string | undefined;
const speech = new SpeechQueue({
  llm: () => llm, voice: () => voice, memory, log, ttsDir: TTS_DIR,
  context: (sit) => director.contextForLLM(sit),
  play: (u) => {
    hub.broadcast({ type: 'say', utterance: u }, ['overlay', 'avatar', 'control']);
    return hub.count('overlay') + hub.count('avatar') > 0;
  },
  stop: (reason) => hub.broadcast({ type: 'stop_speech', reason }),
  caption: (t) => { caption = t; pushState(); },
  isStopped: () => estop,
  cue: (c) => { if (avatarSettings().cues) hub.broadcast({ type: 'avatar_cue', cue: c }, ['overlay', 'avatar', 'control']); },
});

/* ---------------- chat out (rate-limited + safety) ---------------- */
let lastChatOut = 0;
function sendChat(text: string) {
  if (estop || !envBool('KICK_ENABLED')) return;
  const v = checkOutbound(text);
  if (!v.ok) { log.warn(`chat out blocked: ${v.reason}`); return; }
  const now = Date.now();
  if (now - lastChatOut < envNum('KICK_MIN_SEND_INTERVAL_SEC', 6) * 1000) return;
  lastChatOut = now;
  hub.broadcast({ type: 'chat_out', text: v.text! }, ['kick-agent']);
  director.addHubieChatLine(v.text!);
}

/* ---------------- director ---------------- */
const director = new Director({
  memory, speech, log,
  requestRound: () => hub.broadcast({ type: 'game_command', command: 'play_round' }, ['game-agent']),
  sendChat,
  setExpression: (e, holdMs) => hub.broadcast({ type: 'expression', expression: e, holdMs }, ['overlay', 'avatar', 'control']),
  broadcast: (m) => { hub.broadcast(m, ['overlay', 'avatar', 'control']); pushState(); },
  onState: () => pushState(),
  isStopped: () => estop,
  gameAgentOnline: () => hub.count('game-agent') > 0 && health.get('game-agent').state !== 'down',
  roundIntervalMs: (process.env.ROUND_INTERVAL_SEC ? envNum('ROUND_INTERVAL_SEC', 7) : loadLimboSettings().roundDelaySec) * 1000,
  chatEnabled: () => envBool('KICK_ENABLED'),
  autoStart: envBool('AUTO_START'),
  pauseGame: (p) => hub.broadcast({ type: 'game_command', command: p ? 'pause' : 'resume' }, ['game-agent']),
});
rebuildProviders();

/* ---------------- voice + lip-sync evidence (from overlay pages) ---------------- */
function voiceLabel(): string {
  const real = lastVoiceProvider || voice?.primaryName;
  if (real === 'elevenlabs') return `ElevenLabs voice · ${process.env.ELEVENLABS_VOICE_NAME || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID}`;
  return 'Browser voice (fallback — not ElevenLabs)';
}

/* ---------------- Kick (official OAuth 2.1 + PKCE; tokens stay server-side in data/kick-tokens.json) ---------------- */
const kickActivity: Omit<Extract<HubMessage, { type: 'kick_activity' }>, 'type'> = {};
let kickLive: KickStreamStatus | undefined;
const kickApi = () => new KickApi({ clientId: process.env.KICK_CLIENT_ID ?? '', clientSecret: process.env.KICK_CLIENT_SECRET ?? '', tokenFile: kickTokenFile(DATA), log: (m) => log.info(m) });
const kickRedirectUri = () => process.env.KICK_REDIRECT_URI || `http://localhost:${CONTROLLER_PORT}/api/kick/callback`;
const tunnel = new TunnelManager({ dataDir: DATA, port: () => envNum('KICK_WEBHOOK_PORT', 8788), log, onChange: () => hub.broadcast({ type: 'log', level: 'info', msg: 'tunnel status changed', from: 'controller' }, ['test']) });
const kickVerifier = new KickVerifier(DATA);
let kickTestStartedAt: number | undefined;
/** The public address Kick is (supposed to be) using right now. */
const kickAddress = () => (process.env.KICK_TUNNEL === 'cloudflared' ? tunnel.status().webhookUrl ?? '' : process.env.KICK_WEBHOOK_URL ?? '');
const kickWizard = () => buildWizard({ env: process.env, accounts: kickApi().accounts() as any, activity: kickActivity, agentOnline: [...hub.clients].some((c) => c.role === 'kick-agent'), tunnel: tunnel.status(), verified: kickVerifier.v, address: kickAddress(), now: Date.now(), testStartedAt: kickTestStartedAt });
const syncTunnel = () => { if (process.env.KICK_ENABLED === 'true' && process.env.KICK_TUNNEL === 'cloudflared') void tunnel.start(); else tunnel.stop(); };
const kickPending = new Map<string, { slot: KickSlot; verifier: string; at: number }>();
function kickPublic() {
  const e = process.env;
  return {
    enabled: e.KICK_ENABLED === 'true', channel: e.KICK_CHANNEL ?? '', clientIdSet: !!e.KICK_CLIENT_ID, clientSecretSet: !!e.KICK_CLIENT_SECRET,
    redirectUri: kickRedirectUri(), webhookUrl: e.KICK_WEBHOOK_URL ?? '', tunnel: e.KICK_TUNNEL ?? '', tunnelStatus: tunnel.status(), wizard: kickWizard(), autoModerate: e.KICK_AUTO_MODERATE !== 'false',
    accounts: kickApi().accounts(), scopes: KICK_SCOPES, health: health.get('kick'), live: kickLive ?? null, ...kickActivity,
  };
}
const kickCmd = (m: Omit<Extract<HubMessage, { type: 'kick_command' }>, 'type'>) => {
  if (![...hub.clients].some((c) => c.role === 'kick-agent')) return false;
  hub.broadcast({ type: 'kick_command', ...m }, ['kick-agent']);
  return true;
};

/* ---------------- OBS (reports from stream-engine; never contains the stream key) ---------------- */
const obsState: { readiness?: ObsReadiness; lastTest?: { ok: boolean; detail: string; at: number }; lastError?: { message: string; at: number } } = {};
const obsCmd = (command: 'start_stream' | 'stop_stream' | 'setup_scene' | 'status' | 'configure_output' | 'performance_test', seconds?: number) => {
  if (![...hub.clients].some((c) => c.role === 'stream-engine')) return false;
  hub.broadcast({ type: 'obs_command', command, seconds }, ['stream-engine']);
  return true;
};

/* ---------------- appearance (control center → F) ---------------- */
function readAppearance(): Appearance {
  try { return { ...DEFAULT_APPEARANCE, ...JSON.parse(process.env.APPEARANCE_JSON || '{}') }; } catch { return { ...DEFAULT_APPEARANCE }; }
}
hub.apiHandlers.set('POST /api/appearance', (_req, body) => {
  const cur = readAppearance();
  const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
  const text = (v: unknown, d: string) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, 160) : d);
  const next: Appearance = {
    avatarSize: pick(body.avatarSize, ['small', 'medium', 'large'] as const, cur.avatarSize),
    layout: pick(body.layout, ['game-left', 'game-right'] as const, cur.layout),
    chatPanel: typeof body.chatPanel === 'boolean' ? body.chatPanel : cur.chatPanel,
    subtitles: typeof body.subtitles === 'boolean' ? body.subtitles : cur.subtitles,
    intensity: pick(body.intensity, ['calm', 'normal', 'lively'] as const, cur.intensity),
    rgText: text(body.rgText, cur.rgText) || DEFAULT_APPEARANCE.rgText,   // notices can be edited, never removed
    ageNotice: text(body.ageNotice, cur.ageNotice) || DEFAULT_APPEARANCE.ageNotice,
  };
  writeEnv({ APPEARANCE_JSON: JSON.stringify(next) });
  if (typeof body.title === 'string' && body.title.trim()) writeEnv({ SHOW_TITLE: body.title.replace(/[<>]/g, '').trim().slice(0, 60) });
  pushState();
  return { ok: true, appearance: next };
});

/* ---------------- game status (from game-agent) ---------------- */
let gameStatus: Extract<HubMessage, { type: 'game_status' }>['status'] | undefined;

/* ---------------- overlay state ---------------- */
function buildState(): OverlayState {
  const s = director.s;
  return {
    segment: s.segment, segmentTitle: director.segmentTitle, showTitle: env('SHOW_TITLE', "Hubie's House Party"),
    chat: director.chatLog, lastRound: s.lastRound, stats: s.stats, gameName: s.game, gameSimulated: s.gameSimulated,
    caption, health: health.all(), emergencyStop: estop, testChatEnabled: envBool('ALLOW_TEST_CHAT', true),
    recentRounds: director.recentRounds, showStarted: director.started, demoMode: !!(llm?.isDemo || voice?.isDemo),
    voiceLabel: voiceLabel(),
    chatConnected: health.get('kick').state === 'ok' && !!kickVerifier.v.receiveAt && !!kickVerifier.v.sendAt, segmentSeq: s.segmentSeq,
    platformLive: kickLive ? kickLive.live : undefined,
    breakEndsAt: s.segment === 'break' ? s.segmentEndsAt : undefined,
    gameSource: gameStatus?.source ?? 'none',
    brain: describeBrain(process.env, llm),
    appearance: readAppearance(),
    avatarSettings: avatarSettings(),
    audio: { settings: audioSettings(), tracks: musicTracks(), autoMood: MOOD_BY_SEGMENT[s.segment] ?? 'funky' },
    onAir: { live: liveClock.live, totalMs: liveClock.totalMs, currentMs: liveClock.currentMs, asOf: Date.now(), label: formatLiveTotal(liveClock.totalMs), milestone: liveClock.reachedMilestone, sessions: liveClock.sessions.length, reconnects: liveClock.reconnects, source: liveClock.lastSource, history: historyBadge() },
  };
}
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    hub.broadcast({ type: 'overlay_state', state: buildState() }, ['overlay', 'avatar', 'control', 'stream-engine', 'test']);
  }, 120);
}
setInterval(pushState, 3000).unref();

/* ---------------- hub messages ---------------- */
hub.onConnect((c) => {
  if (c.role === 'overlay' || c.role === 'avatar') { avatarMon.connected(c.id); }
  hub.send(c, { type: 'overlay_state', state: buildState() });
  if (c.role === 'game-agent') hub.send(c, { type: 'game_command', command: director.started && !estop ? 'resume' : 'pause' });
});

let testChatSeq = 0;
hub.on((c, m) => {
  const authorized = (c as any).authorized as boolean;
  switch (m.type) {
    case 'heartbeat': {
      const isOverlay = c.role === 'overlay' || c.role === 'avatar';
      // avatar/audio health may only come from real overlay pages — never from the control panel or setup page
      if (m.component === 'avatar' || m.component === 'audio') {
        if (!isOverlay) break;
        if (m.component === 'avatar') { avatarMon.beat(c.id); updateAvatarHealth(); break; }
      }
      if (m.component) health.set(m.component, m.state ?? 'ok', m.detail);
      break;
    }
    case 'game_event':
      if (['game-agent', 'test'].includes(c.role)) {
        memory.logEvent('game', m.event);
        hub.broadcast(m, ['overlay', 'avatar', 'control', 'test']);
        director.onGameEvent(m.event);
      }
      break;
    case 'game_frame':
      if (c.role === 'game-agent') hub.broadcast(m, ['overlay', 'control']);
      break;
    case 'obs_report':
      if (c.role === 'stream-engine') {
        if (m.readiness) obsState.readiness = m.readiness;
        if (m.result) obsState.lastTest = { ...m.result, at: Date.now() };
        if (m.error) obsState.lastError = { message: m.error, at: Date.now() };
        hub.broadcast(m, ['control', 'test']);
      }
      break;
    case 'kick_activity':
      if (c.role === 'kick-agent') {
        const { type: _t, ...rest } = m;
        Object.assign(kickActivity, rest);
        kickVerifier.observe(kickActivity, kickAddress());
        hub.broadcast(m, ['control', 'test']);
      }
      break;
    case 'kick_status':
      if (c.role === 'kick-agent') { kickLive = m.status; pushState(); }
      break;
    case 'game_status':
      if (c.role === 'game-agent') { gameStatus = m.status; hub.broadcast(m, ['control', 'test']); }
      break;
    case 'chat_in':
      if (c.role === 'kick-agent') {
        const msg = { ...m.message, source: 'kick' as const };
        // moderation: abusive messages and links are ignored by Hubie and (optionally) removed from Kick chat
        const v = checkInbound(msg.text);
        if (!v.ok && (v.reason === 'abusive' || v.link) && process.env.KICK_AUTO_MODERATE !== 'false') kickCmd({ command: 'delete_message', messageId: msg.id });
        hub.broadcast({ type: 'chat_in', message: msg }, ['test']); director.onChat(msg);
      }
      break;
    case 'avatar_state': if (c.role === 'overlay') { avatarStates.now = m.state; avatarStates.since = Date.now(); avatarStates.counts[m.state] = (avatarStates.counts[m.state] ?? 0) + 1; avatarStates.lastChange.push({ state: m.state, at: Date.now() }); if (avatarStates.lastChange.length > 50) avatarStates.lastChange.shift(); } break;
    case 'music_status': if (c.role === 'overlay') musicStatus = m.s; break;
    case 'overlay_telemetry':
      if (c.role === 'overlay' || c.role === 'avatar') telemetry.set(c.id, { ...m.t, at: Date.now(), viaToken: !!(c as any).viewerOnly, ip: c.ip });
      break;
    case 'speech_started':
      health.set('audio', 'ok');
      break;
    case 'speech_ended':
      if (m.error) health.set('audio', 'degraded', m.error);
      if (m.lip && (c.role === 'overlay' || c.role === 'avatar')) {
        lipLog.push({ id: m.id, at: Date.now(), ...m.lip });
        if (lipLog.length > 60) lipLog.shift();
        if (m.lip.provider) lastVoiceProvider = m.lip.provider;
      }
      speech.ack(m.id);
      break;
    case 'log':
      log[m.level](`[${m.from ?? c.role}] ${m.msg}`);
      break;
    case 'control':
      if (!authorized) { log.warn(`unauthorized control from client #${c.id}`); return; }
      handleControl(m.action, m.payload ?? {});
      break;
    case 'estop':
      if (authorized) setEstop(m.on, m.reason);
      break;
  }
});

function handleControl(action: string, p: Record<string, unknown>) {
  switch (action) {
    case 'trigger_game_event': {
      // Manual test event from the control panel — always flagged simulated.
      const outcome = (p.outcome as 'win' | 'loss') ?? (Math.random() < 0.5 ? 'win' : 'loss');
      const multiplier = Number(p.multiplier ?? (outcome === 'win' ? 2 : 0));
      const details = outcome === 'loss' && p.nearMiss ? { target: 2, rolled: 1.93 } : undefined;
      const ev: GameEvent = {
        kind: p.kind === 'bonus' ? 'bonus_triggered' : 'round_result', game: 'Manual Test', adapter: 'control-panel', simulated: true, at: Date.now(),
        round: { roundId: `manual-${Date.now()}`, game: 'Manual Test', outcome, multiplier, stake: 1, payout: outcome === 'win' ? multiplier : 0, details },
      };
      hub.broadcast({ type: 'game_event', event: ev }, ['overlay', 'avatar', 'control']);
      director.onGameEvent(ev);
      break;
    }
    case 'say':
      if (typeof p.text === 'string') director.say({ text: p.text.slice(0, 300), expression: (p.expression as Expression) ?? 'speaking', tone: 'relaxed', priority: 80, interrupt: true, reason: 'operator say', kind: 'system' });
      break;
    case 'expression':
      if (EXPRESSIONS.includes(p.expression as Expression)) hub.broadcast({ type: 'expression', expression: p.expression as Expression, holdMs: Number(p.holdMs ?? 3000) });
      break;
    case 'combo':
      if (COMBOS.includes(p.combo as Combo)) hub.broadcast({ type: 'combo', combo: p.combo as Combo });
      break;
    case 'test_chat': {
      if (!envBool('ALLOW_TEST_CHAT', true)) { log.warn('test chat disabled'); return; }
      const user = String(p.user ?? 'local_tester').replace(/[^\w]/g, '').slice(0, 25) || 'local_tester';
      const msg: ChatMessage = { id: `test-${Date.now()}-${testChatSeq++}`, user, userId: `test:${user}`, text: String(p.text ?? '').slice(0, 300), at: Date.now(), source: 'local-test' };
      director.onChat(msg);
      break;
    }
    case 'emergency_stop': setEstop(true, String(p.reason ?? 'control panel')); break;
    case 'resume': setEstop(false, 'control panel'); break;
    case 'next_segment': director.nextSegment(); break;
    case 'start_show': director.start(); break;
    case 'stop_show': director.stop(); break;
    case 'obs_start': if (p.confirm === 'GO LIVE') hub.broadcast({ type: 'obs_command', command: 'start_stream' }, ['stream-engine']); else log.warn('obs_start ignored: missing GO LIVE confirmation'); break;
    case 'obs_stop': hub.broadcast({ type: 'obs_command', command: 'stop_stream' }, ['stream-engine']); break;
    case 'obs_setup': hub.broadcast({ type: 'obs_command', command: 'setup_scene' }, ['stream-engine']); break;
    case 'restart_game_browser': hub.broadcast({ type: 'game_command', command: 'restart_browser' }, ['game-agent']); break;
    case 'game_pause': hub.broadcast({ type: 'game_command', command: 'pause' }, ['game-agent']); break;
    case 'game_resume': if (director.started && !estop) hub.broadcast({ type: 'game_command', command: 'resume' }, ['game-agent']); break;
  }
}

/* ---------------- HTTP API ---------------- */
hub.apiHandlers.set('GET /api/health', () => ({
  ok: true, estop, started: director.started, components: health.all(), speech: speech.stats,
  llm: { provider: llm.name, chain: llm.chain, brain: describeBrain(process.env, llm), demo: llm.isDemo, last: llm.lastProvider, lastError: llm.lastError, lastErrorCode: llm.lastErrorCode, usage: llm.usage },
  voice: { chain: voice.chain.map((c) => c.name), demo: voice.isDemo, lastError: voice.lastError, lastErrorCode: voice.lastErrorCode },
  clients: [...hub.clients].map((c) => ({ id: c.id, role: c.role, audio: c.audio })), segment: director.s.segment, stats: director.s.stats,
  memory: { rssMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) },
}));
/* ---------------- Monitoring (Section 16): process load sampled every 5 s, bounded history ---------------- */
const errStr = (e: unknown) => (e == null || e === '' ? null : typeof e === 'string' ? e : String((e as Error).message ?? e));
const monitorSamples: Array<{ at: number; rssMB: number; heapMB: number; cpuPct: number; lagMs: number; queue: number }> = [];
{
  let lastCpu = process.cpuUsage(), lastAt = Date.now(), expect = Date.now() + 5000;
  setInterval(() => {
    const now = Date.now(); const c = process.cpuUsage(lastCpu); const wall = Math.max(1, now - lastAt);
    const m = process.memoryUsage();
    monitorSamples.push({ at: now, rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), cpuPct: Math.round(((c.user + c.system) / 1000 / wall) * 1000) / 10, lagMs: Math.max(0, now - expect), queue: speech.length });
    if (monitorSamples.length > 720) monitorSamples.shift(); // one hour
    lastCpu = process.cpuUsage(); lastAt = now; expect = now + 5000;
  }, 5000).unref();
}
hub.apiHandlers.set('GET /api/monitor', () => {
  const last = monitorSamples[monitorSamples.length - 1];
  const avg = (k: 'cpuPct' | 'lagMs') => monitorSamples.length ? Math.round((monitorSamples.reduce((a, x) => a + x[k], 0) / monitorSamples.length) * 10) / 10 : 0;
  const first = monitorSamples[0];
  return {
    ok: true, uptimeSec: Math.round(process.uptime()), node: process.version, pid: process.pid,
    now: last ?? null, avgCpuPct: avg('cpuPct'), avgLagMs: avg('lagMs'), maxLagMs: monitorSamples.reduce((a, x) => Math.max(a, x.lagMs), 0),
    rssGrowthMB: last && first ? last.rssMB - first.rssMB : 0, windowSec: first && last ? Math.round((last.at - first.at) / 1000) : 0,
    series: monitorSamples.filter((_, i) => i % 6 === 0).slice(-120),
    speech: { queued: speech.length, cap: 10, ...speech.stats }, estop,
    llm: { provider: llm.name, last: llm.lastProvider, lastError: errStr(llm.lastError), lastErrorCode: llm.lastErrorCode ?? null, usage: llm.usage },
    voice: { engine: voice.activeEngine, lastOkAt: voice.lastOkAt, served: voice.served, silent: voice.silentCount, lastError: errStr(voice.lastError), charsSent: keyRing.totalChars, estimatedCredits: keyRing.estimatedCredits(process.env.ELEVENLABS_MODEL || DEFAULT_MODEL), failovers: keyRing.history.length, keyErrors: keyRing.errors.slice(-10).reverse() },
    music: musicStatus, avatarState: avatarStates.now,
    clients: [...hub.clients].map((c) => ({ role: c.role, audio: c.audio })),
    components: health.all(),
  };
});
hub.apiHandlers.set('GET /api/state', () => buildState());
hub.apiHandlers.set('GET /api/obs', () => ({ enabled: process.env.OBS_ENABLED === 'true', url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455', passwordSet: !!process.env.OBS_WS_PASSWORD, streamKeySaved: !!process.env.OBS_STREAM_KEY, health: health.get('obs'), ...obsState }));
hub.apiHandlers.set('POST /api/obs/settings', (_req, body) => {
  const up: Record<string, string> = {};
  if (body.enabled !== undefined) up.OBS_ENABLED = body.enabled ? 'true' : 'false';
  if (body.url !== undefined) { const u = String(body.url).trim(); if (u && !/^wss?:\/\/[^\s]+$/.test(u)) return { ok: false, error: { message: 'The OBS address looks like ws://127.0.0.1:4455' } }; up.OBS_WS_URL = u; }
  if (body.password) up.OBS_WS_PASSWORD = String(body.password);
  if (body.streamServer !== undefined) { const u = String(body.streamServer).trim(); if (u && !/^rtmps?:\/\/[^\s]+$/i.test(u)) return { ok: false, error: { message: 'The Kick Stream URL starts with rtmps:// — copy it from kick.com → Dashboard → Settings → Stream URL & Key.' } }; up.OBS_STREAM_SERVER = u; }
  if (body.streamKey) { const k = String(body.streamKey).trim(); if (k.length < 8 || /\s/.test(k)) return { ok: false, error: { message: 'That stream key looks incomplete. Copy it again with the copy button on Kick.' } }; up.OBS_STREAM_KEY = k; }
  if (body.clearStreamKey) up.OBS_STREAM_KEY = '';
  const changed = writeEnv(up);
  if (changed.length) hub.broadcast({ type: 'reload_config', reason: 'OBS settings changed' }, ['stream-engine']);
  if (changed.includes('OBS_ENABLED')) health.setEnabled('obs', process.env.OBS_ENABLED === 'true');
  return { ok: true, changed: changed.map((k) => (k === 'OBS_STREAM_KEY' || k === 'OBS_WS_PASSWORD' ? `${k} (saved, hidden)` : k)) };
});
const obsApi = (cmd: Parameters<typeof obsCmd>[0], msg: string, seconds?: number) => () => obsCmd(cmd, seconds) ? { ok: true, message: msg } : { ok: false, error: { message: process.env.OBS_ENABLED === 'true' ? 'The stream engine is not running yet — wait a few seconds.' : 'Turn on OBS control first.' } };
hub.apiHandlers.set('POST /api/obs/check', obsApi('status', 'Checking OBS…'));
hub.apiHandlers.set('POST /api/obs/setup', obsApi('setup_scene', 'Creating the "Hubie Live" scene with the overlay browser source…'));
hub.apiHandlers.set('POST /api/obs/configure-output', obsApi('configure_output', 'Applying Kick’s 1080p60 settings (1920×1080, 60 fps, x264 CBR 6,000 kbps, keyframe 2 s) and reading them back from OBS…'));
hub.apiHandlers.set('POST /api/obs/performance-test', obsApi('performance_test', 'Running a 30-second LOCAL test recording (nothing is broadcast) to measure frame rate and encoder load…', 30));
hub.apiHandlers.set('POST /api/obs/start', (_req, body) => {
  if (body.confirm !== 'GO LIVE') return { ok: false, error: { code: 'confirm', message: 'Going live is public. Confirm by sending confirm: "GO LIVE".' } };
  return obsApi('start_stream', 'OBS is starting the stream to Kick. Hubie shows “LIVE” only once Kick confirms the channel is live.')();
});
hub.apiHandlers.set('POST /api/obs/stop', obsApi('stop_stream', 'Stopping the stream.'));
/* ---------------- Kick API (control center → 4 and 5) ---------------- */
hub.apiHandlers.set('GET /api/kick', () => kickPublic());
hub.apiHandlers.set('POST /api/kick/settings', (_req, body) => {
  const up: Record<string, string> = {};
  if (body.channel !== undefined) {
    const c = String(body.channel).trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (c && !/^[a-z0-9_-]{2,30}$/.test(c)) return { ok: false, error: { message: 'Use your Kick channel name as it appears in kick.com/<name>.' } };
    up.KICK_CHANNEL = c;
  }
  if (body.clientId !== undefined) { const v = String(body.clientId).trim(); if (v && !/^[A-Za-z0-9_-]{8,80}$/.test(v)) return { ok: false, error: { message: 'That Client ID does not look right — copy it from kick.com/settings/developer.' } }; up.KICK_CLIENT_ID = v; }
  if (body.clientSecret) { const v = String(body.clientSecret).trim(); if (!/^[A-Za-z0-9_-]{8,200}$/.test(v)) return { ok: false, error: { message: 'That Client Secret does not look right.' } }; up.KICK_CLIENT_SECRET = v; }
  if (body.webhookUrl !== undefined) { const v = String(body.webhookUrl).trim(); if (v && !/^https:\/\/[^\s]+\/kick\/webhook$/.test(v)) return { ok: false, error: { message: 'The webhook address must start with https:// and end with /kick/webhook.' } }; up.KICK_WEBHOOK_URL = v; }
  if (body.tunnel !== undefined) up.KICK_TUNNEL = body.tunnel ? 'cloudflared' : '';
  if (body.autoModerate !== undefined) up.KICK_AUTO_MODERATE = body.autoModerate ? 'true' : 'false';
  if (body.enabled !== undefined) up.KICK_ENABLED = body.enabled ? 'true' : 'false';
  const changed = writeEnv(up);
  if (changed.length) hub.broadcast({ type: 'reload_config', reason: 'Kick settings changed' }, ['kick-agent']);
  if (changed.includes('KICK_ENABLED')) health.setEnabled('kick', process.env.KICK_ENABLED === 'true');
  if (changed.some((k) => k === 'KICK_ENABLED' || k === 'KICK_TUNNEL')) syncTunnel();
  if (changed.includes('KICK_CLIENT_ID') || changed.includes('KICK_CHANNEL')) kickVerifier.reset();
  return { ok: true, kick: kickPublic() };
});
hub.apiHandlers.set('POST /api/kick/connect', (_req, body) => {
  const slot: KickSlot = body.slot === 'bot' ? 'bot' : 'broadcaster';
  if (!process.env.KICK_CLIENT_ID || !process.env.KICK_CLIENT_SECRET) return { ok: false, error: { message: 'Save the Client ID and Client Secret first (step 2).' } };
  const p = KickApi.pkce();
  kickPending.set(p.state, { slot, verifier: p.verifier, at: Date.now() });
  for (const [k, v] of kickPending) if (Date.now() - v.at > 15 * 60_000) kickPending.delete(k);
  return { ok: true, url: kickApi().authorizeUrl(kickRedirectUri(), KICK_SCOPES[slot], p.challenge, p.state) };
});
hub.apiHandlers.set('GET /api/kick/callback', async (req) => {
  const u = new URL(req.url ?? '', 'http://localhost');
  const state = u.searchParams.get('state') ?? '', code = u.searchParams.get('code') ?? '', err = u.searchParams.get('error');
  const page = (ok: boolean, msg: string) => ({ __html: `<!doctype html><meta charset="utf-8"><title>Hubie × Kick</title><body style="font:16px system-ui;background:#04282f;color:#e9f4f2;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:520px;text-align:center"><h1 style="color:${ok ? '#7ee0a3' : '#ff8a8a'}">${ok ? 'Connected ✓' : 'Not connected'}</h1><p>${msg.replace(/[<>&]/g, '')}</p><p>You can close this tab and go back to the Hubie Control Center.</p></div>` });
  const pend = kickPending.get(state);
  if (!pend) return page(false, 'This login link expired or was already used. Press Connect again in the Control Center.');
  kickPending.delete(state);
  if (err || !code) return page(false, `Kick did not approve the login (${err ?? 'no code'}).`);
  try {
    const t = await kickApi().exchangeCode(pend.slot, code, kickRedirectUri(), pend.verifier);
    log.info(`Kick ${pend.slot} account connected: ${t.username ?? '?'} (scopes: ${t.scope})`);
    hub.broadcast({ type: 'reload_config', reason: 'Kick account connected' }, ['kick-agent']);
    return page(true, `Hubie is connected to Kick as ${t.username ?? 'your account'}.`);
  } catch (e) { log.warn(`Kick login failed: ${(e as Error).message}`); return page(false, (e as Error).message); }
});
hub.apiHandlers.set('POST /api/kick/disconnect', (_req, body) => {
  const slot: KickSlot = body.slot === 'bot' ? 'bot' : 'broadcaster';
  kickApi().clear(slot);
  hub.broadcast({ type: 'reload_config', reason: `Kick ${slot} account disconnected` }, ['kick-agent']);
  return { ok: true };
});
hub.apiHandlers.set('GET /api/kick/wizard', () => ({ ok: true, ...kickWizard() }));
hub.apiHandlers.set('POST /api/kick/tunnel/start', async () => {
  writeEnv({ KICK_TUNNEL: 'cloudflared' });
  await tunnel.start();
  const st = tunnel.status();
  return st.state === 'error' ? { ok: false, error: { message: st.detail } } : { ok: true, message: st.state === 'running' ? 'Public address is up.' : 'Starting the public address — this takes a few seconds…' };
});
hub.apiHandlers.set('POST /api/kick/tunnel/stop', () => { writeEnv({ KICK_TUNNEL: '' }); tunnel.stop(); return { ok: true }; });
hub.apiHandlers.set('POST /api/kick/tunnel/check', () => { tunnel.probe(); return { ok: true }; });
/** "Test Kick Chat": post a message through Kick's API now, then wait for the user's own "hi Hubie" to arrive as a signed webhook. */
hub.apiHandlers.set('POST /api/kick/test', () => {
  if (process.env.KICK_ENABLED !== 'true') return { ok: false, error: { message: 'Kick is turned off — finish step 1 first.' } };
  if (!kickApi().hasUser('broadcaster') && !kickApi().hasUser('bot')) return { ok: false, error: { message: 'Sign in to Kick first (step 2).' } };
  kickTestStartedAt = Date.now();
  const text = `Hubie chat test ✔ ${new Date().toLocaleTimeString('en-GB')} — type "hi Hubie" here`;
  return kickCmd({ command: 'send_test', text }) ? { ok: true, message: 'Sending a test message… now type  hi Hubie  in your Kick chat.' } : { ok: false, error: { message: 'The Kick agent is not running yet — wait a few seconds and press the button again.' } };
});
hub.apiHandlers.set('POST /api/kick/test-message', () => {
  const text = `Hubie test message ✔ (${new Date().toLocaleTimeString('en-GB')})`;
  return kickCmd({ command: 'send_test', text }) ? { ok: true, message: `Sending "${text}" — it should appear in your Kick chat in a few seconds. “Last sent ✓” below confirms delivery.` } : { ok: false, error: { message: 'The Kick agent is not running — turn Kick on (step 1).' } };
});
hub.apiHandlers.set('POST /api/kick/resubscribe', () => (kickCmd({ command: 'resubscribe' }) ? { ok: true, message: 'Checking Kick event subscriptions…' } : { ok: false, error: { message: 'The Kick agent is not running.' } }));
hub.apiHandlers.set('POST /api/kick/refresh-status', () => (kickCmd({ command: 'status' }) ? { ok: true } : { ok: false, error: { message: 'The Kick agent is not running.' } }));
hub.apiHandlers.set('GET /api/kick/categories', async (req) => {
  const q = new URL(req.url ?? '', 'http://x').searchParams.get('q') ?? '';
  try { return { ok: true, categories: (await kickApi().searchCategories(q)).slice(0, 15).map((c: any) => ({ id: c.id, name: c.name })) }; }
  catch (e) { return { ok: false, error: { message: (e as Error).message } }; }
});
hub.apiHandlers.set('POST /api/kick/channel', (_req, body) => {
  const title = typeof body.title === 'string' ? body.title.replace(/[<>]/g, '').trim().slice(0, 140) : undefined;
  const categoryId = Number(body.categoryId) || undefined;
  if (!title && !categoryId) return { ok: false, error: { message: 'Enter a title or choose a category.' } };
  if (!kickApi().hasUser('broadcaster')) return { ok: false, error: { message: 'Connect your channel account first (section 4, step 4).' } };
  return kickCmd({ command: 'update_channel', title, categoryId }) ? { ok: true, message: 'Updating your Kick title/category…' } : { ok: false, error: { message: 'The Kick agent is not running.' } };
});

/* ---------------- audio test (control center) ----------------
 * Uses the SAME voice chain as live speech. Reports honestly which provider produced the audio. */
hub.apiHandlers.set('GET /api/audio/status', () => ({
  provider: voice.primaryName, chain: voice.chain.map((c) => c.name), keySet: hasVoiceKey(),
  model: process.env.ELEVENLABS_MODEL || DEFAULT_MODEL, voice: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, speed: Number(process.env.ELEVENLABS_SPEED || 1),
  lastError: voice.lastError || undefined, label: voiceLabel(), overlays: overlayIds().length,
  obsAudio: obsState.readiness ? { connected: obsState.readiness.connected, heardSecAgo: obsState.readiness.audioSeenSecAgo, peak: obsState.readiness.audioPeak } : null,
}));
hub.apiHandlers.set('POST /api/audio/test', async (_req, body) => {
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 200) : "Testing, testing. One, two, three. Hubie's voice is working, and the hat approves.";
  const t0 = Date.now();
  const r = await voice.synth({ id: `audiotest-${t0}`, text, tone: 'playful', rate: 1 });
  if (r.file && fs.existsSync(r.file)) {
    const head = fs.readFileSync(r.file).subarray(0, 3);
    const validMp3 = head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    return {
      ok: validMp3, provider: r.provider, fallback: r.provider !== 'elevenlabs',
      url: `/tts/${path.relative(TTS_DIR, r.file).split(path.sep).join('/')}`, bytes: fs.statSync(r.file).size, validMp3, cached: !!r.cached, ms: Date.now() - t0,
      voice: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, error: validMp3 ? undefined : 'The provider returned a file that is not valid MP3 audio.',
    };
  }
  // no server audio: browser voice only — reported as a fallback, never as ElevenLabs
  return {
    ok: false, provider: 'browser', fallback: true, text, ms: Date.now() - t0,
    error: hasVoiceKey() ? `ElevenLabs voice failed: ${voice.lastError || 'no audio returned'}` : 'No ElevenLabs key saved — only the browser\'s built-in voice is available (fallback, not ElevenLabs).',
  };
});
hub.apiHandlers.set('POST /api/audio/test-overlay', () => {
  const n = overlayIds().length;
  if (!n) return { ok: false, error: { message: 'No overlay page is open. Open the overlay (or OBS) first.' } };
  const since = Date.now();
  speech.enqueue({ text: "This is an overlay sound check. If you can hear me, the stream audio works.", expression: 'happy', tone: 'playful', priority: 99, reason: 'audio test', kind: 'system', interrupt: true });
  return { ok: true, since, overlays: n };
});
hub.apiHandlers.set('GET /api/speech/lipsync', () => {
  const recent = lipLog.slice(-20);
  const audio = recent.filter((r) => r.mode === 'audio');
  return { voice: voiceLabel(), recent, summary: { utterances: recent.length, drivenByAudio: audio.length, avgPeak: audio.length ? Math.round((audio.reduce((a, r) => a + r.peak, 0) / audio.length) * 100) / 100 : 0 } };
});
hub.apiHandlers.set('GET /api/game', () => ({ status: gameStatus ?? null }));
/* simulated Limbo settings (control center → 3). Saved to data/limbo-settings.json; defaults in config/limbo-sim.json */
hub.apiHandlers.set('GET /api/limbo/settings', () => ({ settings: loadLimboSettings(), defaultsFile: 'config/limbo-sim.json' }));
hub.apiHandlers.set('POST /api/limbo/settings', (_req, body) => {
  const r = body.reset ? { ok: true, errors: [], settings: resetLimboSettings() } : saveLimboSettings(body.settings ?? {});
  if (r.ok) { hub.broadcast({ type: 'game_command', command: 'reload_game_settings' }, ['game-agent']); director.setRoundIntervalMs(r.settings.roundDelaySec * 1000); }
  return r.ok ? { ok: true, settings: r.settings } : { ok: false, error: { message: r.errors.join('; ') } };
});
hub.apiHandlers.set('POST /api/control', (_req, body) => { handleControl(String(body.action), body.payload ?? {}); return { ok: true }; });
hub.apiHandlers.set('POST /api/estop', (_req, body) => { setEstop(body.on !== false, String(body.reason ?? 'api')); return { ok: true, estop }; });

registerVoiceKeysApi({ hub, log, ring: keyRing, voice: () => voice, rebuild: rebuildProviders });
registerSetupApi({
  hub, log, health, ttsDir: TTS_DIR, rebuildProviders,
  isDemo: () => ({ llm: llm.isDemo, voice: voice.isDemo }),
  generateTestLine: async () => {
    const line = await llm.generate({ kind: 'round', game: 'Test', simulated: true, outcome: 'win', multiplier: 3.5, target: 3.5, rolled: 4.1, tier: 'medium', nearMiss: false, lossStreak: 0, winStreak: 1, roundsPlayed: 1, brief: false }, director.contextForLLM());
    return { text: line.text, provider: llm.lastProvider, error: llm.lastProvider === 'mock' && !llm.isDemo ? llm.lastError : undefined };
  },
  synthTestLine: async (text) => {
    const r = await voice.synth({ id: `test-${Date.now()}`, text, tone: 'playful', rate: 1 });
    return { url: r.file ? `/tts/${path.relative(TTS_DIR, r.file).split(path.sep).join('/')}` : undefined, provider: r.provider, error: r.provider === 'none' || (r.provider === 'browser' && !voice.isDemo) ? voice.lastError || 'voice generation failed' : undefined };
  },
  start: () => director.start(), stop: () => director.stop(), started: () => director.started,
});

/* ---------------- avatar/audio liveness ---------------- */
const avatarMon = new AvatarMonitor();
function overlayIds() { return [...hub.clients].filter((c) => c.role === 'overlay' || c.role === 'avatar').map((c) => c.id); }
function updateAvatarHealth() {
  const v = avatarMon.evaluate(overlayIds());
  const cur = health.get('avatar');
  if (cur.state !== v.state || cur.detail !== v.detail) health.set('avatar', v.state, v.detail);
}
hub.onDisconnect((c) => {
  avatarMon.forget(c.id); updateAvatarHealth();
  // the Kick agent holds the chat connection; if its process goes away, say so immediately (unless Kick is turned off)
  if (c.role === 'kick-agent' && envBool('KICK_ENABLED') && ![...hub.clients].some((x) => x.role === 'kick-agent')) health.set('kick', 'down', 'Kick agent disconnected — restarting');
});
setInterval(() => {
  updateAvatarHealth();
  if (hub.count('game-agent') === 0 && health.get('game-agent').state === 'ok') health.set('game-agent', 'down', 'Game agent process is not connected (it restarts automatically)');
}, 2000).unref();

/* ---------------- start ---------------- */
await hub.listen();
log.info(`controller listening on :${CONTROLLER_PORT}  setup: http://127.0.0.1:${CONTROLLER_PORT}/setup  overlay: /overlay  control: /control`);
syncTunnel();
log.info(`kick=${envBool('KICK_ENABLED')} obs=${envBool('OBS_ENABLED')} estop=${estop} started=${director.started}`);

const shutdown = (sig: string) => { log.info(`${sig}: saving state`); tunnel.stop(); director.persist(); memory.close(); process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log.error('uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

// usage log every 10 min — counts and latency only, never keys or prompts
setInterval(() => {
  const u = Object.entries(llm.usage).map(([n, s]) => `${n}: ${s.calls} calls, ${s.failures} errors, ${s.inputTokens}/${s.outputTokens} tokens in/out, avg ${s.avgMs} ms`).join(' · ');
  if (u) log.info(`AI usage since start — ${u}`);
}, 600_000).unref();

/* ---------------- CHECK EVERYTHING (control center → G) ----------------
 * Status words are fixed: Ready / Connected / Not configured / Failed (the page shows Testing while it runs).
 * "Ready" is only used when something was actually exercised end-to-end just now (or recently, with proof). */
type CheckStatus = 'Ready' | 'Connected' | 'Not configured' | 'Failed';
interface Check { id: string; name: string; status: CheckStatus; detail: string; fix?: string; required: boolean }
const ago = (t?: number) => (t ? `${Math.max(1, Math.round((Date.now() - t) / 1000))} s ago` : '');

async function checkEverything(): Promise<Check[]> {
  const out: Check[] = [];
  // A — AI brain (real call)
  if (llm.isDemo) out.push({ id: 'ai', name: 'AI brain', status: 'Not configured', required: true, detail: 'No AI key saved — Hubie would use built-in demo lines.', fix: 'Section 1: paste an Anthropic key (recommended) or an OpenAI key, then Test.' });
  else {
    const line = await llm.generate({ kind: 'spontaneous', mode: 'observation' }, director.contextForLLM()).catch(() => null);
    const real = llm.lastProvider !== 'mock' && !!line;
    out.push(real
      ? { id: 'ai', name: 'AI brain', status: 'Ready', required: true, detail: `${describeBrain(process.env, llm)} answered just now: “${line!.text.slice(0, 120)}”` }
      : { id: 'ai', name: 'AI brain', status: 'Failed', required: true, detail: llm.lastError || 'The AI did not answer.', fix: 'Section 1: press Test to see the exact reason (key, credits, or internet).' });
  }
  // B — Voice (real synthesis)
  if (!hasVoiceKey()) out.push({ id: 'voice', name: 'Voice (ElevenLabs)', status: 'Not configured', required: true, detail: 'No ElevenLabs key — the overlay would use the browser\'s built-in voice (labelled "Browser voice (fallback — not ElevenLabs)").', fix: 'Section 2: paste your ElevenLabs key and press Preview.' });
  else {
    const r = await voice.synth({ id: `check-${Date.now()}`, text: 'Voice check. The sloth is ready.', tone: 'playful', rate: 1 });
    out.push(r.provider === 'elevenlabs' && r.file
      ? { id: 'voice', name: 'Voice (ElevenLabs)', status: 'Ready', required: true, detail: `ElevenLabs made audio just now (voice ${process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID}${r.cached ? ', from cache' : ''}).` }
      : { id: 'voice', name: 'Voice (ElevenLabs)', status: 'Failed', required: true, detail: voice.lastError || 'No audio came back.', fix: 'Section 2: press Preview to see the exact reason.' });
  }
  // 3 — simulated Limbo game
  const gs = gameStatus;
  if (!gs || gs.source === 'none') out.push({ id: 'game', name: 'Simulated Limbo game', status: 'Failed', required: true, detail: gs?.error ?? 'The game player has not reported in.', fix: 'Section 3: press "Restart game". If it keeps failing, see docs/TROUBLESHOOTING.md → Game.' });
  else if (gs.source !== 'limbo-sim') out.push({ id: 'game', name: 'Simulated Limbo game', status: 'Not configured', required: true, detail: `Running the developer test game (${gs.game}).`, fix: 'Section 3: press "Use simulated Limbo".' });
  else out.push({ id: 'game', name: 'Simulated Limbo game', status: health.get('game-browser').state === 'ok' ? 'Ready' : 'Failed', required: true,
    detail: `Limbo (demo play, local random engine) · round ${gs.limbo?.roundNumber ?? 0} · simulated win share ${Math.round((gs.limbo?.winShare ?? 0) * 100)} % · every round is checked against what the page shows${gs.error ? ` · last error: ${gs.error}` : ''}` });
  // F — Overlay / avatar
  const av = health.get('avatar');
  out.push(av.state === 'ok'
    ? { id: 'overlay', name: 'Overlay & avatar', status: 'Connected', required: true, detail: av.detail ?? 'overlay page open' }
    : { id: 'overlay', name: 'Overlay & avatar', status: 'Not configured', required: true, detail: av.detail ?? 'No overlay page open.', fix: 'Section E: press "Set up OBS scene" (adds the overlay automatically), or open the overlay link in a browser.' });
  // audio + lip-sync: actually play a short line on the overlay and read back what happened
  if (!overlayIds().length) out.push({ id: 'lipsync', name: 'Stream audio & lip-sync', status: 'Not configured', required: true, detail: 'No overlay page is open, so nothing can play the voice.', fix: 'Section 6: press "Set up OBS scene" (adds the overlay), or open the overlay link.' });
  else if (estop) out.push({ id: 'lipsync', name: 'Stream audio & lip-sync', status: 'Not configured', required: true, detail: 'Emergency stop is on — audio test skipped.', fix: 'Press Resume.' });
  else {
    const since = Date.now();
    speech.enqueue({ text: 'Sound check. Hubie is ready.', expression: 'happy', tone: 'playful', priority: 99, reason: 'check-all audio test', kind: 'system', interrupt: true });
    let rec: (typeof lipLog)[number] | undefined;
    for (let i = 0; i < 50 && !rec; i++) { await new Promise((r) => setTimeout(r, 400)); rec = lipLog.filter((l) => l.at >= since).at(-1); }
    out.push(!rec
      ? { id: 'lipsync', name: 'Stream audio & lip-sync', status: 'Failed', required: true, detail: 'The overlay did not report playing the test line within 20 s.', fix: 'Reload the overlay (OBS: right-click the source → Refresh).' }
      : rec.mode === 'audio' && rec.peak > 0.1
        ? { id: 'lipsync', name: 'Stream audio & lip-sync', status: 'Ready', required: true, detail: `Overlay played a test line as real audio (${rec.provider ?? 'voice'}); mouth followed the sound (peak ${rec.peak}).` }
        : { id: 'lipsync', name: 'Stream audio & lip-sync', status: 'Failed', required: true, detail: `Overlay used "${rec.mode}" mode — no audio file played${rec.provider ? ` (provider ${rec.provider})` : ''}.`, fix: rec.mode === 'text' ? 'In a browser tab click the overlay once to allow sound; in OBS sound is automatic. Without an ElevenLabs key there is no audio file.' : 'Add an ElevenLabs key in section 1.' });
  }
  // 4 — Kick chat
  const kh = health.get('kick');
  if (process.env.KICK_ENABLED !== 'true') out.push({ id: 'kick', name: 'Kick chat', status: 'Not configured', required: false, detail: 'Kick is turned off.', fix: 'Section 4: enter your channel and app details, connect your account, switch Kick on.' });
  else if (kh.state === 'down' || kh.state === 'unknown') out.push({ id: 'kick', name: 'Kick chat', status: 'Failed', required: false, detail: kh.detail ?? 'not connected', fix: 'Section 4: follow the “Connect Kick Chat” steps.' });
  else {
    const w = kickWizard();
    const a = kickActivity;
    out.push({ id: 'kick', name: 'Kick chat', status: w.connected ? 'Ready' : 'Not configured', required: false,
      detail: w.connected
        ? `Tested: ${a.account || 'chat account'} in ${process.env.KICK_CHANNEL} — Hubie posted a message, heard ${kickVerifier.v.receiveUser} and answered.`
        : `Not tested yet (${a.account || 'no account'} in ${process.env.KICK_CHANNEL}). ${w.next}`,
      fix: w.connected ? undefined : 'Section 4: follow the “Connect Kick Chat” steps, then press “Test Kick Chat”.' });
  }
  // 5 — Kick stream status (only Kick decides whether we're live)
  if (process.env.KICK_ENABLED === 'true') out.push(kickLive && !kickLive.error
    ? { id: 'kick-stream', name: 'Kick stream status', status: 'Ready', required: false, detail: `Kick reports the channel ${kickLive.live ? `LIVE (${kickLive.viewers ?? 0} viewers)` : 'offline'}${kickLive.title ? ` · title “${kickLive.title}”` : ''}${kickLive.category ? ` · ${kickLive.category}` : ''} · checked ${ago(kickLive.checkedAt)}` }
    : { id: 'kick-stream', name: 'Kick stream status', status: 'Failed', required: false, detail: kickLive?.error ?? 'Not checked yet.', fix: 'Section 5: press "Refresh status".' });
  // E — OBS (local) or Streamable cloud OBS
  const r = obsState.readiness, oh = health.get('obs');
  if (cloudMode()) {
    const v = cloudVerdict(), url = cloudOverlayUrl();
    out.push(!url
      ? { id: 'cloud', name: 'Streamable cloud overlay', status: 'Not configured', required: true, detail: 'No public address for the overlay yet.', fix: 'Install on a server with the VPS installer (it sets PUBLIC_HOST), then copy the overlay link from the Cloud section.' }
      : v.state === 'ok' ? { id: 'cloud', name: 'Streamable cloud overlay', status: 'Ready', required: true, detail: `Measured inside cloud OBS: ${v.detail}` }
      : v.state === 'problem' ? { id: 'cloud', name: 'Streamable cloud overlay', status: 'Failed', required: true, detail: `Cloud OBS is rendering the overlay, but ${v.detail}`, fix: 'See docs/STREAMABLE-CLOUD.md → Performance.' }
      : { id: 'cloud', name: 'Streamable cloud overlay', status: 'Not configured', required: true, detail: v.detail, fix: 'Cloud section: copy the overlay link into a Browser Source (1920×1080, 60 fps) in Streamable Remote OBS.' });
    out.push({ id: 'cloud-go-live', name: 'Cloud stream output (1080p60 → Kick)', status: 'Not configured', required: false, detail: 'Not verifiable from Hubie: Streamable has no documented API for stream output or encoder stats. Check Remote OBS → Stats (dropped frames, CPU, bitrate) and that the Kick destination is active.', fix: 'Start the stream in Streamable; Kick status below confirms whether Kick really sees it live.' });
  } else if (process.env.OBS_ENABLED !== 'true') out.push({ id: 'obs', name: 'OBS (streaming)', status: 'Not configured', required: true, detail: 'OBS control is off.', fix: 'Section E: turn on OBS → Tools → WebSocket Server Settings, copy the password into Hubie, press Test OBS.' });
  else if (!r?.connected) out.push({ id: 'obs', name: 'OBS (streaming)', status: 'Failed', required: true, detail: oh.detail ?? 'Cannot reach OBS.', fix: 'Start OBS, enable its WebSocket server (Tools → WebSocket Server Settings), check the password.' });
  else {
    const missing = [!r.scene && 'Hubie scene', !r.source && 'overlay source', !r.streamKeySet && 'stream key'].filter(Boolean);
    out.push({ id: 'obs', name: 'OBS (streaming)', status: missing.length ? 'Connected' : 'Ready', required: true,
      detail: `OBS ${r.obsVersion} · ${r.video || 'video ?'} · ${r.streaming ? 'LIVE NOW' : 'not streaming'} · audio from overlay ${r.audioSeenSecAgo < 0 ? 'not heard yet' : `heard ${r.audioSeenSecAgo}s ago`}${missing.length ? ` · missing: ${missing.join(', ')}` : ''}${obsState.lastTest ? ` · private test stream: ${obsState.lastTest.ok ? 'passed' : 'failed'} ${ago(obsState.lastTest.at)}` : ''}`,
      fix: missing.length ? 'Section 6: press "Set up OBS scene"; section 5: save your Kick stream URL and key.' : undefined });
    // 1080p60 is only "verified" by measurement: settings read back from OBS + numbers OBS reports while it is really encoding.
    const bad = (r.checks ?? []).filter((c) => !c.ok);
    const q = r.quality, pt = r.perfTest;
    if (r.liveVerifiedAt) out.push({ id: 'obs-1080p60', name: '1080p60 stream quality', status: 'Ready', required: false, detail: `Verified on a live stream ${ago(r.liveVerifiedAt)}: ${q ? `${q.fps.toFixed(1)} fps, ${Math.round(q.kbps)} kbps` : 'measured by OBS'}, all settings match Kick’s requirements.` });
    else if (!r.checks?.length) out.push({ id: 'obs-1080p60', name: '1080p60 stream quality', status: 'Not configured', required: false, detail: 'Not checked yet.', fix: 'Section 6: press “Apply 1080p60 settings”.' });
    else if (bad.length) out.push({ id: 'obs-1080p60', name: '1080p60 stream quality', status: 'Failed', required: false, detail: `OBS is not set up for Kick 1080p60: ${bad.map((c) => `${c.name} is ${c.got} (want ${c.want})`).join('; ')}.`, fix: 'Section 6: press “Apply 1080p60 settings” (stop the stream first).' });
    else if (q && !q.ok) out.push({ id: 'obs-1080p60', name: '1080p60 stream quality', status: 'Failed', required: false, detail: `Settings are right but OBS measured: ${q.problems.join('; ')}.`, fix: 'Lower the bitrate by 1,000 kbps or use a hardware encoder (docs/OBS-SETUP.md).' });
    else out.push({ id: 'obs-1080p60', name: '1080p60 stream quality', status: 'Connected', required: false,
      detail: `Settings read back from OBS are correct (1920×1080, 60 fps, x264 CBR, keyframe 2 s). ${pt ? (pt.ok ? `Local performance test passed ${ago(pt.at)}. ` : `Local performance test: ${pt.detail} `) : 'Local performance test not run. '}NOT yet verified on a live stream — that happens automatically after Hubie has streamed for one minute.` });
  }
  // security
  const remote = !!process.env.PUBLIC_BASE_URL && !/127\.0\.0\.1|localhost/.test(process.env.PUBLIC_BASE_URL);
  out.push(remote && !process.env.CONTROL_TOKEN
    ? { id: 'security', name: 'Remote access protection', status: 'Failed', required: true, detail: 'This server is reachable remotely but has no access token.', fix: 'Re-run INSTALL-HUBIE.sh, or set CONTROL_TOKEN in .env, then restart.' }
    : { id: 'security', name: 'Remote access protection', status: 'Ready', required: true, detail: process.env.CONTROL_TOKEN ? 'Control pages need the secret access link.' : 'Local only (this computer).' });
  // safety
  out.push({ id: 'safety', name: 'Safety & emergency stop', status: estop ? 'Not configured' : 'Ready', required: true, detail: estop ? 'Emergency stop is ON — Hubie is silent.' : 'Chat/outbound filters active; emergency stop ready.', fix: estop ? 'Press Resume when you are ready.' : undefined });
  return out;
}
hub.apiHandlers.set('POST /api/check-all', async () => ({ at: new Date().toISOString(), checks: await checkEverything() }));
