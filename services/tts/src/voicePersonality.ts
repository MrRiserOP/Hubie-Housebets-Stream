/**
 * Hubie's voice personality for ElevenLabs. One base voice (configurable voice ID) + per-emotion
 * delivery tweaks: the ElevenLabs voice_settings (stability / style / speed) change per line so big wins sound
 * excited without shouting constantly, and sarcasm sounds dry.
 */
import type { Emotion } from '../../../packages/shared/src/protocol.ts';

/** Default voice: "Charlie" from ElevenLabs' built-in library (energetic, confident, conversational). The Control Center lists
 *  the voices your own account can actually use, so you can audition and change it. */
export const DEFAULT_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';
export const DEFAULT_MODEL = 'eleven_turbo_v2_5';
export const MODELS = [
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast, expressive (default for live)' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest, cheapest' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — richest, slower' },
];

/** Voices we try to pick first when choosing the "best default" from what the account offers (warm, energetic, playful, conversational). */
export const PREFERRED_VOICE_NAMES = ['Charlie', 'Liam', 'Will', 'Chris', 'Jessica', 'George', 'Brian', 'Eric', 'Callum', 'Roger'];

export interface VoiceSettings { stability: number; similarity: number; style: number; speed: number; speakerBoost: boolean }
export const DEFAULT_SETTINGS: VoiceSettings = { stability: 0.45, similarity: 0.8, style: 0.35, speed: 1.0, speakerBoost: true };

export interface EmotionStyle { stabilityDelta: number; styleDelta: number; speed: number }
export const EMOTION_STYLES: Record<Emotion, EmotionStyle> = {
  relaxed:      { stabilityDelta: +0.10, styleDelta: -0.10, speed: 0.98 },
  friendly:     { stabilityDelta: 0,     styleDelta: 0,     speed: 1.0 },
  warm:         { stabilityDelta: +0.10, styleDelta: -0.05, speed: 0.97 },
  playful:      { stabilityDelta: -0.08, styleDelta: +0.15, speed: 1.03 },
  excited:      { stabilityDelta: -0.12, styleDelta: +0.20, speed: 1.07 },
  hyped:        { stabilityDelta: -0.18, styleDelta: +0.30, speed: 1.1 },   // capped below: expressive, not constant shouting
  sarcastic:    { stabilityDelta: +0.20, styleDelta: +0.05, speed: 0.96 },
  surprised:    { stabilityDelta: -0.12, styleDelta: +0.20, speed: 1.05 },
  suspicious:   { stabilityDelta: +0.10, styleDelta: +0.05, speed: 0.94 },
  disappointed: { stabilityDelta: +0.05, styleDelta: +0.10, speed: 0.94 },
  dramatic:     { stabilityDelta: -0.05, styleDelta: +0.25, speed: 0.98 },
  calm:         { stabilityDelta: +0.20, styleDelta: -0.15, speed: 0.97 },
  sleepy:       { stabilityDelta: +0.25, styleDelta: -0.10, speed: 0.88 },
  mischievous:  { stabilityDelta: -0.05, styleDelta: +0.15, speed: 1.0 },
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** Final ElevenLabs voice_settings for one line (base settings from the Control Center + the emotion). */
export function settingsFor(base: VoiceSettings, tone: Emotion, rate = 1) {
  const e = EMOTION_STYLES[tone] ?? EMOTION_STYLES.relaxed;
  return {
    stability: clamp(base.stability + e.stabilityDelta, 0.2, 0.95),
    similarity_boost: clamp(base.similarity, 0, 1),
    style: clamp(base.style + e.styleDelta, 0, 0.7),
    use_speaker_boost: base.speakerBoost,
    speed: clamp(base.speed * e.speed * rate, 0.7, 1.2),
  };
}

export const PREVIEW_LINE = "Hey chat, I'm Hubie. Sloth, host, and owner of this extremely fancy hat. Let's have some fun... slowly. Oh, and if we hit a big one, you'll definitely hear about it!";
