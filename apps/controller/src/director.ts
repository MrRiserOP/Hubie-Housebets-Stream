/**
 * Show + commentary director (v2).
 *
 * Show director: waits for "Start" (setup wizard / control panel / AUTO_START),
 * rotates segments with controlled randomness, persists state across restarts.
 *
 * Commentary director: turns game events and chat into SpeechRequests with
 * priorities and context (recent events, session facts, running jokes, viewer
 * memory, recent lines). Every round gets commentary — routine rounds can be
 * grouped in pairs so Hubie doesn't narrate every second. Spontaneous moments
 * (stories, questions, callbacks…) are rationed; silence is allowed.
 */
import type { ChatMessage, Combo, Expression, GameEvent, HubMessage, OverlayState, RoundResult } from '../../../packages/shared/src/protocol.ts';
import type { Logger } from '../../../packages/shared/src/node.ts';
import { ConversationMemory, HumourPicker, HUMOUR_TEXT, DEFAULT_PERSONALITY, sanitizePersonality, classifyChat, hatAllowed as hatOk, mentionsHat, type PersonalitySettings } from '../../../services/ai/src/personality.ts';
import type { Memory } from '../../../services/memory/src/memory.ts';
import type { LLMContext, RoundInfo, SegmentName, Situation, SpontaneousMode } from '../../../services/ai/src/types.ts';
import { checkInbound, SpamGuard, SUPPORT_LINE } from '../../../services/safety/src/safety.ts';
import type { SpeechQueue, SpeechRequest } from './speech.ts';

interface ShowState {
  started: boolean;
  segment: SegmentName;
  segmentStartedAt: number;
  segmentEndsAt: number;
  segmentSeq: number;
  lastSegments: SegmentName[];
  lastBreakAt: number;
  lastActiveAt: number;
  welcomedAt: number;
  stats: { rounds: number; wins: number; losses: number; bestMultiplier: number; balance?: number };
  lossStreak: number;
  winStreak: number;
  worstLossStreak: number;
  game: string;
  gameSimulated: boolean;
  lastRound?: RoundResult & { simulated: boolean };
  facts: string[];
  jokeUses: Record<string, number>;
}

const SEGMENT_TITLES: Record<SegmentName, string> = {
  welcome: 'Welcome to the House Party', gameplay: 'Live Gameplay', chat_time: 'Chat Check-In', funny: 'Sloth Stand-Up',
  bonus_hype: 'Big Moment!', viewer_questions: 'Ask Hubie', random_moment: 'Sloth Talk', break: 'Quick Breather', return: "We're Back",
  shoutouts: 'Viewer Shout-Outs', celebration: 'Celebration Time',
};

const SIDE_SEGMENTS: Array<[SegmentName, number]> = [['chat_time', 3], ['funny', 2], ['random_moment', 2], ['viewer_questions', 2], ['shoutouts', 2]];

export const RUNNING_JOKES = [
  { id: 'sloth_speed', text: 'doing things "at sloth speed"', re: /sloth speed/i },
  { id: 'bow_tie', text: 'the bow tie as a mood ring', re: /bow tie/i },
  { id: 'rivalry', text: 'his petty rivalry with the game', re: /rival|the game (owes|chose|is clearly)/i },
  { id: 'diary', text: 'his "diary of betrayals"', re: /diary/i },
  { id: 'hibiscus', text: 'hibiscus as luxury food', re: /hibiscus/i },
];

const SPONT_MODES: SpontaneousMode[] = ['story', 'observation', 'chat_question', 'sloth_joke', 'callback', 'anticipation'];

export interface DirectorDeps {
  memory: Memory;
  speech: SpeechQueue;
  log: Logger;
  requestRound: () => void;
  sendChat: (text: string) => void;
  setExpression: (e: Expression, holdMs?: number) => void;
  broadcast: (m: HubMessage) => void;
  onState: () => void;
  isStopped: () => boolean;
  gameAgentOnline: () => boolean;
  roundIntervalMs: number;
  chatEnabled: () => boolean;
  autoStart: boolean;
  pauseGame: (paused: boolean) => void;
}

