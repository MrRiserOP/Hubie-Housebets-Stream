/**
 * Hubie message protocol. Every process talks to the controller hub over one
 * WebSocket using these JSON messages. Keep this file dependency-free: it is
 * imported by Node processes AND by the browser avatar/overlay bundle.
 */

export type Expression =
  | 'idle'
  | 'speaking'
  | 'happy'
  | 'laughing'
  | 'surprised'
  | 'angry'
  | 'sad'
  | 'thinking'
  | 'celebrating'
  | 'excited'
  | 'disappointed'
  | 'mischievous'
  | 'confident'
  | 'sleepy'
  | 'suspicious';

export const EXPRESSIONS: Expression[] = [
  'idle', 'speaking', 'happy', 'laughing', 'surprised', 'angry', 'sad',
  'thinking', 'celebrating', 'excited', 'disappointed', 'mischievous', 'confident', 'sleepy', 'suspicious',
];

/** Voice emotion, chosen by the commentary director and used by the TTS voice instructions. */
export type Emotion =
  | 'relaxed' | 'excited' | 'hyped' | 'sarcastic' | 'surprised' | 'friendly' | 'playful'
  | 'calm' | 'suspicious' | 'disappointed' | 'sleepy' | 'mischievous' | 'dramatic' | 'warm';
export const EMOTIONS: Emotion[] = ['relaxed', 'excited', 'hyped', 'sarcastic', 'surprised', 'friendly', 'playful', 'calm', 'suspicious', 'disappointed', 'sleepy', 'mischievous', 'dramatic', 'warm'];
/** Back-compat alias: v1 called this Tone. */
export type Tone = Emotion;

/** Multi-track animation sequences the avatar can play (see apps/avatar/src/rig/combos.ts). */
export type Combo =
  | 'big_win' | 'bad_result' | 'suspicious' | 'laughing' | 'chat_interaction' | 'surprise' | 'thinking'
  | 'celebration' | 'facepalm' | 'shrug' | 'hat_tip' | 'welcome_wave' | 'sleepy' | 'nod' | 'point_game'
  | 'point_chat' | 'clap' | 'lean_in' | 'confident' | 'mischief' | 'bow_tie';
export const COMBOS: Combo[] = ['big_win', 'bad_result', 'suspicious', 'laughing', 'chat_interaction', 'surprise', 'thinking', 'celebration', 'facepalm', 'shrug', 'hat_tip', 'welcome_wave', 'sleepy', 'nod', 'point_game', 'point_chat', 'clap', 'lean_in', 'confident', 'mischief', 'bow_tie'];

export interface Appearance {
  avatarSize: 'small' | 'medium' | 'large';
  layout: 'game-left' | 'game-right';
  chatPanel: boolean;
  subtitles: boolean;
  intensity: 'calm' | 'normal' | 'lively';
  rgText: string;
  ageNotice: string;
}
export const DEFAULT_APPEARANCE: Appearance = {
  avatarSize: 'medium', layout: 'game-left', chatPanel: true, subtitles: true, intensity: 'normal',
  rgText: 'Gambling can be addictive. Set limits, take breaks, and never play with money you can’t afford to lose.',
  ageNotice: '18+ ONLY · Demo games with play money · No real-money wagering on this stream',
};

export type CaptionStyle = 'slam' | 'stamp' | 'wobble' | 'type' | 'glow';

export type ClientRole = 'overlay' | 'avatar' | 'control' | 'game-agent' | 'kick-agent' | 'stream-engine' | 'test';

export type ComponentName =
  | 'controller' | 'game-agent' | 'game-browser' | 'ai' | 'tts' | 'avatar'
  | 'kick' | 'obs' | 'audio';

export type HealthState = 'ok' | 'degraded' | 'down' | 'disabled' | 'unknown';

export interface ComponentHealth {
  name: ComponentName;
  state: HealthState;
  detail?: string;
  lastSeen?: number;
  restarts?: number;
}

/* ---------------- Game events ---------------- */

export type GameEventKind =
  | 'game_loaded'
  | 'round_started'
  | 'round_result'
  | 'bonus_triggered'
  | 'big_win'
  | 'streak'
  | 'game_error';

