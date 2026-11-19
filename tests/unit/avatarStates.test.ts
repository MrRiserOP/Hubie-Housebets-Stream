import { describe, expect, it } from 'vitest';
import { Animator, avatarState } from '../../apps/avatar/src/rig/animator.ts';
import { AVATAR_STATES } from '../../packages/shared/src/protocol.ts';

function run(a: Animator, seconds: number, each?: (a: Animator) => void) { for (let t = 0; t < seconds; t += 1 / 60) { each?.(a); a.tick(1 / 60); } }
const calm = () => { const a = new Animator(); (a as any).nextBlink = 1e9; (a as any).nextIdle = 1e9; return a; };

describe('ten avatar states', () => {
  it('idle → speaking', () => { const a = calm(); run(a, 1); expect(a.state).toBe('idle'); a.speaking = true; run(a, 0.5); expect(a.state).toBe('speaking'); });
  it('listening and thinking cues are distinct, move the body, and expire', () => {
    const a = calm(); a.setCue('listening'); run(a, 0.5); expect(a.state).toBe('listening');
    const gazeX = a.output.gazeX; expect(gazeX).toBeGreaterThan(0.2); // looking toward chat
    run(a, 6); expect(a.state).toBe('idle');
    a.setCue('thinking'); run(a, 0.5); expect(a.state).toBe('thinking'); run(a, 6); expect(a.state).toBe('idle');
  });
  it.each([
    ['laughing', (a: Animator) => a.playCombo('laughing')], ['surprised', (a: Animator) => a.playCombo('surprise')],
    ['disappointed', (a: Animator) => a.playCombo('bad_result')], ['celebrating', (a: Animator) => a.playCombo('celebration')],
    ['reacting', (a: Animator) => a.playCombo('suspicious')], ['excited', (a: Animator) => a.setExpression('excited', 3000)],
  ] as const)('%s', (name, trigger) => { const a = calm(); trigger(a); run(a, 0.4); expect(a.state).toBe(name); });
  it('all ten state names are reachable', () => {
    const seen = new Set<string>(['idle']);
    const cases: Array<Parameters<typeof avatarState>[0]> = [
      { expression: 'idle', combos: [], speaking: true, cue: null }, { expression: 'idle', combos: [], speaking: false, cue: 'listening' }, { expression: 'idle', combos: [], speaking: false, cue: 'thinking' },
      { expression: 'idle', combos: ['laughing'], speaking: false, cue: null }, { expression: 'excited', combos: [], speaking: false, cue: null }, { expression: 'idle', combos: ['surprise'], speaking: false, cue: null },
      { expression: 'idle', combos: ['facepalm'], speaking: false, cue: null }, { expression: 'idle', combos: ['big_win'], speaking: true, cue: null }, { expression: 'idle', combos: ['shrug'], speaking: false, cue: null }];
    for (const c of cases) seen.add(avatarState(c));
    expect([...seen].sort()).toEqual([...AVATAR_STATES].sort());
  });
  it('a big moment beats plain speaking', () => { expect(avatarState({ expression: 'idle', combos: ['big_win'], speaking: true, cue: null })).toBe('celebrating'); });
});

describe('natural life', () => {
  it('blinks naturally (≈ 8–30 times a minute) without being asked', () => {
    const a = new Animator(); let blinks = 0, prev = 0; run(a, 60, (x) => { const l = x.output.lidL; if (prev > 0.5 && l <= 0.5) blinks++; prev = l; });
    expect(blinks).toBeGreaterThanOrEqual(5); expect(blinks).toBeLessThanOrEqual(40);
  });
  it('idle life varies (glances, tilts, nods, adjustments) rather than looping, and can be switched off', () => {
    const behaviours = new Set<string>(); const a = new Animator();
    run(a, 400, (x) => { for (const c of x.activeCombos) behaviours.add(`combo:${c}`); behaviours.add(`gaze:${(x as any).gazeTarget}`); });
    expect(behaviours.size).toBeGreaterThanOrEqual(5);
    const off = new Animator(); off.idleLife = false; const seen = new Set<string>();
    run(off, 200, (x) => { for (const c of x.activeCombos) seen.add(c); }); expect(seen.size).toBe(0);
  });
  it('head and body keep moving subtly while idle (never a frozen avatar)', () => {
    const a = new Animator(); let minH = 9, maxH = -9, minB = 9, maxB = -9;
    run(a, 20, (x) => { const o = x.output; minH = Math.min(minH, o.headRot); maxH = Math.max(maxH, o.headRot); minB = Math.min(minB, o.bounce + o.forward); maxB = Math.max(maxB, o.bounce + o.forward); });
    expect(maxH - minH + (maxB - minB)).toBeGreaterThan(0.2);
  });
  it('talk gestures can be switched off', () => {
    const run2 = (on: boolean) => { const a = calm(); a.talkGestures = on; a.speaking = true; a.speechIntensity = 0.9; let move = 0; a.mouth = { open: 0.7, wide: 0, round: 0 } as any; run(a, 8, (x) => { x.mouth = { open: 0.7, wide: 0, round: 0 } as any; move = Math.max(move, Math.abs(x.output.aLy) + Math.abs(x.output.aRy)); }); return move; };
    expect(run2(true)).toBeGreaterThan(run2(false));
  });
  it('animation intensity scales energy', () => {
    const energy = (scale: number) => { const a = calm(); a.styleScale = scale; a.speaking = true; a.speechIntensity = 0.9; let m = 0; run(a, 8, (x) => { x.mouth = { open: 0.8, wide: 0, round: 0 } as any; m = Math.max(m, Math.abs(x.output.aLy) + Math.abs(x.output.aRy) + Math.abs(x.output.headRot)); }); return m; };
    expect(energy(1.6)).toBeGreaterThan(energy(0.4));
  });
});
