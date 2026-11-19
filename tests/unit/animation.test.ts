/** Animation director: combos layer per channel, speech drives the mouth, idle life, blinks. */
import { describe, expect, it } from 'vitest';
import { Animator } from '../../apps/avatar/src/rig/animator.ts';
import { COMBO_DEFS, comboDuration } from '../../apps/avatar/src/rig/combos.ts';
import { EXPRESSIONS_V2 } from '../../apps/avatar/src/rig/expressions.ts';
import { COMBOS, EXPRESSIONS } from '../../packages/shared/src/protocol.ts';

function run(a: Animator, seconds: number, each?: (a: Animator) => void) {
  for (let t = 0; t < seconds; t += 1 / 60) { each?.(a); a.tick(1 / 60); }
  return a.output;
}
const quiet = () => { const a = new Animator(); (a as any).nextBlink = 1e9; (a as any).nextIdle = 1e9; return a; };

describe('animation director', () => {
  it('every expression and combo is defined', () => {
    for (const e of EXPRESSIONS) expect(EXPRESSIONS_V2[e], e).toBeTruthy();
    for (const c of COMBOS) { expect(COMBO_DEFS[c], c).toBeTruthy(); expect(comboDuration(c)).toBeGreaterThan(0.5); }
  });
  it('big win: eyes widen and brows rise, then paws lift and body bounces', () => {
    const a = quiet();
    a.playCombo('big_win');
    const early = run(a, 0.45);
    expect(early.eyeWide).toBeGreaterThan(0.6);
    expect(early.browL).toBeGreaterThan(0.6);
    const peak = run(a, 0.9);
    expect(peak.aLy).toBeLessThan(-25); // left paw raised
    expect(peak.aRy).toBeLessThan(-25); // right paw raised
    let maxBounce = 0;
    run(a, 1, (x) => { maxBounce = Math.max(maxBounce, x.output.bounce); });
    expect(maxBounce).toBeGreaterThan(4);
  });
  it('bad result: narrowed eyes, head tilt, shoulders drop', () => {
    const a = quiet();
    a.playCombo('bad_result');
    const p = run(a, 1.4);
    expect(p.lidL).toBeGreaterThan(0.5);
    expect(Math.abs(p.headRot)).toBeGreaterThan(3);
    expect(p.shoulders).toBeLessThan(-2);
  });
  it('suspicious: one brow up, squint, head tilt', () => {
    const a = quiet(); a.playCombo('suspicious');
    const p = run(a, 1.2);
    expect(p.browR - p.browL).toBeGreaterThan(0.8);
    expect(p.lowerL).toBeGreaterThan(0.35);
    expect(p.headRot).toBeGreaterThan(4);
  });
  it('chat interaction: looks toward chat and points', () => {
    const a = quiet(); a.playCombo('chat_interaction');
    const p = run(a, 1.0);
    expect(p.gazeX).toBeGreaterThan(0.5);
    expect(p.aRpt).toBe(1);
  });
  it('combos only take the channels they use (no conflicts)', () => {
    const a = quiet();
    a.setExpression('happy');
    a.playCombo('point_game'); // owns armL/gaze/head/body, not face
    const p = run(a, 0.8);
    expect(p.mouthSmile).toBeGreaterThan(0.85); // face still from "happy"
    expect(p.aLpt).toBe(1);
    expect(p.gazeX).toBeLessThan(-0.5);
  });
  it('speech drives the mouth from audio shapes and adds talk gestures', () => {
    const a = quiet();
    let i = 0, maxOpen = 0, armMove = 0;
    run(a, 3, (x) => { x.speaking = true; x.mouth = { open: (i++ % 20) < 10 ? 0.8 : 0.05, wide: 0.3, round: 0 }; maxOpen = Math.max(maxOpen, x.output.mouthOpen); armMove = Math.max(armMove, Math.abs(x.output.aRy) + Math.abs(x.output.aLy)); });
    expect(maxOpen).toBeGreaterThan(0.6);
    expect(armMove).toBeGreaterThan(4);
  });
  it('blinks happen on their own (normal, double, slow)', () => {
    const a = new Animator(); (a as any).nextIdle = 1e9;
    let closed = 0;
    run(a, 20, (x) => { if (x.output.lidL > 0.95) closed++; });
    expect(closed).toBeGreaterThan(2);
  });
  it('idle life: head and gaze keep moving while silent', () => {
    const a = new Animator();
    const xs: number[] = [];
    run(a, 12, (x) => xs.push(x.output.headRot + x.output.gazeX));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.5);
  });
});
