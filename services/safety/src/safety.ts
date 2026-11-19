/**
 * Safety service. Pure functions, no I/O, so it is trivially testable.
 *
 * Two gates:
 *  - checkInbound(chat)   -> should Hubie even look at this message?
 *  - checkOutbound(text)  -> is it OK for Hubie to SAY / POST this?
 *
 * Chat and game content are untrusted. They are never concatenated into the
 * system prompt; the AI layer passes them as quoted data (see services/ai).
 */

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
  /** sanitized text (outbound only) */
  text?: string;
  /** for inbound: should be shown on overlay chat list? */
  display?: boolean;
}

const SLURS_AND_ABUSE = [
  // Keep this list short and generic; extend via config/blocklist.txt
  /\bn[i1!]gg(?:er|a)s?\b/i, /\bf[a@]gg?(?:ot)?s?\b/i, /\bretard(?:ed|s)?\b/i, /\btr[a@]nn(?:y|ies)\b/i,
  /\bk[iy]ll\s+(?:yo)?urself\b/i, /\bkys\b/i, /\bgo\s+die\b/i, /\bhang\s+yourself\b/i,
];

const SELF_HARM = [/\b(suicide|kill myself|end it all|self[- ]harm|cut myself)\b/i];

const PROMPT_INJECTION = [
  /ignore (all|any|previous|prior|the above).{0,20}(instructions|prompts?|rules)/i,
  /\b(system prompt|your instructions|developer message|jailbreak|DAN mode)\b/i,
  /\byou are now\b/i,
  /\b(reveal|print|show|tell me|what is|what's|leak).{0,25}\b(api[ _-]?key|token|password|secret|credentials?|env|\.env|prompt)\b/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\bpretend (to be|you are)\b/i,
];

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|gg|io|xyz|ru|tk|ly|me|tv|co)\b\/?)/i;

