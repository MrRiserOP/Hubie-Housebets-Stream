/**
 * AnimationDirector — turns high-level intent into RigParams every frame.
 *
 * Layers (low → high priority, resolved PER CHANNEL so tracks never fight):
 *   1. base expression (face + default arm poses), held or permanent
 *   2. procedural life: breathing, head drift, idle behaviours (glances, hat/bow-tie adjust, stretches)
 *   3. speech: audio-driven mouth, emphasis nods, small talk gestures with the paws
 *   4. combos: timed multi-track sequences (big win, facepalm, shrug, chat wave, …)
 *      — the newest combo owns each channel it touches (face/head/body/armL/armR/gaze/hat)
 *   5. blink (normal / double / slow sleepy) applied last on the lids
 * Smoothing: spring physics (slight overshoot) for body, head, arms, hat; fast critically-damped for face & mouth.
 */
import type { AvatarStateName, Combo, Expression } from '../../../../packages/shared/src/protocol.ts';
import type { MouthShape } from '../../../../services/lipsync/src/lipsync.ts';
import { ARM_POSES, DEFAULT_PARAMS, type ArmPose, type ArmPoseName, type RigParams } from './params.ts';
import { EXPRESSIONS_V2 } from './expressions.ts';
import { COMBO_DEFS, type Channel, type ComboStep } from './combos.ts';

type NumKey = keyof RigParams;
const KEYS = Object.keys(DEFAULT_PARAMS) as NumKey[];

const FACE_KEYS = new Set<NumKey>(['lidL', 'lidR', 'lowerL', 'lowerR', 'eyeWide', 'browL', 'browR', 'browTiltL', 'browTiltR', 'sparkle', 'mouthSmile', 'mouthSmirk', 'mouthWide', 'mouthRound', 'mouthOpen', 'cheek', 'blush', 'zzz']);
const HEAD_KEYS = new Set<NumKey>(['headRot', 'headX', 'headY', 'headNod', 'headTurn']);
const BODY_KEYS = new Set<NumKey>(['forward', 'bounce', 'shoulders', 'bodyLean', 'shake']);
const HAT_KEYS = new Set<NumKey>(['hatTilt', 'hatLift', 'hatX']);
const SPRING_KEYS = new Set<NumKey>([...HEAD_KEYS, ...BODY_KEYS, ...HAT_KEYS, 'aLr', 'aLx', 'aLy', 'aLp', 'aRr', 'aRx', 'aRy', 'aRp']);
const FAST_KEYS = new Set<NumKey>(['mouthOpen', 'mouthWide', 'mouthRound', 'gazeX', 'gazeY']);

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export type GazeTarget = 'camera' | 'game' | 'chat' | 'wander';
const GAZE: Record<Exclude<GazeTarget, 'wander'>, { x: number; y: number }> = { camera: { x: 0, y: 0 }, game: { x: -0.88, y: 0.22 }, chat: { x: 0.78, y: 0.5 } };

function armParams(side: 'L' | 'R', pose: ArmPoseName): Partial<RigParams> {
  const a: ArmPose = ARM_POSES[pose];
  return side === 'L' ? { aLr: a.r, aLx: a.x, aLy: a.y, aLp: a.p, aLpt: a.pt ?? 0 } : { aRr: a.r, aRx: a.x, aRy: a.y, aRp: a.p, aRpt: a.pt ?? 0 };
}

interface ActiveCombo { combo: Combo; start: number }

