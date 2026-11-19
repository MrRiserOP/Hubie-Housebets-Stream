/**
 * Speech pipeline: request → LLM line → variety guard → safety → TTS → overlay playback → ack.
 *
 * - One utterance at a time (Hubie never talks over himself; two voice
 *   generations can never play simultaneously).
 * - Priority queue; a sufficiently higher-priority request interrupts the
 *   current line (e.g. a huge win cuts off small talk) — the overlay stops the
 *   old audio before the new one starts.
 * - Stale requests expire. Low-priority lines that can't be made fresh are dropped
 *   instead of repeating filler.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { CaptionStyle, Combo, Emotion, Expression, Utterance } from '../../../packages/shared/src/protocol.ts';
import type { Logger } from '../../../packages/shared/src/node.ts';
import type { LLMContext, LineOut, Situation } from '../../../services/ai/src/types.ts';
import { checkRoundLine, factualLine } from '../../../services/ai/src/factcheck.ts';
import { MockLLM, type ResilientLLM } from '../../../services/ai/src/providers.ts';
import type { VoiceService } from '../../../services/tts/src/tts.ts';
import { checkOutbound, SAFE_FALLBACK_LINES } from '../../../services/safety/src/safety.ts';
import { estimateDurationMs } from '../../../services/lipsync/src/lipsync.ts';
import { judgeVariety, avoidList } from '../../../services/ai/src/variety.ts';
import { hatViolation, mentionsHat } from '../../../services/ai/src/personality.ts';
import type { Memory } from '../../../services/memory/src/memory.ts';

export interface SpeechRequest {
  situation?: Situation;
  /** Fixed text (bypasses LLM but not safety). */
  text?: string;
  expression?: Expression;
  tone?: Emotion;
  combo?: Combo;
  caption?: string;
  captionStyle?: CaptionStyle;
  priority: number;        // 0..100
  reason: string;
  kind?: Utterance['kind'];
  replyTo?: { user: string; text: string };
  maxAgeMs?: number;
  interrupt?: boolean;     // allowed to interrupt lower priority speech
  /** if the line can't be made non-repetitive, drop it rather than say a stale line */
  droppable?: boolean;
  onSpoken?: (text: string, line: LineOut) => void;
  createdAt?: number;
  /** also post this text to chat (already safety-checked) */
  postToChat?: (text: string) => void;
}

export interface SpeechDeps {
  llm: () => ResilientLLM;
  voice: () => VoiceService;
  memory: Memory;
  log: Logger;
  ttsDir: string;
  context: (sit?: Situation) => LLMContext;
  play: (u: Utterance) => boolean;    // returns false if no overlay is connected
  stop: (reason: string) => void;
  caption: (text: string | undefined) => void;
  isStopped: () => boolean;
  /** body-language cue while Hubie is busy generating a line (thinking) */
  cue?: (c: 'thinking') => void;
}

export class SpeechQueue {
  private queue: SpeechRequest[] = [];
  current: { req: SpeechRequest; utt: Utterance; done: () => void } | null = null;
  private preparing = false;
  private lastSpokeAt = 0;
  private pendingAcks = new Map<string, () => void>();
  private mock = new MockLLM();
  recentCaptions: string[] = [];
  stats: Record<string, number> = { hatBlocked: 0, spoken: 0, blocked: 0, interrupted: 0, ackTimeouts: 0, regenerated: 0, dropped: 0, cachedAudio: 0, factFixed: 0 };

  constructor(private d: SpeechDeps) {
    setInterval(() => this.pump(), 120).unref();
  }

  get busy() { return !!this.current || this.preparing; }
  get idleForMs() { return this.busy ? 0 : Date.now() - this.lastSpokeAt; }
  get length() { return this.queue.length; }

  enqueue(req: SpeechRequest) {
    if (this.d.isStopped()) return;
    req.createdAt = Date.now();
    if (req.interrupt && this.current && req.priority >= this.current.req.priority + 30) {
      this.d.log.info(`interrupting "${this.current.utt.text.slice(0, 40)}" for ${req.reason}`);
      this.stats.interrupted++;
      this.d.stop('interrupted');
      this.current.done();
    }
    this.queue.push(req);
    this.queue.sort((a, b) => b.priority - a.priority || (a.createdAt! - b.createdAt!));
    if (this.queue.length > 10) this.queue.length = 10;
  }

