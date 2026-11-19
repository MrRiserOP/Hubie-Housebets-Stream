/** Animated stream graphics for the 1080p overlay. All CSS-driven (cheap for OBS). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionStyle, OverlayState, Utterance } from '../../../../packages/shared/src/protocol.ts';

/* ---------------- reaction caption ---------------- */
export function ReactionCaption({ text, style, k }: { text: string; style: CaptionStyle; k: string | number }) {
  const words = text.split(' ');
  return (
    <div className={`rcap rcap-${style}`} key={k}>
      {style === 'type'
        ? text.split('').map((ch, i) => <span key={i} style={{ animationDelay: `${i * 0.035}s` }}>{ch === ' ' ? ' ' : ch}</span>)
        : words.map((w, i) => <span key={i} style={{ animationDelay: `${i * 0.09}s` }}>{w}&nbsp;</span>)}
    </div>
  );
}

/* ---------------- subtitles (word-by-word, synced to audio progress) ---------------- */
export function Subtitles({ u, progress }: { u: Utterance | null; progress: { t: number; d: number } | null }) {
  const words = useMemo(() => (u ? u.text.split(/\s+/) : []), [u]);
  if (!u) return <div className="subs idle"><span className="subs-tag">HUBIE</span><span className="subs-idle">…</span></div>;
  // weight words by length so long words take longer, like speech
  const weights = words.map((w) => 0.6 + w.replace(/[^a-z0-9]/gi, '').length * 0.18 + (/[.,!?…]$/.test(w) ? 0.8 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const frac = progress && progress.d > 0 ? Math.min(1, progress.t / progress.d) : 0;
  let acc = 0, current = -1;
  for (let i = 0; i < words.length; i++) { acc += weights[i] / total; if (frac < acc) { current = i; break; } }
  if (current < 0) current = progress ? words.length - 1 : 0;
  return (
    <div className={`subs emo-${u.emotion ?? u.tone}`}>
      <span className="subs-tag">HUBIE</span>
      <span className="subs-text">
        {words.map((w, i) => <span key={i} className={i < current ? 'w said' : i === current ? 'w now' : 'w'}>{w} </span>)}
      </span>
    </div>
  );
}

/* ---------------- viewer callout (lower third) ---------------- */
function hue(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
export function ViewerCallout({ reply, k }: { reply: { user: string; text: string }; k: string }) {
  return (
    <div className="callout" key={k}>
      <div className="callout-avatar" style={{ background: `hsl(${hue(reply.user)} 65% 45%)` }}>{reply.user.slice(0, 1).toUpperCase()}</div>
      <div className="callout-body">
        <div className="callout-name">@{reply.user}</div>
        <div className="callout-msg">“{reply.text}”</div>
      </div>
      <div className="callout-tag">HUBIE IS REPLYING</div>
    </div>
  );
}

/* ---------------- chat panel ---------------- */
export function ChatPanel({ chat, connected }: { chat: OverlayState['chat']; connected?: boolean; chatOff?: boolean }) {
  return (
    <section className="chat2">
      <div className="chat2-head"><span className={`dot ${connected ? 'on' : ''}`} /> KICK CHAT</div>
      <div className="chat2-list">
        {chat.length === 0 && <div className="chat2-empty">Say hi to Hubie in chat 👋</div>}
        {chat.slice(-6).map((c) => (
          <div key={c.id} className={`chat2-line ${c.fromHubie ? 'hubie' : ''}`}>
            <span className="chat2-av" style={{ background: c.fromHubie ? 'var(--gold)' : `hsl(${hue(c.user)} 60% 42%)` }}>{c.user.slice(0, 1).toUpperCase()}</span>
            <div><b>{c.user}</b><p>{c.text}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- recent events rail ---------------- */
export function EventRail({ rounds }: { rounds: NonNullable<OverlayState['recentRounds']> }) {
  return (
    <div className="rail">
      <span className="rail-title">RECENT</span>
      {rounds.slice(-10).map((r) => {
        const big = (r.multiplier ?? 0) >= 10;
        const label = r.outcome === 'win' ? `${fmt(r.multiplier)}` : r.rolled ? `${fmt(r.rolled)}` : '—';
        return <span key={r.id} className={`chip ${r.outcome} ${big ? 'big' : ''}`} title={r.target ? `target ${r.target}×` : ''}>{r.outcome === 'win' ? '▲' : '▼'} {label}</span>;
      })}
    </div>
  );
}
/* ---------- ON AIR: only ever says live when live is confirmed; the total is the server's persisted, honest count ---------- */
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
export function OnAirBadge({ onAir, started }: { onAir?: OverlayState['onAir']; started?: boolean }) {
  const h = onAir?.history;
  const showHistory = !h || h.enabled; // default: always visible
  const text = h?.text ?? '150+ HOURS ON AIR';
  // status is honest and separate: LIVE only while confirmed live
  const status = !started ? 'STARTING SOON' : onAir?.live ? 'LIVE' : 'OFFLINE';
  return (
    <span className="onair-wrap">
      {showHistory && <span className="onair history" title="Hubie's established broadcasting history across earlier streams"><i className="oa-dot" /><b className="oa-word">{text}</b></span>}
      <span className={`livechip ${started && onAir?.live ? 'on' : ''}`} title="LIVE only while the stream is confirmed live">{status}</span>
    </span>
  );
}

/** ♪ chip with animated equaliser while music plays */
export function NowPlaying({ title, state }: { title?: string; state?: string }) {
  if (!title || (state !== 'playing' && state !== 'crossfading')) return null;
  return <span className="badge nowplaying" key={title}><span className="eq"><i /><i /><i /><i /></span>{title}</span>;
}

/** Notable moments (wins ≥ 3x, near misses) as a short, animated feed */
export function Highlights({ rounds }: { rounds: NonNullable<OverlayState['recentRounds']> }) {
  const items = rounds.filter((r) => (r.outcome === 'win' && (r.multiplier ?? 0) >= 3) || (r.outcome === 'loss' && r.target && r.rolled && r.rolled >= r.target * 0.9)).slice(-2).reverse();
  if (!items.length) return null;
  return (
    <div className="hl">
      <span className="hl-title">HIGHLIGHTS</span>
      {items.map((r) => <span key={r.id} className={`hl-item ${r.outcome}`}>{r.outcome === 'win' ? `▲ ${fmt(r.multiplier)} WIN` : `◆ NEAR MISS ${fmt(r.rolled)} / ${fmt(r.target)}`}</span>)}
    </div>
  );
}
export const fmt = (n?: number) => (n === undefined ? '' : `${n >= 100 ? Math.round(n) : Number(n.toFixed(2))}×`);

/* ---------------- event announcement (inside the game panel top) ---------------- */
export function Announcement({ a }: { a: { k: number; title: string; sub?: string; kind: 'big' | 'bonus' | 'near' | 'win' | 'streak' } }) {
  return (
    <div className={`announce announce-${a.kind}`} key={a.k}>
      <div className="announce-title">{a.title}</div>
      {a.sub && <div className="announce-sub">{a.sub}</div>}
    </div>
  );
}

/* ---------------- segment title card ---------------- */
const NO_CARD = new Set(['celebration', 'bonus_hype', 'gameplay']);
export function SegmentCard({ title, seq, segment }: { title: string; seq: number; segment?: string }) {
  const [show, setShow] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (segment && NO_CARD.has(segment)) return; // big moments have their own banners; keep it calm
    setShow(true);
    const t = setTimeout(() => setShow(false), 2200);
    return () => clearTimeout(t);
  }, [seq]);
  if (!show) return null;
  return (
    <div className="segcard" key={seq}>
      <div className="segcard-band" />
      <div className="segcard-text"><small>NOW</small>{title}</div>
    </div>
  );
}

/* ---------------- intro sequence ---------------- */
export function Intro({ k, title, sub }: { k: number; title?: string; sub?: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(true); const t = setTimeout(() => setOn(false), 3800); return () => clearTimeout(t); }, [k]);
  if (!on) return null;
  return (
    <div className="intro" key={k}>
      <div className="intro-curtain l" /><div className="intro-curtain r" />
      <div className="intro-logo"><img src="/assets-hubie/hubie-reference.png" alt="" /></div>
      <div className="intro-title">{title ?? "HUBIE'S HOUSE PARTY"}</div>
      <div className="intro-sub">{sub ?? 'LIVE'}</div>
    </div>
  );
}

/* ---------------- ticker ---------------- */
export function Ticker({ state }: { state: OverlayState | null }) {
  const items = useMemo(() => {
    const s = state?.stats;
    return [
      state?.appearance?.ageNotice || '18+ ONLY · Demo games with play money · No real-money wagering on this stream',
      state?.appearance?.rgText || 'Gambling can be addictive. Set limits, take breaks, and never play with money you can’t afford to lose.',
      state?.gameSource === 'limbo-sim' ? 'Demo play with virtual credits, for entertainment — results are not real odds or real-money outcomes' : '',
      s ? `Tonight so far: ${s.rounds} rounds · ${s.wins} wins · best ${s.bestMultiplier ? fmt(s.bestMultiplier) : '—'}` : '',
      'Sloth fact: sloths can hold their breath for up to 40 minutes',
      'Hubie is an AI character. Outcomes are random — nobody can predict or promise wins.',
      'Need support with gambling? Talk to someone you trust or a local support service.',
    ].filter(Boolean);
  }, [state?.stats?.rounds, state?.stats?.wins, state?.stats?.bestMultiplier, state?.appearance?.ageNotice, state?.appearance?.rgText, state?.gameSource]);
  const line = items.join('   ✦   ');
  return (
    <footer className="ticker">
      <span className="age">18+</span>
      <div className="ticker-track"><div className="ticker-move"><span>{line}</span><span>{line}</span></div></div>
      <span className="ticker-demo">{state?.gameSource === 'limbo-sim' ? 'DEMO · NO REAL MONEY' : 'DEMO · PLAY MONEY'}</span>
    </footer>
  );
}

/* ---------------- sparkles burst ---------------- */
export function Sparkles({ k }: { k: number }) {
  const bits = useMemo(() => Array.from({ length: 22 }, (_, i) => ({ a: (i / 22) * Math.PI * 2 + Math.random() * 0.3, d: 120 + Math.random() * 180, s: 10 + Math.random() * 16, delay: Math.random() * 0.25 })), [k]);
  return (
    <div className="sparkles" key={k}>
      {bits.map((b, i) => (
        <i key={i} style={{ ['--dx' as any]: `${Math.cos(b.a) * b.d}px`, ['--dy' as any]: `${Math.sin(b.a) * b.d}px`, width: b.s, height: b.s, animationDelay: `${b.delay}s` }} />
      ))}
    </div>
  );
}

export function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return <span className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

export function Countdown({ until }: { until?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  if (!until) return null;
  const s = Math.max(0, Math.round((until - now) / 1000));
  return <span>{s}s</span>;
}