export class Director {
  s: ShowState;
  chatLog: OverlayState['chat'] = [];
  recentRounds: NonNullable<OverlayState['recentRounds']> = [];
  private spam = new SpamGuard();
  private lastChatReplyAt = 0;
  private lastReplyByUser = new Map<string, number>();
  private lastChatAt = 0;
  private roundRequestedAt = 0;
  private lastRoundAt = 0;
  private greetedThisSession = new Set<string>();
  private roundsSinceFull = 0;
  private recentChatForCtx: Array<{ user: string; text: string; at: number }> = [];
  private recentEvents: string[] = [];
  private heldRound: (RoundInfo & { id: string }) | null = null;
  private lastSpontAt = 0;
  private lastSpontModes: SpontaneousMode[] = [];
  private activeChatters = new Map<string, { user: string; at: number }>();
  private shoutedOut = new Set<string>();
  private styleIdx = 0;
  /* personality (Section 12), conversation memory, humour rotation, hat rule */
  personality: PersonalitySettings = DEFAULT_PERSONALITY;
  conv = new ConversationMemory();
  humour = new HumourPicker();
  linesSinceHat = 100;
  private lastListenCueAt = 0;
  lastHumour = '';
  setPersonality(p: Partial<PersonalitySettings>) {
    this.personality = sanitizePersonality({ ...this.personality, ...p });
    this.conv.setMax(this.personality.memoryTurns);
    this.d.memory.set('personality', this.personality);
    this.d.onState();
    return this.personality;
  }

  /** delay between rounds (Control Center → 3 → "Delay between rounds") */
  roundIntervalMs = 7000;
  setRoundIntervalMs(ms: number) { this.roundIntervalMs = Math.max(2000, Math.min(120_000, ms)); }

  constructor(private d: DirectorDeps) {
    this.roundIntervalMs = d.roundIntervalMs;
    this.personality = sanitizePersonality(d.memory.get<Partial<PersonalitySettings>>('personality', {}));
    this.conv = new ConversationMemory(this.personality.memoryTurns, d.memory.get('conv', []));
    const now = Date.now();
    const saved = d.memory.get<ShowState | null>('show_state', null);
    const fresh: ShowState = {
      started: d.autoStart, segment: 'welcome', segmentStartedAt: now, segmentEndsAt: now + 20_000, segmentSeq: 0, lastSegments: [], lastBreakAt: now,
      lastActiveAt: now, welcomedAt: 0, stats: { rounds: 0, wins: 0, losses: 0, bestMultiplier: 0 }, lossStreak: 0, winStreak: 0, worstLossStreak: 0,
      game: 'starting…', gameSimulated: false, facts: [], jokeUses: {},
    };
    if (saved && now - saved.lastActiveAt < 15 * 60_000 && (saved.started || d.autoStart)) {
      const gap = now - saved.lastActiveAt;
      this.s = { ...fresh, ...saved, started: true, segmentEndsAt: saved.segmentEndsAt + gap, lastActiveAt: now };
      d.log.info(`resumed show state (segment=${this.s.segment}, rounds=${this.s.stats.rounds}, downtime=${Math.round(gap / 1000)}s)`);
      this.say({ text: "Aaand we're back. Tiny technical nap. Very on brand.", expression: 'happy', tone: 'playful', combo: 'hat_tip', priority: 60, reason: 'resume', kind: 'system' });
    } else {
      this.s = fresh;
      if (saved) { this.s.stats = saved.stats; this.s.facts = (saved.facts ?? []).slice(-6); }
      if (this.s.started) this.start(true);
    }
    setInterval(() => this.tick(), 500).unref();
    setInterval(() => this.persist(), 5000).unref();
  }

  get segmentTitle() { return SEGMENT_TITLES[this.s.segment] ?? 'Live'; }
  get started() { return this.s.started; }

