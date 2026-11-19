/**
 * Repetition prevention. Judges a candidate line against Hubie's recent speech:
 *  - near-duplicate wording (word-trigram + word-set similarity)
 *  - reused opener (first 3 words) within the last few lines
 *  - overused bare fillers ("Nope.", "Oh no.", "Interesting.", "Let's go.")
 *  - captions reused recently
 */

const FILLER_WORDS = new Set(['nope', 'oh no', 'interesting', 'lets go', "let's go", 'ouch', 'wow', 'nice', 'rude', 'okay', 'yikes', 'no', 'yes', 'hmm', 'wait']);

export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function trigrams(w: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  const tri = jaccard(trigrams(wa), trigrams(wb));
  const STOP = new Set(['the', 'a', 'an', 'i', 'to', 'and', 'of', 'that', 'is', 'it', 'this', 'you', 'we', 'my', 'in', 'on', 'for', 'was', 'me', 'chat', 'x']);
  const set = jaccard(new Set(wa.filter((w) => !STOP.has(w))), new Set(wb.filter((w) => !STOP.has(w))));
  return Math.max(tri, set * 0.9);
}

export function opener(s: string, n = 3) { return words(s).slice(0, n).join(' '); }

export function isBareFiller(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return FILLER_WORDS.has(t) || (t.split(' ').length <= 3 && [...FILLER_WORDS].some((f) => t === `${f} ${f}` || t === `${f} chat`));
}

export interface VarietyVerdict { ok: boolean; reason?: string; score: number }

export function judgeVariety(candidate: string, recent: string[], opts: { threshold?: number; openerWindow?: number } = {}): VarietyVerdict {
  const threshold = opts.threshold ?? 0.55;
  if (isBareFiller(candidate)) return { ok: false, reason: 'bare filler line', score: 1 };
  let worst = 0;
  for (const r of recent) worst = Math.max(worst, similarity(candidate, r));
  if (worst >= threshold) return { ok: false, reason: `too similar to a recent line (${worst.toFixed(2)})`, score: worst };
  const op = opener(candidate);
  if (op.split(' ').length >= 2 && recent.slice(-(opts.openerWindow ?? 6)).some((r) => opener(r) === op)) return { ok: false, reason: `reused opener "${op}"`, score: worst };
  return { ok: true, score: worst };
}

/** Build an "avoid" list for the LLM prompt from recent speech. */
export function avoidList(recent: string[]): string[] {
  const ops = [...new Set(recent.slice(-10).map((r) => opener(r)).filter((o) => o.split(' ').length >= 2))];
  return [...ops.map((o) => `opener "${o}…"`), 'bare one-word reactions'];
}
