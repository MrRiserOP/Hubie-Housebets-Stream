/**
 * Lip-sync. Two strategies, both produce a MouthShape stream for the rig:
 *
 *  1. AudioLipSync — real-time analysis of the actual TTS audio playing in the
 *     browser (WebAudio AnalyserNode). Works with ANY TTS provider. RMS energy
 *     drives jaw opening; spectral balance chooses wide (ee/s) vs round (oo/o).
 *  2. textVisemeTrack — when no audio stream is accessible (browser Web Speech
 *     fallback), derive a viseme timeline from the text and the estimated
 *     duration, re-synced on word-boundary events.
 *
 * Pure TS, no DOM types required for the math so it can be unit-tested in Node.
 */

export interface MouthShape { open: number; wide: number; round: number }

export const CLOSED: MouthShape = { open: 0, wide: 0, round: 0 };

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Analyse one frame of frequency + time-domain data. */
export function analyseFrame(timeDomain: Uint8Array, freq: Uint8Array, sampleRate: number, state: { floor: number; peak: number }): MouthShape {
  // RMS of the waveform (128 = silence for byte data)
  let sum = 0;
  for (let i = 0; i < timeDomain.length; i++) { const v = (timeDomain[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / timeDomain.length);

  // adaptive noise floor and peak (auto-gain so quiet and loud voices both animate)
  state.floor = Math.min(rms, state.floor * 0.995 + rms * 0.005);
  state.peak = Math.max(rms, state.peak * 0.997);
  const range = Math.max(0.02, state.peak - state.floor);
  const level = clamp((rms - state.floor - 0.008) / range);

  // spectral bands (bin width = sampleRate / 2 / bins)
  const binHz = sampleRate / 2 / freq.length;
  const band = (lo: number, hi: number) => {
    let s = 0, n = 0;
    for (let i = Math.floor(lo / binHz); i < Math.min(freq.length, Math.ceil(hi / binHz)); i++) { s += freq[i]; n++; }
    return n ? s / n / 255 : 0;
  };
  const low = band(150, 700);     // jaw-open vowels: a, o
  const mid = band(700, 2200);    // e, i formants
  const high = band(3500, 8000);  // sibilants s, f, sh
  const tot = low + mid + high + 1e-6;

  const open = clamp(Math.pow(level, 0.8) * (0.55 + 0.6 * (low / tot)));
  const wide = clamp(((mid + high * 1.4) / tot) * 1.3 - 0.3) * clamp(level * 2);
  const round = clamp((low / tot) * 1.6 - 0.75) * clamp(level * 2);
  return { open, wide, round };
}

/** Attack/release smoothing so the jaw doesn't jitter. */
export function smoothMouth(prev: MouthShape, next: MouthShape, dt: number): MouthShape {
  const k = (target: number, cur: number) => {
    const rate = target > cur ? 28 : 14; // open fast, close slower
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  };
  return { open: k(next.open, prev.open), wide: k(next.wide, prev.wide), round: k(next.round, prev.round) };
}

/* ---------------- text → viseme timeline ---------------- */

export interface VisemeKey { t: number; shape: MouthShape }

const V: Record<string, MouthShape> = {
  a: { open: 0.85, wide: 0.3, round: 0 },
  e: { open: 0.45, wide: 0.8, round: 0 },
  i: { open: 0.3, wide: 0.9, round: 0 },
  o: { open: 0.7, wide: 0, round: 0.8 },
  u: { open: 0.35, wide: 0, round: 1 },
  m: { open: 0, wide: 0.1, round: 0 },       // m b p
  f: { open: 0.15, wide: 0.5, round: 0 },    // f v
  s: { open: 0.2, wide: 0.7, round: 0 },     // s z t d n
  l: { open: 0.35, wide: 0.3, round: 0 },
  w: { open: 0.25, wide: 0, round: 0.9 },
  rest: CLOSED,
};

function charViseme(c: string): MouthShape | null {
  c = c.toLowerCase();
  if ('a'.includes(c)) return V.a;
  if ('e'.includes(c)) return V.e;
  if ('iy'.includes(c)) return V.i;
  if ('o'.includes(c)) return V.o;
  if ('u'.includes(c)) return V.u;
  if ('mbp'.includes(c)) return V.m;
  if ('fv'.includes(c)) return V.f;
  if ('w'.includes(c)) return V.w;
  if ('l'.includes(c)) return V.l;
  if ('sztdnckgjxqrh'.includes(c)) return V.s;
  return null;
}

/**
 * Build a viseme timeline for `text` spread over `durationMs`.
 * Punctuation creates pauses (mouth closes), matching how TTS engines phrase.
 */
export function textVisemeTrack(text: string, durationMs: number): VisemeKey[] {
  const units: Array<{ w: number; shape: MouthShape }> = [];
  for (const ch of text) {
    if (/[.!?…]/.test(ch)) units.push({ w: 4, shape: CLOSED });
    else if (/[,;:—–-]/.test(ch)) units.push({ w: 2, shape: CLOSED });
    else if (/\s/.test(ch)) units.push({ w: 0.6, shape: { open: 0.08, wide: 0, round: 0 } });
    else {
      const v = charViseme(ch);
      if (v) units.push({ w: /[aeiouy]/i.test(ch) ? 1.3 : 0.8, shape: v });
    }
  }
  const total = units.reduce((s, u) => s + u.w, 0) || 1;
  const keys: VisemeKey[] = [];
  let t = 0;
  for (const u of units) {
    keys.push({ t: (t / total) * durationMs, shape: u.shape });
    t += u.w;
  }
  keys.push({ t: durationMs, shape: CLOSED });
  return keys;
}

/** Sample a timeline at time t (ms) with linear blending between keys. */
export function sampleTrack(track: VisemeKey[], t: number): MouthShape {
  if (!track.length || t <= 0) return CLOSED;
  if (t >= track[track.length - 1].t) return CLOSED;
  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (track[mid].t <= t) lo = mid; else hi = mid; }
  const a = track[lo], b = track[hi];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const mix = (x: number, y: number) => x + (y - x) * Math.min(1, f * 1.6);
  return { open: mix(a.shape.open, b.shape.open), wide: mix(a.shape.wide, b.shape.wide), round: mix(a.shape.round, b.shape.round) };
}

/** Rough speech duration estimate (ms) for timeouts and fallback animation. */
export function estimateDurationMs(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const pauses = (text.match(/[.!?…]/g)?.length ?? 0) * 250 + (text.match(/[,;:—]/g)?.length ?? 0) * 120;
  return Math.round(((words / 2.7) * 1000 + pauses + 300) / Math.max(0.5, rate));
}