  /** Start the show (wizard "START HUBIE STREAM", control panel, or AUTO_START). */
  start(auto = false) {
    if (this.s.started && !auto) return;
    this.s.started = true;
    this.d.log.info(`show started${auto ? ' (auto)' : ''}`);
    this.d.broadcast({ type: 'fx', fx: 'intro', text: "HUBIE'S HOUSE PARTY", sub: 'Live · Demo games · 18+' });
    this.d.pauseGame(false);
    this.startSegment('welcome');
    this.persist();
  }

  stop() {
    if (!this.s.started) return;
    this.s.started = false;
    this.d.speech.clear();
    this.d.pauseGame(true);
    this.d.log.info('show stopped (pre-show screen)');
    this.persist();
    this.d.onState();
  }

  persist() { this.s.lastActiveAt = Date.now(); this.d.memory.set('show_state', this.s); this.d.memory.set('conv', this.conv.snapshot()); }

  /* ---------------- LLM context ---------------- */

  contextForLLM(sit?: Situation): LLMContext {
    const lines = this.d.memory.recentLines(15);
    const jokes = RUNNING_JOKES.map((j) => ({ id: j.id, text: j.text, uses: this.s.jokeUses[j.id] ?? 0 }));
    return {
      recentLines: lines,
      recentChat: this.recentChatForCtx.slice(-8),
      recentEvents: this.recentEvents.slice(-10),
      sessionFacts: this.s.facts.slice(-6),
      runningJokes: jokes,
      recentCaptions: this.d.speech.recentCaptions.slice(-10),
      styleHint: this.styleHintFor(sit),
      ...this.personaContext(sit),
      showState: { segment: this.s.segment, rounds: this.s.stats.rounds, wins: this.s.stats.wins, losses: this.s.stats.losses, bestMultiplier: this.s.stats.bestMultiplier, game: this.s.game },
    };
  }

  /** persona dials, this turn's humour style, the hat rule, conversation memory and how the viewer's message reads */
  private personaContext(sit?: Situation): Partial<LLMContext> {
    const p = this.personality;
    // a viewer's hat mention opens a SHORT window (~2 min, ≤3 of Hubie's lines): afterwards the hat goes quiet again
    const hatWindow = this.linesSinceHatMention <= 3 ? 120_000 : 0;
    const chatTexts = hatWindow ? this.recentChatForCtx.filter((c) => Date.now() - c.at <= hatWindow).map((c) => c.text) : [];
    const cur = sit?.kind === 'chat_reply' ? sit.text : undefined;
    const out: Partial<LLMContext> = { persona: { humor: p.humor, sarcasm: p.sarcasm, roast: p.roast, commentary: p.commentary, repetition: p.repetition }, hatAllowed: hatOk(p, chatTexts, cur, this.linesSinceHat) };
    if (sit?.kind === 'chat_reply') {
      const prev = sit.userId ? this.conv.thread(sit.userId).filter((t) => t.id !== sit.msgId).at(-1) : undefined;
      const read = classifyChat(sit.text, undefined, !!prev);
      out.viewerTone = { tone: read.tone, followUp: read.followUp, sarcasmLikely: read.sarcasmLikely };
      out.conversation = this.conv.forPrompt(sit.userId);
    } else if (sit?.kind === 'spontaneous' || sit?.kind === 'round') out.conversation = this.conv.forPrompt();
    const lost = sit?.kind === 'round' && sit.outcome === 'loss';
    const big = sit?.kind === 'round' && (sit.tier === 'big' || sit.tier === 'huge');
    const chat = sit?.kind === 'chat_reply';
    const teased = out.viewerTone?.tone === 'teasing' || out.viewerTone?.tone === 'joking';
    if (sit && p.humor > 0 && sit.kind !== 'injection_deflect') {
      const id = this.humour.pick(p, { chat, teased, lost, big, spontaneous: sit.kind === 'spontaneous' || sit.kind === 'idle_filler' });
      out.humourStyle = { id, how: HUMOUR_TEXT[id] }; this.lastHumour = id;
    }
    return out;
  }