  clear() {
    this.queue = [];
    if (this.current) { this.d.stop('cleared'); this.current.done(); }
  }

  ack(id: string) { this.pendingAcks.get(id)?.(); }

  private async pump() {
    if (this.busy || this.d.isStopped()) return;
    const now = Date.now();
    this.queue = this.queue.filter((r) => now - r.createdAt! <= (r.maxAgeMs ?? 30_000));
    const req = this.queue.shift();
    if (!req) return;
    this.preparing = true;
    try {
      if (req.situation && req.kind !== 'system' && !this.current) this.d.cue?.('thinking');
      const utt = await this.prepare(req);
      if (!utt || this.d.isStopped()) return;
      // a higher-priority interrupt may have arrived while we were generating
      const better = this.queue[0];
      if (better && better.interrupt && better.priority >= req.priority + 30) { this.d.log.info(`dropping "${utt.text.slice(0, 30)}" for ${better.reason}`); return; }
      await this.speak(req, utt);
    } catch (e) {
      this.d.log.error('speech pipeline error', e);
    } finally {
      this.preparing = false;
    }
  }

  /** Generate a line that passes the variety guard. */
  async generateFresh(sit: Situation, droppable: boolean): Promise<LineOut | null> {
    const recent = this.d.memory.recentLines(100);
    const llm = this.d.llm();
    let ctx = this.d.context(sit);
    for (let attempt = 0; attempt < 3; attempt++) {
      let line = await llm.generate(sit, ctx);
      // rounds: the line must match the game engine's numbers exactly
      if (sit.kind === 'round') {
        const extra = [ctx.showState.wins, ctx.showState.losses, ctx.showState.rounds, ctx.showState.bestMultiplier];
        let fc = checkRoundLine(line.text, sit, extra);
        if (!fc.ok) {
          this.stats.factFixed = (this.stats.factFixed ?? 0) + 1;
          this.d.log.warn(`fact check failed (${fc.reason}): ${line.text}`);
          const exact = `use EXACTLY these facts: result ${sit.rolled}x, target ${sit.target}x, outcome ${sit.outcome}${sit.outcome === 'win' ? `, payout ${sit.multiplier}x` : ', payout 0'}`;
          line = await llm.generate(sit, { ...ctx, avoid: [...(ctx.avoid ?? []), `the line "${line.text}" — it got the numbers wrong; ${exact}`] });
          fc = checkRoundLine(line.text, sit, extra);
          if (!fc.ok) { this.d.log.warn(`fact check failed twice (${fc.reason}) — using a factual line`); return factualLine(sit); }
        }
      }
      // HAT RULE: the hat may only come up when a viewer just talked about it
      if (hatViolation(line.text, ctx.hatAllowed ?? false)) {
        this.stats.regenerated++; this.stats.hatBlocked = (this.stats.hatBlocked ?? 0) + 1;
        this.d.log.info(`hat rule rejected: ${line.text}`);
        ctx = { ...ctx, avoid: [...(ctx.avoid ?? []), `the line "${line.text}" — do NOT mention any hat or headwear at all; talk about the actual moment`] };
        continue;
      }
      const v = judgeVariety(line.text, recent, ctx.persona?.repetition === 'strict' ? { threshold: 0.45, openerWindow: 8 } : {});
      if (v.ok) return line;
      this.stats.regenerated++;
      this.d.log.info(`variety guard rejected (${v.reason}): ${line.text}`);
      ctx = { ...ctx, avoid: [...avoidList(recent), `the line "${line.text}" (${v.reason}) — say something different`] };
    }
    // Only fall back to the built-in bank when there is no working AI (demo mode / provider outage).
    if (llm.isDemo || llm.lastProvider === 'mock') {
      for (let i = 0; i < 6; i++) {
        const m = await this.mock.generate(sit, { ...ctx, recentLines: recent });
        if (!hatViolation(m.text, ctx.hatAllowed ?? false) && judgeVariety(m.text, recent).ok) return m;
      }
      return null;
    }
    // AI works but kept repeating itself: skip optional chatter; for must-say lines keep the last AI line.
    if (droppable) return null;
    const last = await llm.generate(sit, ctx);
    if (hatViolation(last.text, ctx.hatAllowed ?? false)) { // still a hat line after retries: use a hat-free built-in line rather than break the rule
      for (let i = 0; i < 6; i++) { const m = await this.mock.generate(sit, { ...ctx, recentLines: recent }); if (!hatViolation(m.text, false)) return m; }
      return null;
    }
    return last;
  }

