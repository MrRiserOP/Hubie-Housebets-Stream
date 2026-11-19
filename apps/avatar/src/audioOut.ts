/**
 * One audio output for the Control Center (voice preview + audio test).
 *
 * Why WebAudio and not `new Audio(url).play()` after the request finishes:
 *  - the request takes 1–5 s (ElevenLabs generates the speech). Safari and Firefox only allow
 *    sound inside the click itself, so a later `play()` is silently rejected there;
 *  - so `unlock()` is called SYNCHRONOUSLY in the click handler: it creates/resumes the
 *    AudioContext and plays one silent sample. After that the context may play at any time.
 * The overlay (the OBS page) uses the same path: fetch → decodeAudioData → BufferSource.
 * Volume is a GainNode (0–100 %), remembered per browser.
 */
import { token } from './api.ts';

export type OutState = 'idle' | 'loading' | 'playing' | 'error';
export interface OutStatus {
  state: OutState;
  context: AudioContextState | 'none';
  sampleRate?: number;
  volume: number;
  label?: string;           // what is playing (e.g. "ElevenLabs · Charlie" or "Browser voice (fallback — not ElevenLabs)")
  error?: string;
  durationMs?: number;
  startedAt?: number;
  peak?: number;            // highest level measured while playing — proves sound actually went out
  bytes?: number;
}

const VOL_KEY = 'hubieVolume';
function loadVol() { try { const v = Number(localStorage.getItem(VOL_KEY)); return Number.isFinite(v) && v >= 0 && v <= 1 && localStorage.getItem(VOL_KEY) !== null ? v : 0.9; } catch { return 0.9; } }

class AudioOut {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private utter: SpeechSynthesisUtterance | null = null;
  private meterTimer = 0;
  private settle: (() => void) | null = null;
  private listeners = new Set<(s: OutStatus) => void>();
  status: OutStatus = { state: 'idle', context: 'none', volume: loadVol() };

  on(f: (s: OutStatus) => void) { this.listeners.add(f); f(this.status); return () => { this.listeners.delete(f); }; }
  private set(p: Partial<OutStatus>) {
    this.status = { ...this.status, ...p, context: this.ctx?.state ?? 'none', sampleRate: this.ctx?.sampleRate };
    for (const l of this.listeners) l(this.status);
  }

  /** MUST be called directly inside a click/tap handler (before any await). */
  unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.status.volume;
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.gain.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
        this.ctx.onstatechange = () => this.set({});
      }
      void this.ctx.resume();
      // one silent sample: the iOS/Safari way to fully unlock output inside the gesture
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) {
      this.set({ state: 'error', error: `This browser cannot play audio: ${(e as Error).message}` });
    }
    this.set({});
  }

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.02);
    try { localStorage.setItem(VOL_KEY, String(vol)); } catch { /* private mode */ }
    this.set({ volume: vol });
  }

  /** Download + decode + play. Resolves when playback ends (or rejects with a readable reason). */
  async playUrl(url: string, label: string): Promise<{ durationMs: number; peak: number }> {
    this.stop();
    if (!this.ctx || !this.gain) throw new Error('Audio was not unlocked by a click. Press the button again.');
    this.set({ state: 'loading', label, error: undefined, peak: 0 });
    let buf: AudioBuffer;
    try {
      const res = await fetch(url, { headers: token() ? { 'x-control-token': token() } : {} });
      if (!res.ok) throw new Error(`the audio file could not be downloaded (HTTP ${res.status})`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength < 200) throw new Error('the server returned an empty audio file');
      this.set({ bytes: bytes.byteLength });
      try { buf = await this.ctx.decodeAudioData(bytes); } catch { throw new Error('the browser could not decode the audio (not a valid MP3)'); }
    } catch (e) { this.set({ state: 'error', error: (e as Error).message }); throw e; }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* reported below */ } }
    if (this.ctx.state !== 'running') {
      const err = 'The browser is holding the sound back (audio is suspended). Click anywhere on this page, then press Play again.';
      this.set({ state: 'error', error: err });
      throw new Error(err);
    }
    return new Promise((resolve) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain!);
      this.src = src;
      let peak = 0;
      const td = new Uint8Array(this.analyser!.fftSize);
      const t0 = performance.now(); // the analyser still holds the PREVIOUS playback's samples for a moment: ignore the first 200 ms so a muted preview reads as silent
      const meter = () => {
        if (this.src !== src) return;
        this.analyser!.getByteTimeDomainData(td);
        if (performance.now() - t0 > 200) for (const v of td) peak = Math.max(peak, Math.abs(v - 128) / 128);
        this.set({ peak: Math.round(peak * 100) / 100 });
        this.meterTimer = requestAnimationFrame(meter);
      };
      const done = () => { this.settle = null; resolve({ durationMs: buf.duration * 1000, peak }); };
      this.settle = done; // Stop must also finish the promise, or the caller would wait forever
      src.onended = () => {
        cancelAnimationFrame(this.meterTimer);
        if (this.src === src) { this.src = null; this.set({ state: 'idle' }); }
        done();
      };
      src.start();
      this.set({ state: 'playing', durationMs: buf.duration * 1000, startedAt: Date.now() });
      this.meterTimer = requestAnimationFrame(meter);
    });
  }

  /** Browser's built-in voice — ONLY as a clearly labelled fallback. */
  speakBrowser(text: string, rate = 1): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) { const e = 'This browser has no built-in voice.'; this.set({ state: 'error', error: e }); reject(new Error(e)); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.volume = this.status.volume; u.pitch = 0.8;
      const v = speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang)); if (v) u.voice = v;
      u.onend = () => { if (this.utter === u) { this.utter = null; this.set({ state: 'idle' }); } resolve(); };
      u.onerror = (ev) => { this.utter = null; this.set({ state: 'error', error: `Browser voice failed: ${ev.error}` }); reject(new Error(ev.error)); };
      this.utter = u;
      this.set({ state: 'playing', label: 'Browser voice (fallback — not ElevenLabs)', error: undefined, startedAt: Date.now() });
      speechSynthesis.speak(u);
    });
  }

  stop() {
    cancelAnimationFrame(this.meterTimer);
    if (this.src) { const s = this.src; this.src = null; try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    if (this.settle) this.settle();
    if (this.utter) { this.utter = null; try { speechSynthesis.cancel(); } catch { /* ignore */ } }
    if (this.status.state === 'playing' || this.status.state === 'loading') this.set({ state: 'idle' });
  }
}

export const audioOut = new AudioOut();
if (typeof window !== 'undefined') (window as any).__audioOut = audioOut;