  /** called after every spoken line */
  private linesSinceHatMention = 99;
  noteSpoken(text: string) { this.linesSinceHatMention++; this.linesSinceHat = mentionsHat(text) ? 0 : this.linesSinceHat + 1; }

  private styleHintFor(sit?: Situation): string | undefined {
    if (!sit || sit.kind !== 'round') return undefined;
    const hints = [
      'react to the exact numbers, then a quick sloth-flavoured twist',
      'a dry, sarcastic one-liner aimed at the game, not the viewers',
      'compare the result to something from everyday sloth life',
      'address chat directly about this result',
      'if fitting, call back to one of the sessionFacts',
      'build a bit of anticipation for the next round',
      'use one running joke if it fits naturally (prefer ones with fewer uses)',
      'keep it short and smug',
    ];
    if (sit.brief) return 'short, specific, no filler words, different opener from recent lines';
    return hints[this.styleIdx++ % hints.length];
  }

  private addEvent(s: string) { this.recentEvents = [...this.recentEvents.slice(-14), s]; }
  private addFact(s: string) { if (!this.s.facts.includes(s)) this.s.facts = [...this.s.facts.slice(-7), s]; }

  /* ---------------- show segments ---------------- */

  startSegment(seg: SegmentName) {
    const now = Date.now();
    const dur: Record<SegmentName, [number, number]> = {
      welcome: [16, 24], gameplay: [150, 280], chat_time: [45, 70], funny: [25, 40], bonus_hype: [15, 25],
      viewer_questions: [50, 80], random_moment: [25, 40], break: [30, 45], return: [8, 12], shoutouts: [20, 30], celebration: [12, 18],
    };
    const [a, b] = dur[seg];
    const prev = this.s.segment;
    this.s.segment = seg;
    this.s.segmentStartedAt = now;
    this.s.segmentEndsAt = now + (a + Math.random() * (b - a)) * 1000;
    this.s.segmentSeq++;
    this.s.lastSegments = [...this.s.lastSegments.slice(-4), seg];
    if (seg === 'break') { this.s.lastBreakAt = now; this.d.pauseGame(true); }
    if (prev === 'break' && seg !== 'break') this.d.pauseGame(false);
    if (seg === 'welcome') this.s.welcomedAt = now;
    this.d.log.info(`segment → ${seg}`);
    const users = seg === 'shoutouts' ? this.shoutoutCandidates() : undefined;
    if (seg !== 'gameplay' || Math.random() < 0.4) {
      this.say({ situation: { kind: 'segment', segment: seg, users }, priority: seg === 'welcome' ? 70 : 45, reason: `segment:${seg}`, kind: 'segment', maxAgeMs: 60_000, droppable: seg === 'gameplay' });
    }
    this.d.onState();
  }

  private shoutoutCandidates(): string[] {
    const now = Date.now();
    return [...this.activeChatters.values()].filter((c) => now - c.at < 15 * 60_000 && !this.shoutedOut.has(c.user)).map((c) => c.user).slice(0, 3);
  }

  nextSegment() {
    const now = Date.now();
    const cur = this.s.segment;
    if (cur === 'break') return this.startSegment('return');
    if (cur !== 'gameplay') return this.startSegment('gameplay');
    if (now - this.s.lastBreakAt > 20 * 60_000) return this.startSegment('break');
    let options = SIDE_SEGMENTS.filter(([s]) => !this.s.lastSegments.slice(-3).includes(s));
    // shout-outs only when real viewers have chatted (never fake viewers)
    if (!this.shoutoutCandidates().length) options = options.filter(([s]) => s !== 'shoutouts');
    const pool = options.length ? options : SIDE_SEGMENTS.filter(([s]) => s !== 'shoutouts');
    const total = pool.reduce((t, [, w]) => t + w, 0);
    let r = Math.random() * total;
    for (const [seg, w] of pool) { if ((r -= w) <= 0) return this.startSegment(seg); }
    this.startSegment('gameplay');
  }