  private async prepare(req: SpeechRequest): Promise<Utterance | null> {
    let line: LineOut;
    if (req.text) line = { text: req.text, expression: req.expression ?? 'speaking', tone: req.tone ?? 'relaxed', combo: req.combo, caption: req.caption, captionStyle: req.captionStyle };
    else if (req.situation) {
      const fresh = await this.generateFresh(req.situation, !!req.droppable);
      if (!fresh) { this.stats.dropped++; this.d.log.info(`dropped low-priority line (${req.reason}): nothing fresh to say`); return null; }
      line = fresh;
    } else return null;

    const verdict = checkOutbound(line.text);
    if (!verdict.ok) {
      this.stats.blocked++;
      this.d.log.warn(`outbound line blocked (${verdict.reason}): ${line.text}`);
      line = { text: SAFE_FALLBACK_LINES[Math.floor(Math.random() * SAFE_FALLBACK_LINES.length)], expression: 'happy', tone: 'warm' };
    } else line.text = verdict.text!;
    if (line.caption) {
      const cv = checkOutbound(line.caption);
      if (!cv.ok || this.recentCaptions.includes(line.caption)) line.caption = undefined;
    }

    const id = crypto.randomUUID().slice(0, 12);
    const rate = line.rate ?? 1;
    const tts = await this.d.voice().synth({ id, text: line.text, tone: line.tone, rate });
    if (tts.cached) this.stats.cachedAudio++;
    return {
      id, text: line.text, expression: line.expression, tone: line.tone, emotion: line.tone, rate, priority: req.priority,
      combo: line.combo, caption: line.caption, captionStyle: line.captionStyle ?? (['slam', 'stamp', 'wobble', 'type', 'glow'] as CaptionStyle[])[Math.floor(Math.random() * 5)],
      replyTo: req.replyTo, kind: req.kind,
      audioUrl: tts.file ? `/tts/${path.relative(this.d.ttsDir, tts.file).split(path.sep).join('/')}` : undefined,
      browserSpeech: !!tts.browserSpeech,
      durationMs: tts.durationMs ?? estimateDurationMs(line.text, rate),
      provider: tts.provider, reason: req.reason,
    };
  }

  private speak(req: SpeechRequest, utt: Utterance): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pendingAcks.delete(utt.id);
        this.current = null;
        this.lastSpokeAt = Date.now();
        this.d.caption(undefined);
        resolve();
      };
      this.current = { req, utt, done };
      this.d.memory.markUsed(utt.text);
      if (utt.caption) { this.recentCaptions = [...this.recentCaptions.slice(-15), utt.caption]; }
      this.stats.spoken++;
      this.d.log.info(`SAY [${utt.expression}/${utt.tone}/${utt.combo ?? '-'}/${utt.provider}]${utt.caption ? ` {${utt.caption}}` : ''} ${utt.text}`);
      this.d.caption(utt.text);
      req.onSpoken?.(utt.text, { text: utt.text, expression: utt.expression, tone: utt.tone, combo: utt.combo, caption: utt.caption });
      req.postToChat?.(utt.text);
      const delivered = this.d.play(utt);
      this.pendingAcks.set(utt.id, done);
      // generous timeout: real audio duration is only known in the browser
      const timeout = delivered ? utt.durationMs * 1.8 + 6000 : utt.durationMs;
      const timer = setTimeout(() => {
        if (delivered) { this.stats.ackTimeouts++; this.d.log.warn(`speech ack timeout for ${utt.id}`); }
        done();
      }, timeout);
    });
  }
}