export class Animator {
  params: RigParams = { ...DEFAULT_PARAMS };
  private vel: Partial<Record<NumKey, number>> = {};
  expression: Expression = 'idle';
  private exprUntil = 0;
  private baseExpression: Expression = 'idle';
  speaking = false;
  mouth: MouthShape = { open: 0, wide: 0, round: 0 };
  /** 0..1 intensity of the current line's emotion (excited lines gesture more) */
  speechIntensity = 0.6;
  /** Appearance → animation intensity: calm 0.6, normal 1, lively 1.3 (scales gestures + speech energy) */
  styleScale = 1;
  /** Section 14 switches */
  idleLife = true; talkGestures = true; reactions = true;
  /** while true, a "listening" or "thinking" cue is the dominant state until it expires */
  private cue: { kind: 'listening' | 'thinking'; until: number } | null = null;
  setCue(kind: 'listening' | 'thinking') {
    this.cue = { kind, until: this.time + (kind === 'thinking' ? 4.5 : 2.6) };
    if (kind === 'listening') { this.lookAt('chat', 2400); this.playCombo('chat_interaction'); }
    else { this.setExpression('thinking', 2600); this.playCombo('thinking'); this.lookAt('wander', 1500); }
  }
  /** one of ten human-readable states, derived from what the rig is doing right now */
  get state(): AvatarStateName { return avatarState({ expression: this.expression, combos: this.activeCombos, speaking: this.speaking, cue: this.cue && this.time < this.cue.until ? this.cue.kind : null }); }
  gazeTarget: GazeTarget = 'camera';
  private gazeUntil = 0;
  private gaze = { x: 0, y: 0 };
  private nextSaccade = 0;
  private nextBlink = 1.5;
  private blinkPhase = -1;
  private blinkDur = 0.16;
  private doubleBlink = false;
  private energy = 0;
  private lastOpen = 0;
  private nodImpulse = 0;
  private gesture: { side: 'L' | 'R'; x: number; y: number; p: number; until: number } | null = null;
  private nextGesture = 0;
  private combos: ActiveCombo[] = [];
  private nextIdle = 3;
  private idleTilt = 0;
  private idleTiltUntil = 0;
  time = 0;
  /** last rendered frame (params + oscillation + blink) */
  output: RigParams = { ...DEFAULT_PARAMS };
  onFx?: (fx: NonNullable<ComboStep['fx']>) => void;
  private firedFx = new Set<string>();

  get activeCombos(): Combo[] { return this.combos.map((c) => c.combo); }

  setExpression(e: Expression, holdMs = 0) {
    this.expression = e;
    this.exprUntil = holdMs > 0 ? this.time + holdMs / 1000 : 0;
    if (holdMs <= 0) this.baseExpression = e;
    if (Math.random() < 0.5 && this.blinkPhase < 0) this.startBlink(0.16);
  }

  playCombo(c: Combo) {
    if (!COMBO_DEFS[c]) return;
    // the same combo restarting replaces itself; others stack (newest wins per channel)
    this.combos = this.combos.filter((x) => x.combo !== c);
    this.combos.push({ combo: c, start: this.time });
    if (this.combos.length > 4) this.combos.shift();
  }

  lookAt(target: GazeTarget, ms = 2500) {
    this.gazeTarget = target;
    this.gazeUntil = this.time + ms / 1000;
    this.nextSaccade = 0;
  }

  private startBlink(dur: number, double = false) { this.blinkPhase = 0; this.blinkDur = dur; this.doubleBlink = double; }