  private tick() {
    if (this.d.isStopped() || !this.s.started) return;
    const now = Date.now();
    if (now > this.s.segmentEndsAt && !this.d.speech.busy) this.nextSegment();

    const gameplayAllowed = this.s.segment !== 'break' && this.s.segment !== 'welcome';
    const sinceRound = now - this.lastRoundAt;
    const waiting = this.roundRequestedAt && now - this.roundRequestedAt < 30_000;
    const interval = this.heldRound ? 1500 : this.roundIntervalMs;
    if (gameplayAllowed && !waiting && !this.d.speech.busy && this.d.speech.length === 0 && sinceRound > interval && this.d.gameAgentOnline()) {
      this.roundRequestedAt = now;
      this.d.broadcast({ type: 'combo', combo: 'point_game' });
      this.d.requestRound();
    }

    // a held routine round must not go uncommented if play pauses
    if (this.heldRound && now - this.lastRoundAt > 12_000) this.flushHeld();

    // silence is fine; only after a long quiet stretch with nothing happening do we add something
    if (this.d.speech.idleForMs > 75_000 && now - this.lastChatAt > 120_000 && now - this.lastSpontAt > 90_000) {
      this.spontaneous('idle');
    }
  }

  private flushHeld() {
    const h = this.heldRound;
    if (!h) return;
    this.heldRound = null;
    this.say({
      situation: { kind: 'round', game: this.s.game, simulated: this.s.gameSimulated, ...h, lossStreak: this.s.lossStreak, winStreak: this.s.winStreak, roundsPlayed: this.s.stats.rounds, brief: true },
      priority: 50, reason: `round ${h.outcome} (held)`, kind: 'round', maxAgeMs: 20_000,
    });
  }

  /** A spontaneous moment (story, question, callback…). Rationed; never repeats modes back-to-back. */
  spontaneous(reason: string) {
    const options = SPONT_MODES.filter((m) => !this.lastSpontModes.includes(m) && (m !== 'callback' || this.s.facts.length > 0));
    const mode = options[Math.floor(Math.random() * options.length)] ?? 'observation';
    this.lastSpontModes = [...this.lastSpontModes.slice(-2), mode];
    this.lastSpontAt = Date.now();
    this.say({ situation: { kind: 'spontaneous', mode }, priority: 20, reason: `spontaneous:${mode} (${reason})`, kind: 'filler', droppable: true, maxAgeMs: 20_000 });
  }

  /* ---------------- game events ---------------- */

  onGameEvent(ev: GameEvent) {
    if (ev.adapter !== 'control-panel') { this.s.game = ev.game; this.s.gameSimulated = ev.simulated; }
    switch (ev.kind) {
      case 'game_loaded':
        if (this.s.started) this.say({ situation: { kind: 'game_loaded', game: ev.game, simulated: ev.simulated }, priority: 40, reason: 'game loaded', kind: 'system', maxAgeMs: 30_000 });
        break;
      case 'round_started':
        this.roundRequestedAt = Date.now();
        break;
      case 'bonus_triggered':
        this.d.broadcast({ type: 'combo', combo: 'big_win' });
        this.d.broadcast({ type: 'fx', fx: 'sparkles' });
        this.addEvent('bonus feature triggered');
        this.say({ situation: { kind: 'bonus', game: ev.game, detail: ev.message }, priority: 85, interrupt: true, reason: 'bonus', kind: 'bonus' });
        break;
      case 'round_result':
      case 'big_win':
        if (ev.round) this.onRound(ev.round, ev.simulated);
        break;
      case 'game_error':
        this.d.log.warn(`game error: ${ev.message}`);
        break;
    }
    this.d.onState();
  }

