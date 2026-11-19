/**
 * Background music for the stream overlay (the page cloud/desktop OBS captures).
 *  - two <audio> decks cross-fade, so a track change is never a hard cut and two tracks never play at full level together
 *  - the next track is chosen from the enabled tracks (mood-aware, no immediate repeats, shuffled in bags)
 *  - ducking: while Hubie speaks the music drops to `duckLevel` %, and eases back afterwards
 *  - recovery: a track that fails to load/play is skipped with backoff; a stalled deck is restarted by a watchdog; if every
 *    track fails it retries every minute. Nothing here can throw into the rest of the page.
 *  - memory: only two audio elements exist for the whole session, however many days it runs
 */
import type { AudioSettings, MusicStatus, MusicTrack } from '../../../packages/shared/src/protocol.ts';

const XFADE_S = 4;
export class MusicPlayer {
  private decks: HTMLAudioElement[] = []; private deckGain: GainNode[] = []; private bus: GainNode;
  private active = 0; private tracks: MusicTrack[] = []; private settings: AudioSettings | null = null; private mood = 'auto';
  private bag: string[] = []; private current?: MusicTrack; private pending?: MusicTrack; private lastIds: string[] = [];
  private ducked = false; private crossfading = false; private failStreak = 0; private retryAt = 0; private watch = 0; private lastTime = -1; private stuckFor = 0;
  status: MusicStatus = { state: 'off', plays: 0, failures: 0, skipped: 0, ducked: false, level: 0, at: Date.now() };
  onStatus?: (s: MusicStatus) => void;

  constructor(private ctx: AudioContext) {
    this.bus = ctx.createGain(); this.bus.gain.value = 0; this.bus.connect(ctx.destination);
    for (let i = 0; i < 2; i++) {
      const a = new Audio(); a.preload = 'auto'; a.crossOrigin = 'anonymous'; a.loop = false;
      const g = ctx.createGain(); g.gain.value = 0;
      try { ctx.createMediaElementSource(a).connect(g); g.connect(this.bus); } catch { /* reported as error on first play */ }
      a.addEventListener('error', () => { const bt = this.pending ?? this.current; if (bt) this.bad.set(bt.id, Date.now() + 10 * 60_000); this.onDeckError(i, a.error?.message || 'could not load or decode the track'); });
      a.addEventListener('ended', () => { if (i === this.active && !this.crossfading) void this.next('ended'); });
      this.decks.push(a); this.deckGain.push(g);
    }
    this.watch = window.setInterval(() => this.tick(), 1000);
  }

  private set(p: Partial<MusicStatus>) { this.status = { ...this.status, ...p, ducked: this.ducked, level: Math.round(this.target * 100) / 100, at: Date.now() }; this.onStatus?.(this.status); }

  apply(s: AudioSettings, tracks: MusicTrack[], autoMood: string) {
    const prevEnabled = this.settings?.musicEnabled, prevMood = this.mood;
    this.settings = s; this.tracks = tracks; this.mood = s.mood === 'auto' ? autoMood : s.mood;
    this.updateLevel();
    if (!s.musicEnabled) { this.fadeOutAll(); this.set({ state: 'off' }); return; }
    if (this.status.state === 'recovering' && this.retryAt) { // settings changed while waiting out failures: try again right away if a track is available
      const now = Date.now();
      if (this.tracks.some((t) => !s.disabledTracks.includes(t.id) && (this.bad.get(t.id) ?? 0) <= now)) { this.retryAt = 0; void this.next('settings changed'); return; }
    }
    if (!prevEnabled || !this.current) { if (!this.retryAt && this.status.state !== 'blocked' && this.status.state !== 'recovering') void this.next('start'); return; }
    // a disabled current track, or a switch to the exciting mood, moves on with a cross-fade
    if (s.disabledTracks.includes(this.current.id)) void this.next('track disabled');
    else if (this.mood !== prevMood && this.mood === 'hype' && this.current.mood !== 'hype') void this.next('mood');
  }

  duck(on: boolean) { this.ducked = on; this.updateLevel(); this.set({}); }
  private updateLevel() {
    const s = this.settings; if (!s) return;
    const base = s.musicEnabled ? s.musicVolume / 100 : 0;
    const target = base * (this.ducked && s.duckEnabled ? s.duckLevel / 100 : 1);
    // quick attack when Hubie starts talking, gentle release afterwards
    this.target = target;
    this.bus.gain.setTargetAtTime(target, this.ctx.currentTime, this.ducked ? 0.08 : 0.5);
  }

