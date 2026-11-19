/**
 * Hubie's personality controls, humour variety, conversation memory and the HAT RULE.
 * Everything here is deterministic and testable; the LLM only receives the results as context.
 */
import { words } from './variety.ts';

export interface PersonalitySettings {
  humor: number;          // 0..100  how often/how hard he goes for a joke
  sarcasm: number;        // 0..100
  roast: number;          // 0..100  friendly teasing of viewers
  commentary: 'quiet' | 'balanced' | 'chatty';
  chatFrequency: 'low' | 'normal' | 'high';
  memoryTurns: number;    // conversation turns remembered (4..60)
  repetition: 'normal' | 'strict';
  hat: 'only_when_asked' | 'rare' | 'never';
}
export const DEFAULT_PERSONALITY: PersonalitySettings = { humor: 70, sarcasm: 45, roast: 35, commentary: 'balanced', chatFrequency: 'normal', memoryTurns: 24, repetition: 'strict', hat: 'only_when_asked' };

export function sanitizePersonality(p: Partial<PersonalitySettings> | undefined): PersonalitySettings {
  const d = DEFAULT_PERSONALITY; const o = { ...d, ...(p ?? {}) };
  const n = (v: unknown, lo: number, hi: number, def: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : def; };
  const pick = <T extends string>(v: unknown, opts: readonly T[], def: T): T => (opts as readonly string[]).includes(String(v)) ? (v as T) : def;
  return { humor: n(o.humor, 0, 100, d.humor), sarcasm: n(o.sarcasm, 0, 100, d.sarcasm), roast: n(o.roast, 0, 100, d.roast), commentary: pick(o.commentary, ['quiet', 'balanced', 'chatty'], d.commentary), chatFrequency: pick(o.chatFrequency, ['low', 'normal', 'high'], d.chatFrequency), memoryTurns: n(o.memoryTurns, 4, 60, d.memoryTurns), repetition: pick(o.repetition, ['normal', 'strict'], d.repetition), hat: pick(o.hat, ['only_when_asked', 'rare', 'never'], d.hat) };
}

/* ---------------- humour variety ---------------- */
export type HumourStyle = 'situational' | 'sarcasm' | 'comeback' | 'roast' | 'story' | 'unexpected' | 'self_deprecating' | 'internet' | 'straight';
export const HUMOUR_TEXT: Record<HumourStyle, string> = {
  situational: 'joke about what is ACTUALLY happening right now in the game or the stream (use the specific numbers/events)',
  sarcasm: 'dry sarcasm about the ridiculous situation or the odds — never aimed at a viewer unless they teased first',
  comeback: 'a quick, clever comeback to what the viewer just said, building on their exact words',
  roast: 'a friendly, affectionate tease of the viewer (never about appearance, identity or anything sensitive)',
  story: 'a very short funny story or imagined scenario (2–3 sentences) that connects to the moment',
  unexpected: 'a surprising observation or left-field comparison that makes people go "ha, true"',
  self_deprecating: 'make fun of his own bad prediction, reaction or mistake from earlier tonight',
  internet: 'light gaming/internet culture flavour (a meme-shaped reaction, chat-speak) — current, not dated, not forced',
  straight: 'no joke — sincere, warm or genuinely hyped; humour is not required in every line',
};
export const ALL_STYLES = Object.keys(HUMOUR_TEXT) as HumourStyle[];

export class HumourPicker {
  private recent: HumourStyle[] = [];
  constructor(private rand: () => number = Math.random) {}
  pick(s: PersonalitySettings, ctx: { chat: boolean; teased: boolean; lost: boolean; big: boolean; spontaneous: boolean }): HumourStyle {
    const w: Record<HumourStyle, number> = { situational: 3, sarcasm: 0.4 + s.sarcasm / 40, comeback: ctx.chat ? 3 : 0, roast: ctx.chat ? (s.roast / 40) * (ctx.teased ? 2.5 : 1) : 0, story: ctx.spontaneous ? 2.5 : 0.35, unexpected: 1.6, self_deprecating: ctx.lost ? 2.4 : 0.5, internet: 1.1, straight: 0.8 + (100 - s.humor) / 25 + (ctx.big ? 1.2 : 0) };
    for (const st of ALL_STYLES) { if (st === 'straight' && s.humor < 15) continue; if (this.recent.slice(-3).includes(st)) w[st] *= 0.05; else if (this.recent.slice(-6).includes(st)) w[st] *= 0.5; }
    if (s.humor < 15) for (const st of ALL_STYLES) if (st !== 'straight') w[st] *= 0.2;
    const total = ALL_STYLES.reduce((a, k) => a + w[k], 0);
    let r = this.rand() * total, choice: HumourStyle = 'situational';
    for (const k of ALL_STYLES) { r -= w[k]; if (r <= 0) { choice = k; break; } }
    this.recent.push(choice); if (this.recent.length > 12) this.recent.shift();
    return choice;
  }
}

/* ---------------- the hat rule ---------------- */
const HAT_RE = /\b(hat|hats|top hat|topper|headwear|fedora|cap|brim)\b/i;
export const mentionsHat = (text: string) => HAT_RE.test(text);

/**
 * The hat is a visual detail, not a personality. It may come up only when a viewer just talked about it
 * (or, with setting "rare", about once in a long while). Never otherwise.
 */