  private onRound(r: RoundResult, simulated: boolean) {
    if (this.d.memory.hasRound(r.roundId)) return; // duplicate event (e.g. agent restart)
    this.d.memory.logRound({ id: r.roundId, game: r.game, outcome: r.outcome, multiplier: r.multiplier, payout: r.payout, stake: r.stake, simulated });
    this.lastRoundAt = Date.now();
    this.roundRequestedAt = 0;
    const st = this.s.stats;
    st.rounds++;
    if (r.outcome === 'win') { st.wins++; this.s.winStreak++; this.s.lossStreak = 0; }
    else if (r.outcome === 'loss') { st.losses++; this.s.lossStreak++; this.s.winStreak = 0; }
    if (r.balance !== undefined) st.balance = r.balance;
    const winMult = r.outcome === 'win' ? r.multiplier ?? (r.stake ? (r.payout ?? 0) / r.stake : 0) : 0;
    const prevBest = st.bestMultiplier;
    if (winMult > st.bestMultiplier) st.bestMultiplier = winMult;
    this.s.lastRound = { ...r, simulated };

    const tier: RoundInfo['tier'] = winMult >= 50 ? 'huge' : winMult >= 10 ? 'big' : winMult >= 3 ? 'medium' : winMult >= 1.5 ? 'small' : 'tiny';
    const target = num(r.details?.target);
    const rolled = num(r.details?.rolled);
    const nearMiss = r.outcome === 'loss' && target !== undefined && rolled !== undefined && rolled >= target * 0.9 && rolled < target;
    this.recentRounds = [...this.recentRounds.slice(-11), { id: r.roundId, outcome: r.outcome, multiplier: r.multiplier, rolled, target, at: Date.now() }];

    // memory: events + memorable facts for callbacks
    this.addEvent(`round ${st.rounds}: ${r.outcome}${r.outcome === 'win' && winMult ? ` — paid ${winMult}x` : ''}${target ? ` (target ${target}x; the result landed at ${rolled}x, which is NOT the payout)` : ''}`);
    if (winMult > prevBest && winMult >= 3) this.addFact(`we hit a ${Number(winMult.toFixed(2))}x win on round ${st.rounds}`);
    if (st.wins === 1 && r.outcome === 'win') this.addFact(`the first win of the night came on round ${st.rounds}`);
    if (this.s.lossStreak > this.s.worstLossStreak && this.s.lossStreak >= 4) { this.s.worstLossStreak = this.s.lossStreak; this.addFact(`we survived a ${this.s.lossStreak}-round losing streak`); }
    if (nearMiss) this.addFact(`a ${rolled}x landed agonisingly close to a ${target}x target`);
    if (st.rounds % 25 === 0) this.addFact(`we passed ${st.rounds} rounds together`);

    // an impressive RESULT number (e.g. 480x on a 2x target) is worth a reaction even when the payout is small
    const bigResult = rolled !== undefined && rolled >= 50;
    const interesting = tier === 'medium' || tier === 'big' || tier === 'huge' || nearMiss || bigResult || this.s.lossStreak >= 3;
    const big = tier === 'big' || tier === 'huge';

    // immediate body language (before the line is generated)
    const quick: Combo = big ? 'big_win' : bigResult ? 'surprise' : nearMiss ? 'surprise' : r.outcome === 'win' && tier === 'medium' ? 'lean_in' : r.outcome === 'win' ? 'nod' : r.outcome === 'unknown' ? 'thinking' : this.s.lossStreak >= 3 ? 'facepalm' : 'bad_result';
    this.d.broadcast({ type: 'combo', combo: quick });
    if (big) { this.d.broadcast({ type: 'fx', fx: 'confetti' }); this.d.broadcast({ type: 'fx', fx: 'zoom' }); }

    const info: RoundInfo = { outcome: r.outcome, multiplier: r.multiplier, target, rolled, tier, nearMiss, ...(bigResult ? { bigResult } : {}) };
    this.roundsSinceFull++;
    const brief = !interesting && this.roundsSinceFull < 3;
    if (!brief) this.roundsSinceFull = 0;

    // group two routine rounds into one line sometimes (still commentary for both)
    if (brief && !this.heldRound && Math.random() < 0.35) { this.heldRound = { ...info, id: r.roundId }; return; }
    const previous = this.heldRound && !interesting ? this.heldRound : undefined;
    if (this.heldRound && interesting) this.flushHeld(); // held routine round still gets its own short line first
    this.heldRound = null;

    const situation: Situation = {
      kind: 'round', game: r.game, simulated, ...info, payout: r.payout, stake: r.stake,
      lossStreak: this.s.lossStreak, winStreak: this.s.winStreak, roundsPlayed: st.rounds, brief, previous,
    };
    // quiet periods: routine rounds are only sometimes commented on (interesting ones always are)
    const speakP = { quiet: 0.3, balanced: 0.6, chatty: 1 }[this.personality.commentary];
    if (!interesting && Math.random() > speakP) { if (Date.now() - this.lastSpontAt > 70_000 && Math.random() < 0.1) this.spontaneous('quiet round'); return; }
    this.say({ situation, priority: big ? 90 : interesting ? 65 : 50, interrupt: big, reason: `round ${r.outcome} ${winMult || ''}`, kind: big ? 'big_win' : 'round', maxAgeMs: 20_000, droppable: !interesting });
    if (big && this.s.segment === 'gameplay') this.startSegment('celebration');
    else if (!interesting && Date.now() - this.lastSpontAt > 70_000 && Math.random() < 0.14) this.spontaneous('after round');
  }