export interface RoundResult {
  roundId: string;
  game: string;
  /** demo stake shown in UI (play money). */
  stake?: number;
  payout?: number;
  multiplier?: number;
  /** 'unknown' = the round finished but the outcome could not be read reliably (never guessed) */
  outcome: 'win' | 'loss' | 'push' | 'unknown';
  /** Game specific details, e.g. target multiplier, rolled number. */
  details?: Record<string, unknown>;
  /** Demo balance as shown by the game, if visible. */
  balance?: number;
}

export interface GameEvent {
  kind: GameEventKind;
  game: string;
  adapter: string;
  /** true when the event came from a simulated adapter, not a real game. */
  simulated: boolean;
  at: number;
  round?: RoundResult;
  message?: string;
  /** where the game runs: the real public Housebets demo, or the local simulated fallback */
  source?: 'limbo-sim' | 'local-sim';
  /** games discovered on the Housebets games page (sent with game_loaded) */
}

export interface GameEvent {
  kind: GameEventKind;
  game: string;
  adapter: string;
  /** true when the event came from a simulated adapter, not a real game. */
  simulated: boolean;
  at: number;
  round?: RoundResult;
  message?: string;
  /** where the game runs: the real public Housebets demo, or the local simulated fallback */
  source?: 'limbo-sim' | 'local-sim';
  /** games discovered on the Housebets games page (sent with game_loaded) */
}

export interface ProbeRound { n: number; ok: boolean; outcome?: string; result?: string; balanceBefore?: number; balanceAfter?: number; ms: number; note?: string }
export interface ProbeReport {
  at: string; gamesUrl: string; reachable: boolean; blocker?: string;
  games: Array<{ name: string; url: string; type: string; supported: boolean }>;
  selected?: { name: string; url: string; type: string };
  demo: string; betButton?: string; rounds: ProbeRound[];
  learned?: Record<string, unknown>;
  verdict: 'PASS' | 'PARTIAL' | 'FAIL'; summary: string; dir?: string; screenshots: string[];
}

/* ---------------- Chat ---------------- */

export interface ChatMessage {
  id: string;
  user: string;
  userId: string;
  text: string;
  at: number;
  /** 'kick' for real chat; 'local-test' only when ALLOW_TEST_CHAT=true. */
  source: 'kick' | 'local-test';
  badges?: string[];
}

/* ---------------- Speech ---------------- */

export interface Utterance {
  id: string;
  text: string;
  expression: Expression;
  tone: Emotion;
  /** same as tone; preferred name in v2 */
  emotion?: Emotion;
  /** animation combo to play while speaking */
  combo?: Combo;
  /** big on-screen reaction caption, e.g. "THAT WAS PERSONAL." */
  caption?: string;
  captionStyle?: CaptionStyle;
  /** when replying to a viewer: shown as a lower-third callout */
  replyTo?: { user: string; text: string };
  /** what kind of moment this is (drives overlay graphics) */
  kind?: 'round' | 'chat' | 'segment' | 'bonus' | 'big_win' | 'filler' | 'system' | 'test';
  /** speaking rate multiplier, 1 = normal */
  rate: number;
  priority: number;
  /** URL of audio file served by the controller, if a TTS provider produced audio */
  audioUrl?: string;
  /** If no audio, the overlay may use the browser speechSynthesis fallback */
  browserSpeech?: boolean;
  /** Estimated duration in ms (for timeouts and fallback mouth animation) */
  durationMs: number;
  provider: string;
  reason: string;
}

/* ---------------- Overlay state ---------------- */

export type MusicMood = 'auto' | 'funky' | 'electronic' | 'chill' | 'hype' | 'ambient';
export interface MusicTrack { id: string; url: string; title: string; mood: string; seconds?: number; user?: boolean }
/** Section 13 audio settings: music + voice levels + ducking. Percentages 0–100. */
export interface AudioSettings {
  musicEnabled: boolean; musicVolume: number; voiceVolume: number;
  duckEnabled: boolean; duckLevel: number;     // music level (% of its normal volume) while Hubie is speaking
  mood: MusicMood; disabledTracks: string[];
}
export interface AudioState { settings: AudioSettings; tracks: MusicTrack[]; autoMood: string }
export interface MusicStatus { state: 'off' | 'playing' | 'crossfading' | 'recovering' | 'blocked' | 'error'; track?: string; mood?: string; plays: number; failures: number; skipped: number; lastError?: string; ducked: boolean; level: number; at: number }

