/**
 * Accumulated LIVE time. Counts only while the stream is CONFIRMED live (Kick API says live, or — only when Kick isn't set up —
 * OBS reports an active output) and the confirmation is fresh. Application uptime never counts. Persisted in the memory DB, so
 * it survives restarts; a crash or sleep never adds time because each tick adds at most MAX_STEP of confirmed time.
 */
import type { Memory } from '../../../services/memory/src/memory.ts';

export interface LiveSession { start: number; end: number; ms: number; source: string; open?: boolean }
export interface LiveConfirm { live: boolean; source: 'kick' | 'obs' | 'none'; fresh: boolean; detail: string }

export const MILESTONE_MS = 150 * 3600_000;
const MAX_STEP_MS = 45_000;       // never credit more than this between two ticks
const RECONNECT_WINDOW_MS = 10 * 60_000;

export class LiveClock {
  totalMs: number; sessions: LiveSession[]; reconnects: number;
  private cur: LiveSession | null = null;
  private lastTick = 0; private lastLiveAt = 0; lastDetail = 'not live'; lastSource = 'none'; live = false;
  disconnects: Array<{ at: number; detail: string }> = [];

  constructor(private mem: Memory, private now: () => number = Date.now) {
    this.totalMs = mem.get<number>('live.totalMs', 0);
    this.sessions = mem.get<LiveSession[]>('live.sessions', []);
    this.reconnects = mem.get<number>('live.reconnects', 0);
    this.disconnects = mem.get<Array<{ at: number; detail: string }>>('live.disconnects', []);
    // a session left open by a crash is closed at the last time it was confirmed — time we cannot confirm is not credited
    const last = this.sessions.at(-1);
    if (last?.open) { last.open = false; this.persist(); }
  }

  get currentMs() { return this.cur ? this.cur.ms : 0; }
  get current() { return this.cur; }
  get reachedMilestone() { return this.totalMs >= MILESTONE_MS; }

  /** Call regularly (every ~15 s) with what is known right now. */
  tick(c: LiveConfirm) {
    const t = this.now();
    const confirmed = c.live && c.fresh;
    this.lastDetail = c.detail; this.lastSource = c.source;
    if (confirmed) {
      if (!this.cur) {
        const prev = this.sessions.at(-1);
        if (prev && t - prev.end < RECONNECT_WINDOW_MS) { this.reconnects++; }
        this.cur = { start: t, end: t, ms: 0, source: c.source, open: true };
        this.sessions.push(this.cur);
        if (this.sessions.length > 200) this.sessions.splice(0, this.sessions.length - 200);
      } else if (this.lastTick) {
        const step = Math.min(Math.max(0, t - this.lastTick), MAX_STEP_MS);
        this.cur.ms += step; this.cur.end = t; this.totalMs += step;
      }
      this.lastLiveAt = t; this.live = true;
    } else if (this.cur) {
      this.cur.open = false; this.cur = null; this.live = false;
      this.disconnects.push({ at: t, detail: c.detail }); if (this.disconnects.length > 100) this.disconnects.shift();
    } else this.live = false;
    this.lastTick = t;
    this.persist();
  }

  private persist() {
    this.mem.set('live.totalMs', this.totalMs); this.mem.set('live.sessions', this.sessions);
    this.mem.set('live.reconnects', this.reconnects); this.mem.set('live.disconnects', this.disconnects);
  }

  summary() {
    return {
      live: this.live, totalMs: this.totalMs, currentMs: this.currentMs, sessionsCount: this.sessions.length, reconnects: this.reconnects,
      source: this.lastSource, detail: this.lastDetail, milestoneReached: this.reachedMilestone, milestoneHours: 150,
      sessions: this.sessions.slice(-30).reverse().map((s) => ({ start: s.start, end: s.end, ms: s.ms, source: s.source, live: !!s.open })),
      disconnects: this.disconnects.slice(-20).reverse(),
    };
  }
}

/** "150+ HOURS" once earned; otherwise the real total ("12 H 40 M"). */
export function formatLiveTotal(ms: number): string {
  if (ms >= MILESTONE_MS) return '150+ HOURS';
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h} H ${String(m).padStart(2, '0')} M` : `${m} MIN`;
}
