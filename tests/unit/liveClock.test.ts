import { describe, it, expect } from 'vitest';
import { Memory } from '../../services/memory/src/memory.ts';
import { LiveClock, formatLiveTotal, MILESTONE_MS } from '../../apps/controller/src/liveClock.ts';

const live = (l: boolean, fresh = true) => ({ live: l, fresh, source: 'kick' as const, detail: l ? 'kick says live' : 'kick says offline' });
function rig() { let t = 1_000_000; const mem = new Memory(':memory:'); const mk = () => new LiveClock(mem, () => t); return { mem, mk, adv: (ms: number) => { t += ms; }, now: () => t }; }

describe('live clock', () => {
  it('counts only confirmed-live time, not application uptime', () => {
    const r = rig(); const c = r.mk();
    for (let i = 0; i < 20; i++) { r.adv(15_000); c.tick(live(false)); }   // app up 5 min, stream offline
    expect(c.totalMs).toBe(0);
    for (let i = 0; i < 20; i++) { r.adv(15_000); c.tick(live(true)); }    // 5 min live (first tick starts the session)
    expect(c.totalMs).toBe(19 * 15_000);
  });
  it('stops counting on disconnect and resumes only when live is confirmed again; counts a reconnect', () => {
    const r = rig(); const c = r.mk();
    for (let i = 0; i < 5; i++) { r.adv(15_000); c.tick(live(true)); }
    const before = c.totalMs; expect(c.live).toBe(true);
    r.adv(15_000); c.tick(live(false)); expect(c.live).toBe(false);
    for (let i = 0; i < 10; i++) { r.adv(15_000); c.tick(live(false)); }
    expect(c.totalMs).toBe(before);
    r.adv(15_000); c.tick(live(true)); expect(c.reconnects).toBe(1); expect(c.sessions.length).toBe(2);
    r.adv(15_000); c.tick(live(true)); expect(c.totalMs).toBe(before + 15_000);
  });
  it('stale confirmation does not count as live', () => {
    const r = rig(); const c = r.mk();
    r.adv(15_000); c.tick(live(true)); r.adv(15_000); c.tick(live(true, false)); expect(c.live).toBe(false); expect(c.totalMs).toBe(0);
  });
  it('a long gap (sleep/crash) never credits more than one step', () => {
    const r = rig(); const c = r.mk();
    r.adv(15_000); c.tick(live(true)); r.adv(3 * 3600_000); c.tick(live(true));
    expect(c.totalMs).toBeLessThanOrEqual(45_000);
  });
  it('persists across restarts and does not credit the downtime', () => {
    const r = rig(); let c = r.mk();
    for (let i = 0; i < 9; i++) { r.adv(15_000); c.tick(live(true)); }
    const saved = c.totalMs; expect(saved).toBe(8 * 15_000);
    r.adv(30 * 60_000); // app was down for 30 min
    c = r.mk(); expect(c.totalMs).toBe(saved); expect(c.live).toBe(false);
    r.adv(15_000); c.tick(live(true)); r.adv(15_000); c.tick(live(true));
    expect(c.totalMs).toBe(saved + 15_000);
    expect(c.sessions.length).toBe(2); expect(c.sessions[0].open).toBe(false);
  });
  it('150+ HOURS appears only after 150 real hours are accumulated; never before', () => {
    expect(formatLiveTotal(149 * 3600_000 + 59 * 60_000)).toBe('149 H 59 M');
    expect(formatLiveTotal(MILESTONE_MS - 1)).not.toMatch(/150\+/);
    expect(formatLiveTotal(MILESTONE_MS)).toBe('150+ HOURS');
    const r = rig(); const c = r.mk(); expect(c.reachedMilestone).toBe(false);
    r.mem.set('live.totalMs', MILESTONE_MS); expect(r.mk().reachedMilestone).toBe(true);
  });
  it('keeps the session history bounded', () => {
    const r = rig(); const c = r.mk();
    for (let i = 0; i < 300; i++) { r.adv(15_000); c.tick(live(true)); r.adv(15_000); c.tick(live(false)); }
    expect(c.sessions.length).toBeLessThanOrEqual(200);
  });
});
