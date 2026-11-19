/**
 * Plays Hubie's utterances in the page and produces a live MouthShape for the rig.
 *  - audioUrl  → WebAudio playback + AnalyserNode lip-sync (real audio-driven)
 *  - browserSpeech → Web Speech API + text viseme track, re-synced on word boundaries
 *  - muted pages (control preview) → text viseme track only
 * Reports speech_started / speech_ended back to the controller.
 */
import type { Utterance } from '../../../packages/shared/src/protocol.ts';
import { analyseFrame, CLOSED, sampleTrack, smoothMouth, textVisemeTrack, type MouthShape, type VisemeKey } from '../../../services/lipsync/src/lipsync.ts';

export class SpeechPlayer {
  ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private voiceGain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private td = new Uint8Array(1024);
  private fd = new Uint8Array(512);
  private agc = { floor: 0.01, peak: 0.1 };
  private track: VisemeKey[] | null = null;
  private trackStart = 0;
  private current: Utterance | null = null;
  mouth: MouthShape = { ...CLOSED };
  private startedAt = 0;      // performance.now() when audible playback began
  private durationMs = 0;
  /** playback progress of the current line (for word-by-word subtitles) */
  progress(): { t: number; d: number } | null {
    if (!this.speaking || !this.startedAt) return null;
    return { t: performance.now() - this.startedAt, d: this.durationMs };
  }
  speaking = false;
  mode: 'audio' | 'speech' | 'text' | 'idle' = 'idle';
  /** lip-sync evidence for the current utterance: what drove the mouth and how much it moved */
  lip = { mode: 'idle' as string, peak: 0, frames: 0, openFrames: 0 };
  onStart?: (u: Utterance) => void;
  onEnd?: (u: Utterance, error?: string) => void;

  constructor(public audioEnabled: boolean) {
    if (audioEnabled) {
      try {
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.35;
        // analyser reads the voice BEFORE the volume control, so lip-sync is the same at any volume
        this.voiceGain = this.ctx.createGain();
        this.analyser.connect(this.voiceGain); this.voiceGain.connect(this.ctx.destination);
      } catch { this.ctx = null; }
    }
  }

  setVoiceVolume(pct: number) { if (this.voiceGain && this.ctx) this.voiceGain.gain.setTargetAtTime(Math.max(0, Math.min(1, pct / 100)), this.ctx.currentTime, 0.05); this.voicePct = pct; }
  voicePct = 100;
  get audioBlocked() { return !!this.ctx && this.ctx.state !== 'running'; }
  async unlock() { try { await this.ctx?.resume(); } catch { /* ignore */ } }

  async play(u: Utterance) {
    this.stop();
    this.current = u;
    this.speaking = true;
    this.lip = { mode: 'idle', peak: 0, frames: 0, openFrames: 0 };
    try {
      if (this.audioEnabled && u.audioUrl && this.ctx && this.analyser) {
        await this.unlock();
        const res = await fetch(u.audioUrl);
        if (!res.ok) throw new Error(`audio fetch ${res.status}`);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        if (this.current !== u) return; // stopped meanwhile
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = 1;
        src.connect(this.analyser);
        src.onended = () => this.finish(u);
        this.source = src;
        this.mode = 'audio';
        src.start();
        this.startedAt = performance.now();
        this.durationMs = buf.duration * 1000;
        if (this.ctx.state !== 'running') {
          // autoplay blocked: keep the show moving with text-driven mouth, report degraded audio
          this.mode = 'text';
          this.startTrack(u, buf.duration * 1000);
        }
        this.onStart?.(u);
        return;
      }
      if (this.audioEnabled && (u.browserSpeech || !u.audioUrl) && 'speechSynthesis' in window && speechSynthesis.getVoices().length > 0) {
        this.speakBrowser(u);
        return;
      }
      this.mode = 'text';
      this.startTrack(u, u.durationMs);
      this.onStart?.(u);
    } catch (e) {
      // fall back to silent text animation so the show continues
      this.mode = 'text';
      this.startTrack(u, u.durationMs);
      this.onStart?.(u);
      this.lastError = (e as Error).message;
    }
  }
  lastError = '';

