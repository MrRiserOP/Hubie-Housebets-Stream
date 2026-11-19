import type { Expression } from '../../../../packages/shared/src/protocol.ts';
import type { ArmPoseName, RigParams } from './params.ts';

export interface ExpressionTarget { face: Partial<RigParams>; armL?: ArmPoseName; armR?: ArmPoseName }

/** Base face/body targets for each expression. Combos and speech layer on top. */
export const EXPRESSIONS_V2: Record<Expression, ExpressionTarget> = {
  idle: { face: { lidL: 0.4, lidR: 0.4, lowerL: 0.1, lowerR: 0.1, mouthSmile: 0.75, mouthSmirk: 0.3, cheek: 0.15 }, armL: 'tie', armR: 'tie' },
  speaking: { face: { lidL: 0.3, lidR: 0.3, browL: 0.2, browR: 0.2, mouthSmile: 0.5, cheek: 0.1 } },
  happy: { face: { lidL: 0.3, lidR: 0.3, lowerL: 0.45, lowerR: 0.45, browL: 0.35, browR: 0.35, browTiltL: 0.1, browTiltR: 0.1, mouthSmile: 1, mouthSmirk: 0, cheek: 0.6, blush: 0.45 } },
  laughing: { face: { lidL: 0.78, lidR: 0.78, lowerL: 0.75, lowerR: 0.75, browL: 0.55, browR: 0.55, browTiltL: 0.4, browTiltR: 0.4, mouthSmile: 1, mouthWide: 0.8, cheek: 1, blush: 0.8, shake: 0.8 }, armL: 'belly', armR: 'tie' },
  surprised: { face: { lidL: 0, lidR: 0, lowerL: 0, lowerR: 0, eyeWide: 1, browL: 1, browR: 1, browTiltL: 0.25, browTiltR: 0.25, mouthSmile: 0, mouthSmirk: 0, mouthRound: 0.9, forward: -0.6, cheek: 0, sparkle: 0.4 }, armL: 'cheek', armR: 'rest' },
  excited: { face: { lidL: 0.05, lidR: 0.05, lowerL: 0.3, lowerR: 0.3, eyeWide: 0.7, browL: 0.85, browR: 0.85, mouthSmile: 1, mouthWide: 0.6, cheek: 0.8, blush: 0.55, sparkle: 1, forward: 0.6 }, armL: 'up', armR: 'tie' },
  celebrating: { face: { lidL: 0.55, lidR: 0.55, lowerL: 0.65, lowerR: 0.65, browL: 0.75, browR: 0.75, browTiltL: 0.2, browTiltR: 0.2, mouthSmile: 1, mouthWide: 0.9, cheek: 1, blush: 0.9, sparkle: 1 }, armL: 'wave', armR: 'up' },
  angry: { face: { lidL: 0.48, lidR: 0.48, lowerL: 0.4, lowerR: 0.4, browL: -1, browR: -1, browTiltL: -1, browTiltR: -1, mouthSmile: -0.6, mouthWide: 0.4, mouthSmirk: 0, cheek: 0 }, armL: 'rest', armR: 'tie' },
  sad: { face: { lidL: 0.6, lidR: 0.6, lowerL: 0, lowerR: 0, browL: 0.2, browR: 0.2, browTiltL: 1, browTiltR: 1, mouthSmile: -0.8, mouthSmirk: 0, mouthRound: 0.1, cheek: 0, shoulders: -4 }, armL: 'rest', armR: 'rest' },
  disappointed: { face: { lidL: 0.68, lidR: 0.68, lowerL: 0.15, lowerR: 0.15, browL: -0.2, browR: -0.2, browTiltL: 0.6, browTiltR: 0.6, mouthSmile: -0.4, mouthSmirk: -0.4, cheek: 0, shoulders: -5 }, armL: 'rest', armR: 'tie' },
  thinking: { face: { lidL: 0.5, lidR: 0.32, lowerL: 0.25, lowerR: 0.1, browL: -0.3, browR: 0.75, mouthSmile: 0.2, mouthRound: 0.3, mouthSmirk: 0.5, gazeY: -0.4 }, armL: 'chin', armR: 'tie' },
  mischievous: { face: { lidL: 0.55, lidR: 0.4, lowerL: 0.45, lowerR: 0.3, browL: -0.4, browR: 0.6, browTiltL: -0.5, browTiltR: 0.2, mouthSmile: 0.9, mouthSmirk: 1, cheek: 0.5 }, armL: 'tie', armR: 'tie' },
  confident: { face: { lidL: 0.45, lidR: 0.45, lowerL: 0.2, lowerR: 0.2, browL: 0.15, browR: 0.3, mouthSmile: 0.85, mouthSmirk: 0.6, cheek: 0.35, forward: -0.2 }, armL: 'tie', armR: 'tie' },
  sleepy: { face: { lidL: 0.82, lidR: 0.85, lowerL: 0.1, lowerR: 0.1, browL: -0.1, browR: -0.1, browTiltL: 0.3, browTiltR: 0.3, mouthSmile: 0.3, mouthSmirk: 0, cheek: 0.1, zzz: 1, headNod: 0.5 }, armL: 'rest', armR: 'rest' },
  suspicious: { face: { lidL: 0.62, lidR: 0.5, lowerL: 0.55, lowerR: 0.45, browL: -0.6, browR: 0.5, browTiltL: -0.6, browTiltR: -0.2, mouthSmile: 0.1, mouthSmirk: -0.6, cheek: 0.2 }, armL: 'tie', armR: 'tie' },
};
