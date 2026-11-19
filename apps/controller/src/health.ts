/** Component health registry. Components report via heartbeats; stale = down. */
import type { ComponentHealth, ComponentName, HealthState } from '../../../packages/shared/src/protocol.ts';

const STALE_MS: Partial<Record<ComponentName, number>> = {
  // avatar is managed by AvatarMonitor (connection + heartbeat + debounce), not by staleness alone
  'game-agent': 20_000, 'game-browser': 30_000, audio: 45_000, kick: 75_000, obs: 30_000,
};

export class HealthRegistry {
  private map = new Map<ComponentName, ComponentHealth>();
  private listeners: Array<(c: ComponentHealth, prev: HealthState | undefined) => void> = [];

  constructor(disabled: ComponentName[] = []) {
    const all: ComponentName[] = ['controller', 'game-agent', 'game-browser', 'ai', 'tts', 'avatar', 'audio', 'kick', 'obs'];
    for (const n of all) this.map.set(n, { name: n, state: disabled.includes(n) ? 'disabled' : 'unknown', restarts: 0 });
    this.set('controller', 'ok');
    setInterval(() => this.sweep(), 2000).unref();
  }

  onChange(fn: (c: ComponentHealth, prev: HealthState | undefined) => void) { this.listeners.push(fn); }

  set(name: ComponentName, state: HealthState, detail?: string) {
    const cur = this.map.get(name) ?? { name, state: 'unknown' as HealthState, restarts: 0 };
    if (cur.state === 'disabled' && state !== 'disabled') { cur.lastSeen = Date.now(); cur.detail = detail; return; }
    const prev = cur.state;
    const next: ComponentHealth = { ...cur, state, detail: detail ?? cur.detail, lastSeen: Date.now() };
    if (prev !== state && prev === 'down' && state === 'ok') next.restarts = (cur.restarts ?? 0) + 1;
    this.map.set(name, next);
    if (prev !== state) for (const l of this.listeners) l(next, prev);
  }

  /** Turn an optional component on/off at runtime (settings changed in the control center). */
  setEnabled(name: ComponentName, enabled: boolean) {
    const cur = this.map.get(name) ?? { name, state: 'unknown' as HealthState, restarts: 0 };
    const state: HealthState = enabled ? 'unknown' : 'disabled';
    if (cur.state === state || (enabled && cur.state !== 'disabled')) return;
    const prev = cur.state;
    const next = { ...cur, state, detail: enabled ? 'starting…' : 'turned off', lastSeen: Date.now() };
    this.map.set(name, next);
    for (const l of this.listeners) l(next, prev);
  }

  get(name: ComponentName) { return this.map.get(name)!; }
  isOk(name: ComponentName) { const s = this.map.get(name)?.state; return s === 'ok' || s === 'degraded'; }
  all(): ComponentHealth[] { return [...this.map.values()]; }

  private sweep() {
    const now = Date.now();
    for (const c of this.map.values()) {
      const limit = STALE_MS[c.name];
      if (!limit || c.state === 'disabled' || c.state === 'unknown' || c.state === 'down') continue;
      if (c.lastSeen && now - c.lastSeen > limit) this.set(c.name, 'down', `no heartbeat for ${Math.round((now - c.lastSeen) / 1000)}s`);
    }
  }
}

/**
 * Decides avatar (overlay page) health without flapping:
 *  - only real overlay/avatar pages count (the control panel and setup page do not)
 *  - startup grace period while pages (re)connect after a restart
 *  - "down" only after no overlay has been connected for DOWN_AFTER_MS continuously
 *  - "degraded" when connected but heartbeats are late (tab frozen/backgrounded)
 */
export class AvatarMonitor {
  static GRACE_MS = 30_000;
  static DOWN_AFTER_MS = 10_000;
  static LATE_MS = 15_000;
  private started = Date.now();
  private noOverlaySince: number | null = null;
  private lastBeat = new Map<number, number>();

  private connectedAt = new Map<number, number>();
  beat(clientId: number, now = Date.now()) { this.lastBeat.set(clientId, now); }
  connected(clientId: number, now = Date.now()) { this.connectedAt.set(clientId, now); }
  forget(clientId: number) { this.lastBeat.delete(clientId); this.connectedAt.delete(clientId); }

  evaluate(connectedIds: number[], now = Date.now()): { state: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string } {
    const n = connectedIds.length;
    if (n === 0) {
      this.noOverlaySince ??= now;
      if (now - this.started < AvatarMonitor.GRACE_MS) return { state: 'unknown', detail: 'Starting up — waiting for the stream overlay page to connect' };
      if (now - this.noOverlaySince < AvatarMonitor.DOWN_AFTER_MS) return { state: 'unknown', detail: 'Overlay page reconnecting…' };
      return { state: 'down', detail: 'No stream overlay page is open. Open /overlay in a browser or add it to OBS as a Browser Source.' };
    }
    this.noOverlaySince = null;
    const fresh = connectedIds.filter((id) => now - (this.lastBeat.get(id) ?? 0) < AvatarMonitor.LATE_MS).length;
    if (fresh === 0) {
      const newest = Math.max(...connectedIds.map((id) => this.connectedAt.get(id) ?? 0));
      if (now - newest < AvatarMonitor.LATE_MS) return { state: 'unknown', detail: 'Overlay page connecting…' };
      // connected for a while but silent → frozen / background tab
      return { state: now - this.started < AvatarMonitor.GRACE_MS ? 'unknown' : 'degraded', detail: `${n} overlay page(s) connected but not responding (browser tab hidden or frozen?)` };
    }
    return { state: 'ok', detail: `${fresh} overlay page${fresh > 1 ? 's' : ''} live${fresh > 1 ? ' (only one should play audio)' : ''}` };
  }
}
