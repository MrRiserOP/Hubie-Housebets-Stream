/** Every animatable degree of freedom of the Hubie rig (v2). All numeric → all springable. */
export interface RigParams {
  // head
  headRot: number;    // tilt, degrees (+ clockwise)
  headX: number;
  headY: number;
  headNod: number;    // -1 (chin up) .. 1 (chin down)
  headTurn: number;   // -1 (look to viewer's left / game) .. 1 (right / chat) — fakes a 3/4 turn
  // body
  breath: number;     // 0..1
  bodyLean: number;   // degrees
  forward: number;    // -1 leaning back .. 1 leaning in
  bounce: number;     // px up
  shoulders: number;  // px raise
  shake: number;      // 0..1 laugh shake amplitude
  // eyes
  gazeX: number;      // -1..1
  gazeY: number;      // -1..1
  lidL: number;       // 0 open .. 1 closed (upper lid)
  lidR: number;
  lowerL: number;     // 0..1 lower-lid raise (squint / happy eyes)
  lowerR: number;
  eyeWide: number;    // 0..1 — bigger eye opening, smaller pupils
  browL: number;      // -1 down .. 1 up
  browR: number;
  browTiltL: number;  // + inner end up (worried/sad), - inner end down (angry/suspicious)
  browTiltR: number;
  sparkle: number;    // 0..1 extra eye highlights
  // mouth & cheeks
  mouthOpen: number;  // 0..1
  mouthWide: number;  // 0..1
  mouthRound: number; // 0..1
  mouthSmile: number; // -1 frown .. 1 big smile
  mouthSmirk: number; // -1..1 asymmetry (+ = right corner up)
  cheek: number;      // 0..1 cheeks pushed up (laughing / big smile)
  blush: number;      // 0..1
  // hat
  hatTilt: number;
  hatLift: number;
  hatX: number;
  // arms: rotation around elbow pivot, offset, paw (wrist) rotation, pointing claw
  aLr: number; aLx: number; aLy: number; aLp: number; aLpt: number;
  aRr: number; aRx: number; aRy: number; aRp: number; aRpt: number;
  bowWiggle: number;  // bow tie wiggle amplitude
  zzz: number;        // 0..1 sleepy Z bubbles
}

export const DEFAULT_PARAMS: RigParams = {
  headRot: 0, headX: 0, headY: 0, headNod: 0, headTurn: 0,
  breath: 0, bodyLean: 0, forward: 0, bounce: 0, shoulders: 0, shake: 0,
  gazeX: 0, gazeY: 0, lidL: 0.4, lidR: 0.4, lowerL: 0.1, lowerR: 0.1, eyeWide: 0,
  browL: 0, browR: 0, browTiltL: 0, browTiltR: 0, sparkle: 0,
  mouthOpen: 0, mouthWide: 0, mouthRound: 0, mouthSmile: 0.75, mouthSmirk: 0.3, cheek: 0.15, blush: 0,
  hatTilt: 0, hatLift: 0, hatX: 0,
  aLr: 0, aLx: 0, aLy: 0, aLp: 0, aLpt: 0,
  aRr: 0, aRx: 0, aRy: 0, aRp: 0, aRpt: 0,
  bowWiggle: 0.3, zzz: 0,
};

/** Arm poses, written for the LEFT arm; the right arm is mirrored automatically. */
export interface ArmPose { r: number; x: number; y: number; p: number; pt?: number }
export const ARM_POSES = {
  tie: { r: 0, x: 0, y: 0, p: 0 },               // holding the bow tie (reference pose)
  rest: { r: 14, x: 0, y: 44, p: 0 },            // lowered
  up: { r: -50, x: -8, y: -48, p: -20 },          // raised (celebrate)
  wave: { r: -50, x: 0, y: -42, p: -10 },        // raised, paw oscillates
  point_out: { r: -62, x: 34, y: -18, p: -55, pt: 1 },  // points outward (left arm → the game)
  point_front: { r: -14, x: 28, y: -18, p: 35, pt: 1 }, // points down/front (right arm → chat panel)
  clap: { r: 4, x: 46, y: -72, p: 62 },          // paws meet at chest
  facepalm: { r: -4, x: 22, y: -108, p: 28 },    // paw over eyes
  shrug: { r: -26, x: -22, y: -6, p: -70 },      // out to the side, palm up
  hat: { r: -28, x: -8, y: -152, p: -34 },       // up at the hat brim
  chin: { r: 0, x: 22, y: -40, p: 20 },          // thinking
  belly: { r: 8, x: 18, y: 26, p: 30 },          // laughing, holding belly
  cheek: { r: -26, x: -14, y: -28, p: 6 },        // surprised, paw to cheek
} satisfies Record<string, ArmPose>;
export type ArmPoseName = keyof typeof ARM_POSES;