  tick(dt: number): RigParams {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const t = this.time;

    if (this.exprUntil && t > this.exprUntil) { this.expression = this.baseExpression; this.exprUntil = 0; }
    const exprKey: Expression = this.speaking && this.expression === 'idle' ? 'speaking' : this.expression;
    const base = EXPRESSIONS_V2[exprKey];
    const target: RigParams = { ...DEFAULT_PARAMS, ...EXPRESSIONS_V2.idle.face, ...base.face };
    Object.assign(target, armParams('L', base.armL ?? 'tie'), armParams('R', base.armR ?? 'tie'));

    /* ---- combos: per-channel ownership, newest wins ---- */
    const owned = new Set<Channel>();
    const oscs: ComboStep['osc'] = [];
    let comboGaze: { x: number; y: number } | null = null;
    this.combos = this.combos.filter((c) => t - c.start < Math.max(...COMBO_DEFS[c.combo].map((s) => s.at + s.dur)));
    for (const c of this.combos) {
      const lt = t - c.start;
      COMBO_DEFS[c.combo].forEach((step, i) => {
        if (lt < step.at || lt > step.at + step.dur) return;
        if (step.expression) { Object.assign(target, pickKeys(EXPRESSIONS_V2[step.expression].face, FACE_KEYS)); owned.add('face'); }
        if (step.face) { Object.assign(target, step.face); owned.add('face'); }
        if (step.head) { Object.assign(target, step.head); owned.add('head'); }
        if (step.body) { Object.assign(target, step.body); owned.add('body'); }
        if (step.hat) { Object.assign(target, step.hat); owned.add('hat'); }
        if (step.armL) { Object.assign(target, armParams('L', step.armL)); owned.add('armL'); }
        if (step.armR) { Object.assign(target, armParams('R', step.armR)); owned.add('armR'); }
        if (step.gaze) { comboGaze = step.gaze; owned.add('gaze'); }
        if (step.osc) oscs.push(...step.osc);
        const key = `${c.combo}@${c.start}#${i}`;
        if (step.fx && !this.firedFx.has(key)) { this.firedFx.add(key); this.onFx?.(step.fx); if (this.firedFx.size > 200) this.firedFx.clear(); }
      });
    }
    const busy = this.combos.length > 0;

    /* ---- idle behaviours (only when quiet and no combo) ---- */
    if (this.idleLife && !this.speaking && !busy && t > this.nextIdle) {
      this.nextIdle = t + rand(3.5, 9);
      const roll = Math.random();
      if (roll < 0.22) this.lookAt('game', rand(1200, 2600));
      else if (roll < 0.36) this.lookAt('chat', rand(1000, 2000));
      else if (roll < 0.5) this.lookAt('wander', rand(800, 1600));
      else if (roll < 0.58) this.playCombo('hat_tip');
      else if (roll < 0.66) this.playCombo('bow_tie');
      else if (roll < 0.74) this.startBlink(0.55); // slow, sleepy blink
      else if (roll < 0.84) { this.idleTilt = rand(-7, 7); this.idleTiltUntil = t + rand(1.5, 3.5); }
      else if (roll < 0.9 && exprKey === 'idle') this.playCombo('nod');
      // else: just breathe
    }

    /* ---- gaze ---- */
    if (this.gazeUntil && t > this.gazeUntil) { this.gazeTarget = 'camera'; this.gazeUntil = 0; }
    if (t > this.nextSaccade) {
      const g = this.gazeTarget === 'wander' ? { x: rand(-0.9, 0.9), y: rand(-0.4, 0.5) } : GAZE[this.gazeTarget];
      const jitter = this.gazeTarget === 'camera' ? 0.12 : 0.07;
      this.gaze = { x: g.x + rand(-jitter, jitter), y: g.y + rand(-jitter * 0.7, jitter * 0.7) };
      this.nextSaccade = t + (this.speaking ? rand(0.5, 1.4) : rand(0.7, 2.8));
    }
    const gz: { x: number; y: number } = comboGaze ?? this.gaze;
    target.gazeX = gz.x;
    target.gazeY = exprKey === 'thinking' && !comboGaze ? -0.4 : gz.y;

    /* ---- procedural life ---- */
    const e = this.speaking ? 1 : 0;
    this.energy += ((this.mouth.open * e) - this.energy) * (1 - Math.exp(-8 * dt));
    if (!owned.has('head')) {
      target.headRot += Math.sin(t * 0.7) * 1.6 + Math.sin(t * 1.9 + 1.3) * 0.7 + (t < this.idleTiltUntil ? this.idleTilt : 0) + this.gaze.x * 2;
      target.headTurn += this.gaze.x * 0.35;
      target.headX += Math.sin(t * 0.5) * 1.5;
      target.headY += Math.sin(t * 0.9 + 0.4) * 1.2 - this.energy * 2.5;
      target.headRot += this.energy * 2.2 * Math.sin(t * 6.1) * this.speechIntensity * this.styleScale;
    }
    if (!owned.has('body')) {
      target.bodyLean += Math.sin(t * 0.35) * 0.8;
      if (this.speaking) target.forward += 0.15 * this.speechIntensity;
    }
    target.breath = (Math.sin(t * 1.6) + 1) / 2;
    if (!owned.has('hat')) target.hatTilt += -(this.params.headRot - target.headRot) * 0.5 + Math.sin(t * 1.1) * 0.6;

    /* ---- speech: mouth, emphasis nods, talk gestures ---- */
    if (this.speaking) {
      target.mouthOpen = Math.max(target.mouthOpen * 0.3, this.mouth.open);
      target.mouthWide = Math.max(target.mouthWide * 0.5, this.mouth.wide);
      target.mouthRound = this.mouth.round;
      target.mouthSmile = Math.min(target.mouthSmile, 0.8);
      // emphasis: a syllable that opens wide after a quiet moment → small nod
      if (this.mouth.open > 0.55 && this.lastOpen < 0.3 && Math.random() < 0.35) this.nodImpulse = 0.35 * this.speechIntensity;
      // talk gestures with whichever paw is free
      const freeSides = (['L', 'R'] as const).filter((s) => !owned.has(s === 'L' ? 'armL' : 'armR') && (s === 'L' ? (base.armL ?? 'tie') : (base.armR ?? 'tie')) === 'tie');
      if (this.talkGestures && t > this.nextGesture && freeSides.length) {
        const amp = (0.5 + this.speechIntensity) * this.styleScale;
        this.gesture = { side: pick(freeSides), x: rand(-6, 14) * amp, y: rand(-30, -6) * amp, p: rand(-20, 22) * amp, until: t + rand(0.45, 1.0) };
        this.nextGesture = t + rand(0.6, 1.5) / (0.6 + this.speechIntensity);
      }
    } else if (exprKey === 'laughing' && !owned.has('face')) {
      target.mouthOpen = 0.55 + Math.abs(Math.sin(t * 11)) * 0.35;
      target.headY += Math.sin(t * 11) * 2;
    } else if (exprKey === 'surprised' && !owned.has('face')) {
      target.mouthOpen = 0.55;
    }
    this.lastOpen = this.mouth.open;
    this.nodImpulse *= Math.exp(-5 * dt);
    target.headNod += this.nodImpulse;
    if (this.gesture && t < this.gesture.until && this.speaking) {
      const g = this.gesture, k = g.side === 'L' ? 'aL' : 'aR';
      (target as any)[`${k}x`] += g.x; (target as any)[`${k}y`] += g.y; (target as any)[`${k}p`] += g.p;
    }

    /* ---- blink ---- */
    if (this.blinkPhase < 0 && t > this.nextBlink) {
      const sleepy = exprKey === 'sleepy';
      const r = Math.random();
      if (sleepy || r < 0.08) this.startBlink(rand(0.45, 0.7));
      else this.startBlink(0.15, r < 0.24);
      this.nextBlink = t + (sleepy ? rand(1.5, 3.5) : rand(2.0, 6.5));
    }
    let blink = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / this.blinkDur;
      blink = Math.sin(Math.min(1, this.blinkPhase) * Math.PI);
      if (this.blinkDur > 0.3) blink = Math.min(1, blink * 1.25); // slow blink holds closed a moment
      if (this.blinkPhase >= 1) {
        if (this.doubleBlink) { this.doubleBlink = false; this.blinkPhase = 0; } else this.blinkPhase = -1;
      }
    }

