import type { CaptionStyle, Combo, Emotion, Expression } from '../../../packages/shared/src/protocol.ts';

export type SegmentName =
  | 'welcome' | 'gameplay' | 'chat_time' | 'funny' | 'bonus_hype' | 'viewer_questions'
  | 'random_moment' | 'break' | 'return' | 'shoutouts' | 'celebration';

export type SpontaneousMode = 'story' | 'observation' | 'chat_question' | 'sloth_joke' | 'callback' | 'anticipation' | 'hat_bit';

export interface RoundInfo {
  outcome: 'win' | 'loss' | 'push' | 'unknown';
  multiplier?: number;
  target?: number;
  rolled?: number;
  tier: 'tiny' | 'small' | 'medium' | 'big' | 'huge';
  nearMiss: boolean;
  /** the result number itself was impressive (≥ 50x), whatever the payout */
  bigResult?: boolean;
}

/** A structured description of what Hubie should react to. Built by the director. */
export type Situation =
  | { kind: 'game_loaded'; game: string; simulated: boolean }
  | ({
      kind: 'round';
      game: string;
      simulated: boolean;
      payout?: number;
      stake?: number;
      lossStreak: number;
      winStreak: number;
      roundsPlayed: number;
      brief: boolean;
      /** when two routine rounds are grouped into one line */
      previous?: RoundInfo;
    } & RoundInfo)
  | { kind: 'bonus'; game: string; detail?: string }
  | { kind: 'chat_reply'; user: string; userId?: string; msgId?: string; text: string; isNew: boolean; isReturning: boolean; isQuestion: boolean; notes?: string }
  | { kind: 'segment'; segment: SegmentName; detail?: string; users?: string[] }
  | { kind: 'idle_filler'; minutesQuiet: number }
  | { kind: 'spontaneous'; mode: SpontaneousMode }
  | { kind: 'injection_deflect'; user: string };

export interface LineOut {
  text: string;
  expression: Expression;
  /** voice emotion */
  tone: Emotion;
  combo?: Combo;
  caption?: string;
  captionStyle?: CaptionStyle;
  rate?: number;
}

export interface LLMContext {
  recentLines: string[];
  recentChat: Array<{ user: string; text: string }>;
  showState: { segment: string; rounds: number; wins: number; losses: number; bestMultiplier: number; game: string };
  /** short human-readable history of recent game events, newest last */
  recentEvents?: string[];
  /** memorable facts this session (biggest win, worst streak, …) for callbacks */
  sessionFacts?: string[];
  /** running jokes Hubie has established, with how often they were used */
  runningJokes?: Array<{ id: string; text: string; uses: number }>;
  /** phrases/openers to avoid right now */
  avoid?: string[];
  /** steering for variety, e.g. "make an observation about the game's mood" */
  styleHint?: string;
  recentCaptions?: string[];
  /** Section 12 settings (0–100 dials etc.), already sanitised */
  persona?: { humor: number; sarcasm: number; roast: number; commentary: string; repetition?: string };
  /** which kind of joke to aim for this time (rotated so it never repeats back-to-back) */
  humourStyle?: { id: string; how: string };
  /** HAT RULE: false unless a viewer just brought the hat up. When false the line must not mention the hat at all. */
  hatAllowed?: boolean;
  /** short-term conversation memory: this viewer's earlier turns, recent exchanges, current topics */
  conversation?: { thisViewer: Array<{ said: string; hubieReplied?: string }>; recentExchanges: Array<{ user: string; said: string; hubieReplied?: string }>; topics: string[] };
  /** how the viewer's message reads: question / joking / teasing / compliment / criticism / thanks / greeting / neutral */
  viewerTone?: { tone: string; followUp: boolean; sarcasmLikely: boolean };
}

export interface LLMProvider {
  name: string;
  generate(situation: Situation, ctx: LLMContext): Promise<LineOut>;
}