  /* ---------------- chat ---------------- */

  onChat(m: ChatMessage) {
    const now = Date.now();
    const spam = this.spam.check(m.id, m.userId, m.text, now);
    if (spam) { this.d.log.info(`chat dropped (${spam}) from ${m.user}`); return; }
    const v = checkInbound(m.text);
    if (v.display) {
      this.chatLog = [...this.chatLog.slice(-11), { id: m.id, user: m.user, text: m.text.slice(0, 200), at: m.at }];
      this.d.onState();
    }
    if (!v.ok) {
      this.d.log.info(`chat filtered (${v.reason}) from ${m.user}`);
      if (v.injection && now - this.lastChatReplyAt > 20_000 && this.s.started) {
        this.lastChatReplyAt = now;
        this.say({ situation: { kind: 'injection_deflect', user: m.user }, priority: 30, reason: 'deflect', kind: 'chat' });
      }
      return;
    }
    this.lastChatAt = now;
    this.activeChatters.set(m.userId, { user: m.user, at: now });
    const { isNew, isReturning, viewer } = this.d.memory.touchViewer(m.userId, m.user, now);
    const note = extractViewerFact(m.text);
    if (note) this.d.memory.addViewerNote(m.userId, note);
    if (mentionsHat(m.text)) this.linesSinceHatMention = 0;
    this.recentChatForCtx.push({ user: m.user, text: m.text.slice(0, 160), at: Date.now() });
    if (this.recentChatForCtx.length > 20) this.recentChatForCtx.shift();
    this.addEvent(`${m.user} said in chat: "${m.text.slice(0, 60)}"`);
    if (this.s.started && now - this.lastListenCueAt > 9_000 && !this.d.speech.busy) { this.lastListenCueAt = now; this.d.broadcast({ type: 'avatar_cue', cue: 'listening' }); }
    const read = classifyChat(m.text, undefined, !!this.conv.lastFrom(m.userId));
    this.conv.add({ id: m.id, user: m.user, userId: m.userId, text: m.text.slice(0, 200), at: now, tone: read.tone, topics: read.topics });

    if (v.selfHarm) {
      this.say({ text: SUPPORT_LINE, expression: 'sad', tone: 'calm', priority: 95, interrupt: true, reason: 'support line', kind: 'system' });
      return;
    }
    const mentioned = /\bhubie\b|@hubie/i.test(m.text);
    // Talking to Hubie by name always gets an answer (also before the show starts) — this is what the Kick chat test relies on.
    if (!this.s.started && !(mentioned && m.source === 'kick')) return;
    const isQuestion = /\?\s*$/.test(m.text) || /^(what|why|how|who|where|when|do|does|are|is|can|will|should)\b/i.test(m.text);
    const chatSeg = this.s.segment === 'chat_time' || this.s.segment === 'viewer_questions' || this.s.segment === 'shoutouts';
    const greet = (isNew || isReturning) && !this.greetedThisSession.has(m.userId);
    const lastForUser = this.lastReplyByUser.get(m.userId) ?? 0;
    const globalGap = chatSeg ? 6_000 : 14_000;

    const direct = mentioned && m.source === 'kick' && now - lastForUser > 5_000;
    let p = 0.15;
    if (greet) p = 0.9;
    if (isQuestion) p = Math.max(p, chatSeg ? 0.9 : 0.6);
    if (mentioned) p = Math.max(p, 0.85);
    if (chatSeg) p = Math.min(1, p + 0.3);
    if (direct) p = 1;
    else {
      if (now - lastForUser < 60_000) p *= 0.15;
      if (now - this.lastChatReplyAt < globalGap) p *= 0.1;
      if (this.d.speech.length > 2) p *= 0.3;
    }
    p *= { low: 0.6, normal: 1, high: 1.5 }[this.personality.chatFrequency];
    if (this.conv.alreadyAnswered(m.id)) return; // never answer the same message twice
    if (Math.random() > Math.min(1, p)) return;

    this.lastChatReplyAt = now;
    this.lastReplyByUser.set(m.userId, now);
    if (greet) { this.greetedThisSession.add(m.userId); this.d.memory.markGreeted(m.userId, now); }
    this.d.broadcast({ type: 'combo', combo: 'chat_interaction' });
    const req: SpeechRequest = {
      situation: { kind: 'chat_reply', user: m.user, userId: m.userId, msgId: m.id, text: m.text.slice(0, 200), isNew, isReturning, isQuestion, notes: viewer.notes || undefined },
      priority: isQuestion || mentioned ? 55 : 35, reason: `chat reply to ${m.user}`, kind: 'chat', replyTo: { user: m.user, text: m.text.slice(0, 120) }, maxAgeMs: 25_000,
      onSpoken: (text) => { this.shoutedOut.add(m.user); this.conv.recordReply(m.id, text); },
    };
    if ((isQuestion || mentioned) && this.d.chatEnabled() && m.source === 'kick') {
      req.postToChat = (text) => this.d.sendChat(text.length > 300 ? text.slice(0, 297) + '…' : text);
    }
    this.say(req);
  }