/** Section 14: how lively Hubie's body is. intensity 40–160 (100 = normal). */
export interface AvatarSettings { intensity: number; idleLife: boolean; talkGestures: boolean; reactions: boolean; cues: boolean }
export const DEFAULT_AVATAR_SETTINGS: AvatarSettings = { intensity: 100, idleLife: true, talkGestures: true, reactions: true, cues: true };
/** The ten animation states shown in the control panel (what the body is doing right now). */
export type AvatarStateName = 'idle' | 'speaking' | 'listening' | 'thinking' | 'laughing' | 'excited' | 'surprised' | 'disappointed' | 'celebrating' | 'reacting';
export const AVATAR_STATES: AvatarStateName[] = ['idle', 'speaking', 'listening', 'thinking', 'laughing', 'excited', 'surprised', 'disappointed', 'celebrating', 'reacting'];

export interface OnAirInfo {
  /** true only while live is CONFIRMED (Kick API, or OBS output when Kick isn't set up) */
  live: boolean; totalMs: number; currentMs: number; asOf: number; label: string; milestone: boolean; sessions: number; reconnects: number; source: string;
  /** Hubie's established broadcasting history across earlier streams (operator-declared). Static: never a session timer, never reset by a disconnect. */
  history: { enabled: boolean; text: string };
}
export const DEFAULT_HISTORY_BADGE = { enabled: true, text: '150+ HOURS ON AIR' };

export interface OverlayState {
  onAir?: OnAirInfo;
  audio?: AudioState;
  avatarSettings?: AvatarSettings;
  segment: string;
  segmentTitle: string;
  showTitle: string;
  chat: Array<Pick<ChatMessage, 'id' | 'user' | 'text' | 'at'> & { fromHubie?: boolean }>;
  lastRound?: RoundResult & { simulated: boolean };
  /** limbo-sim = SIMULATED GAME — ENTERTAINMENT ONLY; local-sim = developer test game */
  gameSource?: 'limbo-sim' | 'local-sim' | 'none';
  /** what Kick reports (undefined = Kick not connected). The overlay only says LIVE when this is true. */
  platformLive?: boolean;
  /** overlay appearance settings (Section F) */
  appearance?: Appearance;
  /** active brain/voice for status display */
  brain?: string;
  stats: { rounds: number; wins: number; losses: number; bestMultiplier: number; balance?: number };
  gameName: string;
  gameSimulated: boolean;
  caption?: string;
  health: ComponentHealth[];
  emergencyStop: boolean;
  testChatEnabled: boolean;
  /** recent game events for the event rail */
  recentRounds?: Array<{ id: string; outcome: string; multiplier?: number; rolled?: number; target?: number; at: number }>;
  showStarted?: boolean;
  demoMode?: boolean;
  voiceLabel?: string;
  chatConnected?: boolean;
  /** monotonic counter that increments on each segment change (for title cards) */
  segmentSeq?: number;
  breakEndsAt?: number;
}

/* ---------------- Wire messages ---------------- */

export interface ObsReadiness { connected: boolean; scene: boolean; source: boolean; programIsHubie: boolean; streamKeySet: boolean; service: string; streaming: boolean; video: string; audioSeenSecAgo: number; audioPeak: number; obsVersion: string;
  /** 1080p60 evidence: settings read back from OBS, and measurements taken while OBS was actually encoding. */
  videoOk?: boolean; checks?: Array<{ name: string; want: string; got: string; ok: boolean }>; settingsOk?: boolean;
  quality?: { at: number; streaming: boolean; fps: number; kbps: number; congestionPct: number; renderSkippedPct: number; encodeSkippedPct: number; cpu: number; seconds: number; ok: boolean; problems: string[] };
  liveVerifiedAt?: number; perfTest?: { at: number; ok: boolean; detail: string; running?: boolean } }

export interface KickStreamStatus { checkedAt: number; live: boolean; title?: string; category?: string; viewers?: number; startedAt?: string; error?: string }

/** Measured INSIDE the overlay page by the browser that renders it (e.g. cloud OBS's browser source). */
export interface OverlayTelemetry {
  fps: number; p95Ms: number; worstMs: number; frames: number;
  gpu: string; software: boolean; cores: number; memGB: number; w: number; h: number; ua: string; audioCtx: string; cloud: boolean;
}

