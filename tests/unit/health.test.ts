/** Avatar health must not flap (regression for "avatar ok → down (no overlay/avatar page connected)" repeating). */
import { describe, expect, it } from 'vitest';
import { AvatarMonitor, HealthRegistry } from '../../apps/controller/src/health.ts';

describe('avatar health monitor', () => {
  const T0 = 1_000_000;
  const mk = () => { const m = new AvatarMonitor(); (m as any).started = T0; return m; };

  it('control/setup page open, no overlay: one clear "down" after the grace period — never flapping', () => {
    const m = mk();
    const states: string[] = [];
    // simulate 2 minutes, evaluated every 2 s (control page heartbeats are ignored upstream)
    for (let t = 0; t <= 120_000; t += 2000) states.push(m.evaluate([], T0 + t).state);
    const transitions = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
    expect(states[0]).toBe('unknown');
    expect(states.at(-1)).toBe('down');
    expect(transitions).toBe(1);
  });

  it('overlay connected with regular heartbeats: steady ok', () => {
    const m = mk();
    const states: string[] = [];
    for (let t = 0; t <= 120_000; t += 2000) { if (t % 4000 === 0) m.beat(1, T0 + t); states.push(m.evaluate([1], T0 + t).state); }
    expect(new Set(states.slice(1))).toEqual(new Set(['ok']));
  });

  it('a late heartbeat is "degraded", not "down"; a brief reconnect does not go down', () => {
    const m = mk();
    m.beat(1, T0 + 31_000);
    expect(m.evaluate([1], T0 + 40_000).state).toBe('ok');
    expect(m.evaluate([1], T0 + 50_000).state).toBe('degraded');   // 19 s without heartbeat
    expect(m.evaluate([], T0 + 51_000).state).toBe('unknown');     // page reloading
    m.connected(2, T0 + 53_000);
    expect(m.evaluate([2], T0 + 53_500).state).toBe('unknown');     // connecting, first heartbeat pending (not "degraded")
    m.beat(2, T0 + 54_000);
    expect(m.evaluate([2], T0 + 54_000).state).toBe('ok');          // back within debounce → never down
  });

  it('really disconnected → down after the debounce, with a fix-it message', () => {
    const m = mk();
    m.beat(1, T0 + 35_000);
    m.evaluate([1], T0 + 35_000);
    m.evaluate([], T0 + 36_000);
    const v = m.evaluate([], T0 + 47_000);
    expect(v.state).toBe('down');
    expect(v.detail).toMatch(/Open \/overlay/);
  });

  it('health registry sweep no longer times out the avatar on its own', () => {
    const h = new HealthRegistry();
    h.set('avatar', 'ok', 'x');
    (h as any).map.get('avatar').lastSeen = Date.now() - 60_000;
    (h as any).sweep();
    expect(h.get('avatar').state).toBe('ok');
  });
});