  addHubieChatLine(text: string) {
    this.chatLog = [...this.chatLog.slice(-11), { id: `hubie-${Date.now()}`, user: 'Hubie', text, at: Date.now(), fromHubie: true }];
    this.d.onState();
  }

  say(req: SpeechRequest) {
    const userOnSpoken = req.onSpoken;
    req.onSpoken = (text, line) => {
      this.noteSpoken(text);
      for (const j of RUNNING_JOKES) if (j.re.test(text)) this.s.jokeUses[j.id] = (this.s.jokeUses[j.id] ?? 0) + 1;
      userOnSpoken?.(text, line);
    };
    this.d.speech.enqueue(req);
  }
}

/** Light long-term viewer memory: remember simple self-descriptions ("I'm from Brazil"). */
export function extractViewerFact(text: string): string | null {
  const t = text.trim();
  let m = t.match(/\b(?:i'?m|i am|greetings|hello|hi) from ([A-Za-z][A-Za-z .'-]{1,30})/i) ?? t.match(/\bwatching from ([A-Za-z][A-Za-z .'-]{1,30})/i);
  if (m) return `from ${m[1].replace(/[.!?]+$/, '').trim()}`;
  m = t.match(/\bmy fav(?:ou?rite)? ([a-z]{3,15}) is ([A-Za-z0-9 '-]{2,25})/i);
  if (m) return `favourite ${m[1]}: ${m[2].trim()}`;
  m = t.match(/\bi (?:love|like) ([A-Za-z][A-Za-z '-]{2,25})/i);
  if (m) return `likes ${m[1].trim()}`;
  return null;
}

function num(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