export type HubMessage =
  | { type: 'hello'; role: ClientRole; id?: string }
  | { type: 'heartbeat'; role: ClientRole; component?: ComponentName; detail?: string; state?: HealthState }
  | { type: 'health'; components: ComponentHealth[] }
  | { type: 'game_event'; event: GameEvent }
  | { type: 'game_frame'; mime: string; data: string; w: number; h: number }
  | { type: 'game_command'; command: 'play_round' | 'pause' | 'resume' | 'restart_browser' | 'switch_game' | 'reload_game_settings'; game?: string }
  | { type: 'game_status'; status: { source: 'limbo-sim' | 'local-sim' | 'none'; game: string; paused: boolean; rounds: number; lastRoundAt?: number; error?: string;
      limbo?: { roundNumber: number; balance: number; history: Array<Record<string, any>>; winShare: number; settings: Record<string, any> } } }
  | { type: 'chat_in'; message: ChatMessage }
  | { type: 'kick_activity'; lastIn?: { user: string; text: string; at: number; id?: string }; lastOut?: { text: string; at: number; ok: boolean; error?: string; test?: boolean }; webhook?: { received: number; rejected: number; lastAt?: number; lastError?: string }; subscriptions?: string[]; subCheckedAt?: number; subError?: string; authError?: string; account?: string; channel?: string; broadcasterId?: number }
  | { type: 'kick_status'; status: KickStreamStatus }
  | { type: 'kick_command'; command: 'update_channel' | 'delete_message' | 'timeout' | 'resubscribe' | 'status' | 'send_test'; title?: string; categoryId?: number; messageId?: string; userId?: number; minutes?: number; reason?: string; text?: string }
  | { type: 'chat_out'; text: string; replyTo?: string }
  | { type: 'say'; utterance: Utterance }
  | { type: 'stop_speech'; reason: string }
  | { type: 'speech_started'; id: string }
  | { type: 'speech_ended'; id: string; error?: string; lip?: { mode: string; peak: number; activeFrac: number; provider?: string } }
  | { type: 'client_info'; audio: boolean }
  | { type: 'overlay_telemetry'; t: OverlayTelemetry }
  | { type: 'music_status'; s: MusicStatus }
  | { type: 'avatar_cue'; cue: 'listening' | 'thinking' }
  | { type: 'avatar_state'; state: AvatarStateName; at: number }
  | { type: 'expression'; expression: Expression; holdMs?: number }
  | { type: 'combo'; combo: Combo }
  | { type: 'fx'; fx: 'confetti' | 'sparkles' | 'zoom' | 'shake' | 'flash' | 'intro'; text?: string; sub?: string }
  | { type: 'speech_progress'; id: string; t: number; d: number }
  | { type: 'reload_config'; reason: string }
  | { type: 'overlay_state'; state: OverlayState }
  | { type: 'control'; action: ControlAction; payload?: Record<string, unknown> }
  | { type: 'obs_command'; command: 'start_stream' | 'stop_stream' | 'setup_scene' | 'status' | 'configure_output' | 'performance_test'; seconds?: number }
  | { type: 'obs_report'; kind: 'readiness' | 'error'; readiness?: ObsReadiness; result?: { ok: boolean; detail: string; frames?: number; dropped?: number }; error?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string; from?: string }
  | { type: 'estop'; on: boolean; reason: string };

export type ControlAction =
  | 'trigger_game_event'
  | 'say'
  | 'expression'
  | 'test_chat'
  | 'emergency_stop'
  | 'resume'
  | 'next_segment'
  | 'obs_start'
  | 'obs_stop'
  | 'obs_setup'
  | 'restart_game_browser'
  | 'game_pause'
  | 'game_resume'
  | 'combo'
  | 'start_show'
  | 'stop_show';

export function encode(msg: HubMessage): string {
  return JSON.stringify(msg);
}

export function decode(raw: unknown): HubMessage | null {
  try {
    const s = typeof raw === 'string' ? raw : String(raw);
    const m = JSON.parse(s);
    if (m && typeof m.type === 'string') return m as HubMessage;
  } catch { /* ignore */ }
  return null;
}