    /* ---- integrate: springs for body/head/arms/hat, exponential for face ---- */
    const p = this.params;
    for (const k of KEYS) {
      const goal = target[k] as number;
      if (SPRING_KEYS.has(k)) {
        const stiff = k.startsWith('a') ? 90 : k.startsWith('hat') ? 60 : 110;
        const damp = 2 * Math.sqrt(stiff) * (k.startsWith('hat') ? 0.55 : 0.72);
        const v = (this.vel[k] ?? 0) + (stiff * (goal - (p[k] as number)) - damp * (this.vel[k] ?? 0)) * dt;
        this.vel[k] = v;
        (p[k] as number) += v * dt;
      } else {
        const rate = FAST_KEYS.has(k) ? 24 : 9;
        (p[k] as number) += (goal - (p[k] as number)) * (1 - Math.exp(-rate * dt));
      }
    }
    // point claws snap (no spring)
    p.aLpt = target.aLpt; p.aRpt = target.aRpt;
    // oscillations + blink go on the OUTPUT frame only, so they never feed back into the springs
    const out: RigParams = { ...p };
    for (const o of oscs) {
      const w = Math.sin(t * o.hz * Math.PI * 2);
      (out[o.param] as number) += o.param === 'bounce' ? o.amp * (0.5 + 0.5 * w) : o.amp * w;
    }
    out.lidL = Math.max(out.lidL, blink);
    out.lidR = Math.max(out.lidR, blink);
    this.output = out;
    return out;
  }
}

function pickKeys(o: Partial<RigParams>, keys: Set<NumKey>): Partial<RigParams> {
  const out: Partial<RigParams> = {};
  for (const [k, v] of Object.entries(o)) if (keys.has(k as NumKey)) (out as any)[k] = v;
  return out;
}

/**
 * Maps what the rig is doing to one of ten states. Priority: a big moment beats a small one, and any strong body/face signal beats
 * plain speaking; "speaking" only when nothing more specific is happening; "idle" otherwise.
 */
export function avatarState(i: { expression: Expression; combos: Combo[]; speaking: boolean; cue: 'listening' | 'thinking' | null }): AvatarStateName {
  const has = (...c: Combo[]) => i.combos.some((x) => c.includes(x));
  if (has('celebration', 'big_win', 'clap') || i.expression === 'celebrating') return 'celebrating';
  if (has('laughing') || i.expression === 'laughing') return 'laughing';
  if (has('surprise') || i.expression === 'surprised') return 'surprised';
  if (has('bad_result', 'facepalm') || i.expression === 'disappointed' || i.expression === 'sad') return 'disappointed';
  if (i.expression === 'excited') return 'excited';
  if (has('suspicious', 'shrug', 'mischief', 'point_game', 'confident') || i.expression === 'suspicious' || i.expression === 'mischievous') return 'reacting';
  if (i.cue === 'thinking' || has('thinking') || i.expression === 'thinking') return 'thinking';
  if (i.cue === 'listening' || has('chat_interaction', 'lean_in', 'point_chat')) return 'listening';
  if (i.speaking) return 'speaking';
  return 'idle';
}