  private target = 0;
  private bad = new Map<string, number>();
  private pool(): MusicTrack[] {
    const s = this.settings; const now = Date.now();
    const enabled = this.tracks.filter((t) => !s?.disabledTracks.includes(t.id));
    // a track that failed to load is parked for 10 minutes so one broken file can never pin the playlist
    const healthy = enabled.filter((t) => (this.bad.get(t.id) ?? 0) <= now);
    const ok = healthy.length ? healthy : enabled;
    const m = this.mood === 'auto' ? [] : ok.filter((t) => t.mood === this.mood || t.user);
    return m.length ? m : ok;
  }
  private pickNext(): MusicTrack | undefined {
    const pool = this.pool(); if (!pool.length) return undefined;
    this.bag = this.bag.filter((id) => pool.some((t) => t.id === id));
    if (!this.bag.length) { this.bag = pool.map((t) => t.id).sort(() => Math.random() - 0.5); }
    // never the same track twice in a row unless it is the only one
    let id = this.bag.shift()!; if (pool.length > 1 && id === this.current?.id) { this.bag.push(id); id = this.bag.shift()!; }
    return pool.find((t) => t.id === id);
  }

  private async next(why: string) {
    if (!this.settings?.musicEnabled) return;
    if (this.crossfading && why !== 'error') return;
    const t = this.pickNext();
    if (!t) { this.set({ state: 'error', lastError: 'no enabled tracks in the playlist' }); return; }
    try {
      if (this.ctx.state !== 'running') { await this.ctx.resume().catch(() => {}); }
      if (this.ctx.state !== 'running') { this.set({ state: 'blocked', lastError: 'browser is holding audio back (autoplay) — OBS browser source needs audio enabled' }); return; }
      const from = this.active, to = 1 - from, d = this.decks[to], g = this.deckGain[to].gain, now = this.ctx.currentTime;
      this.crossfading = true;
      this.pending = t; d.src = t.url; d.currentTime = 0;
      await d.play();
      g.cancelScheduledValues(now); g.setValueAtTime(0, now); g.linearRampToValueAtTime(1, now + XFADE_S);
      const og = this.deckGain[from].gain; og.cancelScheduledValues(now); og.setValueAtTime(og.value, now); og.linearRampToValueAtTime(0, now + XFADE_S);
      window.setTimeout(() => { try { if (this.active !== to) this.decks[from].pause(); } catch { /* ignore */ } this.crossfading = false; }, XFADE_S * 1000 + 100);
      this.active = to; this.current = t; this.pending = undefined; this.failStreak = 0;
      this.lastIds = [...this.lastIds.slice(-4), t.id];
      this.set({ state: 'crossfading', track: t.title, mood: t.mood, plays: this.status.plays + 1, lastError: undefined });
      window.setTimeout(() => { if (this.status.state === 'crossfading') this.set({ state: 'playing' }); }, XFADE_S * 1000);
    } catch (e) { this.crossfading = false; this.bad.set(t.id, Date.now() + 10 * 60_000); this.onDeckError(this.active, (e as Error).message || String(e)); }
  }

  private lastFailAt = 0;
  private onDeckError(i: number, msg: string) {
    if (!this.settings?.musicEnabled) return;
    if (Date.now() - this.lastFailAt < 800) return; // the rejected play() and the element's error event describe the same failure
    this.lastFailAt = Date.now();
    this.failStreak++; this.set({ failures: this.status.failures + 1, skipped: this.status.skipped + 1, lastError: msg.slice(0, 160), state: 'recovering' });
    // another track that has not failed → move on almost immediately; only when EVERY enabled track is parked do we wait a minute
    const now = Date.now();
    const untried = this.tracks.some((t) => !this.settings!.disabledTracks.includes(t.id) && (this.bad.get(t.id) ?? 0) <= now);
    const wait = untried ? Math.min(5_000, 1000 * this.failStreak) : 60_000;
    this.retryAt = Date.now() + wait; void i;
  }

  private fadeOutAll() { const t = this.ctx.currentTime; for (const g of this.deckGain) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.4); } window.setTimeout(() => { if (!this.settings?.musicEnabled) for (const d of this.decks) { try { d.pause(); } catch { /* ignore */ } } }, 2500); this.current = undefined; }

  /** 1 Hz: schedule the cross-fade before a track ends, retry after failures, restart a stalled deck */
  private tick() {
    const s = this.settings; if (!s?.musicEnabled) return;
    const now = Date.now();
    if (this.retryAt && now >= this.retryAt) { this.retryAt = 0; void this.next('error'); return; }
    const d = this.decks[this.active];
    if (!this.current || this.status.state === 'recovering' || this.status.state === 'blocked') { if (this.status.state === 'blocked' && this.ctx.state === 'running') void this.next('unblocked'); return; }
    if (d.duration && Number.isFinite(d.duration) && d.duration - d.currentTime <= XFADE_S + 0.3 && !this.crossfading) { void this.next('end of track'); return; }
    if (!d.paused && d.currentTime === this.lastTime) { this.stuckFor++; } else this.stuckFor = 0;
    this.lastTime = d.currentTime;
    if (this.stuckFor >= 8 || (d.paused && !this.crossfading)) { this.stuckFor = 0; this.set({ failures: this.status.failures + 1, skipped: this.status.skipped + 1, lastError: 'playback stalled — moved to the next track' }); void this.next('error'); }
  }

  destroy() { clearInterval(this.watch); for (const d of this.decks) { try { d.pause(); d.removeAttribute('src'); } catch { /* ignore */ } } }
}
