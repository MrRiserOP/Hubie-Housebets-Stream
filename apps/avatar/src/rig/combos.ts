/**
 * Animation combos: timed multi-track sequences. Each step targets one or more
 * CHANNELS for a time window; while a step is active its channels override the
 * base expression on those channels only, so combos, speech and idle behaviour
 * blend without fighting (see AnimationDirector).
 */
import type { Combo, Expression } from '../../../../packages/shared/src/protocol.ts';
import type { ArmPoseName, RigParams } from './params.ts';

export type Channel = 'face' | 'head' | 'body' | 'armL' | 'armR' | 'gaze' | 'hat';

export interface Osc { param: keyof RigParams; amp: number; hz: number }
export interface ComboStep {
  at: number;          // seconds from combo start
  dur: number;         // seconds
  face?: Partial<RigParams>;
  head?: Partial<RigParams>;
  body?: Partial<RigParams>;
  hat?: Partial<RigParams>;
  armL?: ArmPoseName;
  armR?: ArmPoseName;
  gaze?: { x: number; y: number };
  osc?: Osc[];          // oscillations layered while the step is active
  expression?: Expression; // face base for this step (merged under `face`)
  fx?: 'confetti' | 'sparkles' | 'zoom' | 'shake';
}

const G = { game: { x: -0.9, y: 0.2 }, chat: { x: 0.75, y: 0.5 }, viewer: { x: 0, y: 0 }, up: { x: 0.1, y: -0.6 } };