/** Outbound: things Hubie must never say. */
const OUTBOUND_BLOCK: Array<[RegExp, string]> = [
  [/\b(you|you'll|you will|guaranteed|guarantee|sure to|definitely)\b.{0,30}\b(win|profit|make money|get rich|double your)\b/i, 'promise of winnings'],
  [/\b(deposit|top[ -]?up|reload|load up|add funds|buy crypto)\b/i, 'deposit encouragement'],
  [/\b(bet|wager|gamble|go all[- ]in|chase)\b.{0,25}\b(your|real|rent|savings|paycheck|money)\b/i, 'gambling pressure'],
  [/\b(sure thing|can'?t lose|risk[- ]free|free money|easy money|guaranteed)\b/i, 'misleading financial claim'],
  [/\b(financial advice|investment|invest in)\b/i, 'financial advice'],
  [/(https?:\/\/|www\.)\S+/i, 'unsolicited link'],
  [/\b(sk-[A-Za-z0-9]{8,}|oauth:[a-z0-9]{8,}|api[_ -]?key\s*[:=])/i, 'credential disclosure'],
  [/\b(system prompt|my instructions say|as an ai language model)\b/i, 'prompt disclosure'],
  [/\b(sign ?up|use (my|the) (code|link)|promo code|referral)\b/i, 'promotional solicitation'],
];

export interface SafetyConfig {
  extraBlocklist?: RegExp[];
  maxMessageLen?: number;
}

// zero-width, bidi-override and control characters (built from escapes to keep the source ASCII)
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f]', 'g');

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkInbound(text: string, cfg: SafetyConfig = {}): SafetyVerdict & { injection?: boolean; selfHarm?: boolean; link?: boolean } {
  const t = normalize(text);
  if (!t) return { ok: false, reason: 'empty', display: false };
  if (t.length > (cfg.maxMessageLen ?? 400)) return { ok: false, reason: 'too long', display: false };
  for (const p of [...SLURS_AND_ABUSE, ...(cfg.extraBlocklist ?? [])]) {
    if (p.test(t)) return { ok: false, reason: 'abusive', display: false };
  }
  if (SELF_HARM.some((p) => p.test(t))) {
    // don't joke about it; director will respond with a gentle, fixed support line.
    return { ok: true, selfHarm: true, display: false, reason: 'self-harm mention' };
  }
  const link = LINK.test(t);
  if (link) return { ok: false, reason: 'link', link: true, display: false };
  if (PROMPT_INJECTION.some((p) => p.test(t))) {
    return { ok: false, reason: 'prompt injection / secret probing', injection: true, display: true };
  }
  // repeated-char / caps spam
  if (/(.)\1{14,}/.test(t)) return { ok: false, reason: 'char spam', display: false };
  const letters = t.replace(/[^a-z]/gi, '');
  if (letters.length > 20 && letters === letters.toUpperCase() && t.length > 40) {
    return { ok: true, reason: 'shouting', display: true };
  }
  return { ok: true, display: true };
}

export function checkOutbound(text: string): SafetyVerdict {
  let t = normalize(text)
    .replace(/[*#`~]/g, '') // strip markdown so TTS doesn't read it
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1') // _italics_ markers, but keep user_names intact
    .replace(/\s*\((?:laughs?|sighs?|pause)\)\s*/gi, ' ');
  // Directly negated advice ("don't chase it with real cash", "never deposit rent money") is the
  // responsible message we WANT Hubie to say; only an immediate negation counts, so
  // "don't hesitate to deposit" is still blocked.
  const screened = t.replace(/\bno (deposits?|depositing|chasing|chasing losses|real money|real cash|top[- ]?ups?)\b/gi, ' ').replace(/\b(don'?t|do not|never|please don'?t|no need to|not going to|shouldn'?t|should not|should never|(?:nobody|no one) should)\s+(?:ever\s+)?(bet|wager|gamble|chase|deposit|go all[- ]in)\b[^.!?]*/gi, ' ');
  // "nothing here is a sure thing", "never risk-free", "wins are not guaranteed" are the honest messages we want
  const screened2 = screened.replace(/\b(nothing|no|not|never|isn'?t|aren'?t|wasn'?t|nobody|don'?t|do not)\b(?:\s+\w+){0,4}?\s+(?:a |an )?(sure thing|can'?t lose|risk[- ]free|free money|easy money|guaranteed)\b/gi, ' ');
  for (const [re, reason] of OUTBOUND_BLOCK) {
    if (re.test(screened2)) return { ok: false, reason };
  }
  if (t.length > 420) t = t.slice(0, 400).replace(/\s+\S*$/, '') + '…';
  return { ok: true, text: t };
}

/** Lines safe to use if a self-harm mention appears in chat. Never LLM-generated. */
export const SUPPORT_LINE =
  "Hey, I saw something in chat that sounded heavy. If you're going through it, please reach out to someone you trust or a local support line. You matter more than any game.";

/** Lines used when outbound text was blocked and we still need to say something. */
export const SAFE_FALLBACK_LINES = [
  "Let's keep it fun, chat. Demo money, real vibes.",
  "Reminder from your favourite sloth: this is play money and it's all for fun.",
  "Okay, I'm going to slowly back away from that thought. Sloth speed.",
];

/** Duplicate / flood detection for chat. */
export class SpamGuard {
  private recentByUser = new Map<string, number[]>();
  private recentTexts = new Map<string, number>();
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  constructor(private perUserPerMin = 6, private dupWindowMs = 60_000) {}

  /** returns reason if spam, else null. Also deduplicates message ids. */
  check(id: string, userId: string, text: string, now = Date.now()): string | null {
    if (this.seenIds.has(id)) return 'duplicate id';
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2000) this.seenIds.delete(this.seenOrder.shift()!);

    const arr = (this.recentByUser.get(userId) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    this.recentByUser.set(userId, arr);
    if (arr.length > this.perUserPerMin) return 'user flood';

    const key = userId + '|' + normalize(text).toLowerCase();
    const last = this.recentTexts.get(key);
    this.recentTexts.set(key, now);
    if (last !== undefined && now - last < this.dupWindowMs) return 'duplicate text';
    if (this.recentTexts.size > 5000) this.recentTexts.clear();
    return null;
  }
}