export function hatAllowed(s: PersonalitySettings, recentChatTexts: string[], currentViewerText: string | undefined, linesSinceHat: number, rand: () => number = Math.random): boolean {
  if (s.hat === 'never') return false;
  if (currentViewerText && mentionsHat(currentViewerText)) return true;
  if (recentChatTexts.slice(-3).some(mentionsHat)) return true;
  return s.hat === 'rare' && linesSinceHat >= 60 && rand() < 0.1;
}
export const hatViolation = (line: string, allowed: boolean) => !allowed && mentionsHat(line);

/* ---------------- understanding chat ---------------- */
export type ChatTone = 'question' | 'joking' | 'teasing' | 'compliment' | 'criticism' | 'thanks' | 'greeting' | 'neutral';
export interface ChatRead { tone: ChatTone; followUp: boolean; sarcasmLikely: boolean; topics: string[] }
const STOP = new Set('the a an and or but is are was were be been to of in on at for with it its this that these those you your yours i me my we our he she they them his her not no yes so as if do does did have has had can could will would should just really very too also then than there here what when where who why how about from into over out up down off one all any some more most much many like get got go going lol lmao haha hubie'.split(' '));

export function classifyChat(text: string, prevHubieLine?: string, prevFromSameUser = false): ChatRead {
  const t = text.toLowerCase();
  const joking = /\b(lol|lmao|lmfao|haha+|rofl|kek|😂|🤣)\b|😂|🤣|\/s\b|xd\b/.test(t);
  const sarcasm = /\/s\b|\byeah right\b|\bsure (buddy|thing)\b|\bwow,? (so|such) (smart|good|great)\b|\bgreat job\b.*\b(not|lol)\b|\bamazing\b.*\b(lol|\/s)\b|\bbig brain\b|\bnice one\b.*\b(lol|not)\b/.test(t);
  const compliment = /\b(love (you|this|it)|you'?re (great|funny|hilarious|the best|awesome)|so funny|goat|legend|best (streamer|sloth)|good (job|one)|nice (one|call|stream)|gg|pog|poggers)\b/.test(t);
  const criticism = /\b(boring|trash|bad|worst|rigged|scam|cringe|annoying|shut up|stop talking|not funny|mid|terrible|sucks)\b/.test(t);
  const teasing = /\b(you (lost|lose|suck|always)|skill issue|can'?t even|clown|noob|L\b|ratio|get good|bro really|bro thinks)\b/i.test(text) || (joking && /\byou\b/.test(t) && !compliment);
  const question = /\?\s*$/.test(t) || /^(what|why|how|who|where|when|do|does|are|is|can|will|should|did)\b/.test(t);
  const thanks = /\b(thanks|thank you|ty|thx)\b/.test(t);
  const greeting = /^(hi|hey|hello|yo|sup|hii+|hola|gm|good (morning|evening|night))\b/.test(t);
  const shortFollow = words(text).length <= 6 && /^(and|but|why|how|what about|so|then|really|wait|what|which|who|where|when|that|this|it|same|again|again\?)\b/.test(t);
  const followUp = prevFromSameUser && (shortFollow || /\b(that|this|it|those|them|again|earlier|before|last (round|one|time))\b/.test(t));
  const tone: ChatTone = criticism ? 'criticism' : teasing ? 'teasing' : compliment ? 'compliment' : thanks ? 'thanks' : question ? 'question' : sarcasm || joking ? 'joking' : greeting ? 'greeting' : 'neutral';
  const topics = words(text).filter((w) => w.length > 3 && !STOP.has(w)).slice(0, 5);
  void prevHubieLine;
  return { tone, followUp, sarcasmLikely: sarcasm, topics };
}

/* ---------------- conversation memory ---------------- */
export interface Turn { id: string; user: string; userId: string; text: string; at: number; reply?: string; tone: ChatTone; topics: string[] }

export class ConversationMemory {
  turns: Turn[] = [];
  private answered = new Set<string>();
  constructor(public maxTurns = 24, seed: Turn[] = []) { this.turns = seed.slice(-maxTurns); for (const t of this.turns) if (t.reply) this.answered.add(t.id); }
  setMax(n: number) { this.maxTurns = n; this.trim(); }
  private trim() { if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns); }
  add(t: Omit<Turn, 'reply'>) { this.turns.push({ ...t }); this.trim(); }
  alreadyAnswered(id: string) { return this.answered.has(id); }
  recordReply(id: string, reply: string) { const t = this.turns.find((x) => x.id === id); if (t) t.reply = reply; this.answered.add(id); if (this.answered.size > 500) this.answered = new Set([...this.answered].slice(-250)); }
  /** what this viewer and Hubie said to each other recently (for follow-ups) */
  thread(userId: string, windowMs = 20 * 60_000, now = Date.now(), n = 4): Turn[] { return this.turns.filter((t) => t.userId === userId && now - t.at < windowMs).slice(-n); }
  lastFrom(userId: string) { return [...this.turns].reverse().find((t) => t.userId === userId); }
  topics(n = 8): string[] { const c = new Map<string, number>(); for (const t of this.turns.slice(-12)) for (const w of t.topics) c.set(w, (c.get(w) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w); }
  /** compact, prompt-ready view */
  forPrompt(userId?: string) {
    return {
      thisViewer: userId ? this.thread(userId).map((t) => ({ said: t.text.slice(0, 140), hubieReplied: t.reply?.slice(0, 140) })) : [],
      recentExchanges: this.turns.slice(-6).map((t) => ({ user: t.user, said: t.text.slice(0, 100), hubieReplied: t.reply?.slice(0, 100) })),
      topics: this.topics(),
    };
  }
  snapshot() { return this.turns.slice(-this.maxTurns); }
}