export const COMBO_DEFS: Record<Combo, ComboStep[]> = {
  big_win: [
    { at: 0, dur: 0.6, expression: 'surprised', face: { eyeWide: 1, browL: 1, browR: 1, mouthOpen: 0.7, mouthRound: 0.5 }, body: { forward: -0.8 }, gaze: G.game },
    { at: 0.5, dur: 2.6, expression: 'celebrating', face: { eyeWide: 0.6, sparkle: 1 }, body: { forward: 0.5 }, armL: 'up', armR: 'up', osc: [{ param: 'bounce', amp: 9, hz: 2.6 }, { param: 'aLy', amp: 10, hz: 2.6 }, { param: 'aRy', amp: 10, hz: 2.6 }], gaze: G.viewer, hat: { hatLift: 8 }, fx: 'confetti' },
    { at: 3.1, dur: 1.4, expression: 'happy', armL: 'wave', osc: [{ param: 'aLp', amp: 22, hz: 3 }] },
  ],
  bad_result: [
    { at: 0, dur: 0.7, expression: 'suspicious', face: { lidL: 0.6, lidR: 0.6 }, head: { headRot: -6 }, gaze: G.game },
    { at: 0.6, dur: 1.8, expression: 'disappointed', head: { headRot: 7, headNod: 0.3 }, body: { shoulders: -6, forward: -0.2 }, gaze: G.viewer, armL: 'rest' },
  ],
  suspicious: [
    { at: 0, dur: 2.6, expression: 'suspicious', head: { headRot: 9, headTurn: 0.3 }, body: { forward: 0.3 }, gaze: G.viewer, face: { browR: 0.9, lidL: 0.66 } },
  ],
  laughing: [
    { at: 0, dur: 2.2, expression: 'laughing', head: { headRot: -4 }, armL: 'belly', osc: [{ param: 'headRot', amp: 3.5, hz: 5 }, { param: 'mouthOpen', amp: 0.3, hz: 9 }, { param: 'bounce', amp: 3, hz: 5 }], body: { shake: 1 } },
  ],
  chat_interaction: [
    { at: 0, dur: 0.6, gaze: G.chat, head: { headTurn: 0.6, headRot: 4 } },
    { at: 0.4, dur: 1.6, gaze: G.chat, head: { headTurn: 0.5 }, armR: 'point_front', expression: 'happy' },
    { at: 1.8, dur: 1.4, gaze: G.viewer, armL: 'wave', osc: [{ param: 'aLp', amp: 20, hz: 3 }], expression: 'happy' },
  ],
  surprise: [
    { at: 0, dur: 1.6, expression: 'surprised', body: { forward: -0.9 }, head: { headNod: -0.4 }, hat: { hatLift: 12 }, armL: 'cheek', gaze: G.game },
    { at: 1.5, dur: 0.8, expression: 'suspicious', gaze: G.viewer },
  ],
  thinking: [
    { at: 0, dur: 2.8, expression: 'thinking', armL: 'chin', head: { headRot: 6, headNod: -0.2 }, gaze: G.up, osc: [{ param: 'aLp', amp: 6, hz: 1.2 }] },
  ],
  celebration: [
    { at: 0, dur: 3, expression: 'celebrating', armL: 'up', armR: 'up', osc: [{ param: 'bounce', amp: 8, hz: 2.4 }, { param: 'aLr', amp: 8, hz: 2.4 }, { param: 'aRr', amp: 8, hz: 2.4 }], body: { forward: 0.4 }, fx: 'sparkles' },
    { at: 3, dur: 1.2, armL: 'clap', armR: 'clap', osc: [{ param: 'aLx', amp: 9, hz: 4 }, { param: 'aRx', amp: 9, hz: 4 }], expression: 'happy' },
  ],
  facepalm: [
    { at: 0, dur: 2.2, expression: 'disappointed', armL: 'facepalm', head: { headNod: 0.6, headRot: -4 }, body: { shoulders: -5 }, face: { lidL: 1, lidR: 0.9 } },
    { at: 2.1, dur: 0.8, expression: 'confident', gaze: G.viewer },
  ],
  shrug: [
    { at: 0, dur: 1.9, expression: 'confident', armL: 'shrug', armR: 'shrug', body: { shoulders: 9 }, head: { headRot: 8 }, face: { browL: 0.7, browR: 0.7, mouthSmirk: -0.5 } },
  ],
  hat_tip: [
    { at: 0, dur: 1.6, armL: 'hat', hat: { hatTilt: -8, hatLift: 4 }, osc: [{ param: 'hatX', amp: 3, hz: 2 }], expression: 'confident', gaze: G.viewer },
  ],
  welcome_wave: [
    { at: 0, dur: 2.4, expression: 'happy', armL: 'wave', osc: [{ param: 'aLp', amp: 24, hz: 3 }], gaze: G.viewer, body: { forward: 0.3 } },
    { at: 2.3, dur: 1.4, armL: 'hat', hat: { hatTilt: -8, hatLift: 5 }, expression: 'confident' },
  ],
  sleepy: [
    { at: 0, dur: 2.6, expression: 'sleepy', head: { headNod: 0.7, headRot: -5 }, face: { lidL: 0.92, lidR: 0.92 } },
    { at: 2.5, dur: 0.6, expression: 'surprised', face: { eyeWide: 0.5 }, head: { headNod: -0.3 } },
  ],
  nod: [
    { at: 0, dur: 1.2, osc: [{ param: 'headNod', amp: 0.45, hz: 2.4 }], expression: 'happy' },
  ],
  point_game: [
    { at: 0, dur: 1.5, armL: 'point_out', gaze: G.game, head: { headTurn: -0.6, headRot: -3 }, body: { forward: 0.2 } },
  ],
  point_chat: [
    { at: 0, dur: 1.8, armR: 'point_front', gaze: G.chat, head: { headTurn: 0.6, headRot: 5 }, expression: 'happy' },
  ],
  clap: [
    { at: 0, dur: 1.6, armL: 'clap', armR: 'clap', osc: [{ param: 'aLx', amp: 9, hz: 4 }, { param: 'aRx', amp: 9, hz: 4 }], expression: 'happy' },
  ],
  lean_in: [
    { at: 0, dur: 2.2, body: { forward: 0.9 }, head: { headNod: 0.2 }, face: { eyeWide: 0.5, browL: 0.5, browR: 0.5 }, gaze: G.game },
  ],
  confident: [
    { at: 0, dur: 1.8, expression: 'confident', armL: 'tie', armR: 'tie', body: { forward: -0.3 }, head: { headNod: -0.25, headRot: 4 }, osc: [{ param: 'bowWiggle', amp: 1, hz: 2 }] },
  ],
  mischief: [
    { at: 0, dur: 2.2, expression: 'mischievous', head: { headRot: -7, headTurn: 0.2 }, gaze: G.viewer, osc: [{ param: 'aLp', amp: 8, hz: 3.5 }, { param: 'aRp', amp: 8, hz: 3.5 }] },
  ],
  bow_tie: [
    { at: 0, dur: 1.6, armL: 'tie', armR: 'tie', osc: [{ param: 'aLy', amp: 4, hz: 4 }, { param: 'aRy', amp: 4, hz: 4 }, { param: 'bowWiggle', amp: 2, hz: 1 }], expression: 'confident', head: { headNod: -0.2 } },
  ],
};

export function comboDuration(c: Combo): number {
  return Math.max(...COMBO_DEFS[c].map((s) => s.at + s.dur));
}