  private startTrack(u: Utterance, ms: number) {
    this.track = textVisemeTrack(u.text, ms);
    this.trackStart = performance.now();
    this.startedAt = this.trackStart;
    this.durationMs = ms;
    window.setTimeout(() => this.finish(u, this.lastError || undefined), ms + 50);
  }

  private speakBrowser(u: Utterance) {
    const s = new SpeechSynthesisUtterance(u.text.replace(/(\d)x\b/gi, '$1 ex'));
    const voices = speechSynthesis.getVoices();
    const pref = voices.find((v) => /en[-_](US|GB)/i.test(v.lang) && /male|daniel|alex|fred|david|guy|google uk english male/i.test(v.name))
      ?? voices.find((v) => /^en/i.test(v.lang));
    if (pref) s.voice = pref;
    s.volume = this.voicePct / 100;
    s.pitch = u.tone === 'excited' ? 0.95 : 0.75;
    s.rate = u.rate * (u.tone === 'excited' ? 1.08 : 0.98);
    this.mode = 'speech';
    this.track = textVisemeTrack(u.text, u.durationMs);
    this.trackStart = performance.now();
    s.onboundary = (ev) => {
      // re-sync the viseme clock to the engine's word position
      if (!this.track) return;
      const frac = ev.charIndex / Math.max(1, u.text.length);
      this.trackStart = performance.now() - frac * u.durationMs;
    };
    s.onstart = () => { this.startedAt = performance.now(); this.durationMs = u.durationMs; this.onStart?.(u); };
    // Some engines (headless, OBS) "finish" instantly without speaking. Keep the line on screen
    // (mouth track + subtitles) for its natural length so pacing never collapses.
    const minEnd = performance.now() + u.durationMs * 0.85;
    const endLater = (err?: string) => {
      const wait = minEnd - performance.now();
      if (wait <= 0) this.finish(u, err);
      else { this.mode = 'text'; window.setTimeout(() => this.finish(u, err), wait); }
    };
    s.onend = () => endLater();
    s.onerror = (e) => endLater(e.error === 'interrupted' || e.error === 'canceled' ? undefined : `speechSynthesis: ${e.error}`);
    speechSynthesis.speak(s);
    // safety net: some engines never fire onend
    window.setTimeout(() => this.finish(u), u.durationMs * 2 + 3000);
  }

  private finish(u: Utterance, error?: string) {
    if (this.current !== u) return;
    this.current = null;
    this.speaking = false;
    this.track = null;
    this.mode = 'idle';
    this.source = null;
    this.startedAt = 0;
    this.onEnd?.(u, error);
  }

  stop() {
    const u = this.current;
    try { this.source?.stop(); } catch { /* ignore */ }
    // only cancel the browser voice if THIS player is using it (never cut off a preview in the same page)
    if (this.mode === 'speech' && 'speechSynthesis' in window) speechSynthesis.cancel();
    if (u) this.finish(u, 'stopped');
  }

  /** Call every animation frame. */
  update(dt: number): MouthShape {
    let target: MouthShape = CLOSED;
    if (this.speaking) {
      if (this.mode === 'audio' && this.analyser && this.ctx) {
        this.analyser.getByteTimeDomainData(this.td);
        this.analyser.getByteFrequencyData(this.fd);
        target = analyseFrame(this.td, this.fd, this.ctx.sampleRate, this.agc);
      } else if (this.track) {
        target = sampleTrack(this.track, performance.now() - this.trackStart);
      }
    }
    this.mouth = smoothMouth(this.mouth, target, dt);
    if (this.speaking) {
      this.lip.mode = this.mode;
      this.lip.frames++;
      if (this.mouth.open > 0.12) this.lip.openFrames++;
      if (this.mouth.open > this.lip.peak) this.lip.peak = this.mouth.open;
    }
    return this.mouth;
  }
}
