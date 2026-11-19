/** Full 1920×1080 stream overlay — the single OBS browser source. */
import React, { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, type CaptionStyle } from '../../../../packages/shared/src/protocol.ts';
import { useHubie } from '../useHubie.ts';
import { HubieSvg } from '../rig/HubieSvg.tsx';
import { useStageScale, Leaves, Confetti } from '../components/fx.tsx';
import { Announcement, ChatPanel, Clock, Countdown, EventRail, Highlights, NowPlaying, OnAirBadge, Intro, ReactionCaption, SegmentCard, Sparkles, Subtitles, Ticker, ViewerCallout, fmt } from '../components/graphics.tsx';

/** Measures how well THIS browser renders the overlay and reports it (so a cloud-OBS browser source can be checked from the Control Center). */
function useTelemetry(rt: { hub: { send: (m: any) => void } }) {
  useEffect(() => {
    let raf = 0, last = performance.now(); const dts: number[] = []; let frames = 0, sent = performance.now();
    const loop = (now: number) => {
      const dt = now - last; last = now; frames++; if (dt < 1000) dts.push(dt); if (dts.length > 600) dts.shift();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let gpu = 'unknown', software = false;
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      gpu = (gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'no WebGL').slice(0, 120);
      software = /swiftshader|llvmpipe|software|softpipe|basic render/i.test(gpu) || gpu === 'no WebGL';
    } catch { gpu = 'no WebGL'; software = true; }
    const q = new URLSearchParams(location.search);
    const tick = setInterval(() => {
      const now = performance.now(); const secs = (now - sent) / 1000; sent = now;
      const sorted = [...dts].sort((a, b) => a - b);
      const fps = secs > 0 ? frames / secs : 0; frames = 0;
      rt.hub.send({ type: 'overlay_telemetry', t: {
        fps: Math.round(fps * 10) / 10, p95Ms: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10, worstMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10, frames: sorted.length,
        gpu, software, cores: navigator.hardwareConcurrency ?? 0, memGB: (navigator as any).deviceMemory ?? 0, w: window.innerWidth, h: window.innerHeight,
        ua: navigator.userAgent.slice(0, 160), audioCtx: (window as any).__hubie?.player ? 'player' : 'none', cloud: q.get('cloud') === '1' } });
    }, 5000);
    return () => { cancelAnimationFrame(raf); clearInterval(tick); };
  }, [rt]);
}

type Ann = { k: number; title: string; sub?: string; kind: 'big' | 'bonus' | 'near' | 'win' | 'streak' };

export function Overlay() {
  const { rt, state, frame, connected, lastEvent, utterance, audioBlocked, params, estop, fx, progress } = useHubie('overlay', true);
  const scale = useStageScale(1920, 1080);
  useTelemetry(rt);
  const [music, setMusic] = useState<{ track?: string; state?: string }>({});
  useEffect(() => { const t = setInterval(() => { const m = rt.music?.status; setMusic((c) => (c.track === m?.track && c.state === m?.state ? c : { track: m?.track, state: m?.state })); }, 1500); return () => clearInterval(t); }, [rt]);
  const [ann, setAnn] = useState<Ann | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string; kind: 'win' | 'loss' } | null>(null);
  const [confetti, setConfetti] = useState(0);
  const [sparkles, setSparkles] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [shake, setShake] = useState(0);
  const [intro, setIntro] = useState<{ k: number; text?: string; sub?: string } | null>(null);
  const [cap, setCap] = useState<{ k: string; text: string; style: CaptionStyle } | null>(null);
  const [callout, setCallout] = useState<{ k: string; user: string; text: string } | null>(null);

  // game events → announcements, toasts, particles
  useEffect(() => {
    if (!lastEvent) return;
    const r = lastEvent.round;
    const k = Date.now();
    if (lastEvent.kind === 'bonus_triggered') { setAnn({ k, title: 'BONUS ROUND!', sub: 'Something special is happening', kind: 'bonus' }); setSparkles(k); }
    else if (r && (lastEvent.kind === 'round_result' || lastEvent.kind === 'big_win')) {
      const m = r.multiplier ?? 0;
      const rolled = Number((r.details as any)?.rolled), target = Number((r.details as any)?.target);
      if (r.outcome === 'win' && m >= 10) { setAnn({ k, title: `BIG WIN ${fmt(m)}`, sub: 'Demo play money — still counts in our hearts', kind: 'big' }); setConfetti(k); setZoom(k); }
      else if (r.outcome === 'win' && m >= 3) { setAnn({ k, title: `NICE! ${fmt(m)}`, kind: 'win' }); setSparkles(k); }
      else if (r.outcome === 'loss' && rolled && target && rolled >= target * 0.9) { setAnn({ k, title: 'SO CLOSE!', sub: `${fmt(rolled)} on a ${fmt(target)} target`, kind: 'near' }); setShake(k); }
      setToast({ key: k, text: r.outcome === 'win' ? `WIN ${fmt(m)}` : r.outcome === 'push' ? 'PUSH' : `${rolled ? fmt(rolled) : 'NO WIN'}`, kind: r.outcome === 'win' ? 'win' : 'loss' });
    }
  }, [lastEvent]);
  useEffect(() => { if (!ann) return; const t = setTimeout(() => setAnn(null), 3000); return () => clearTimeout(t); }, [ann]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }, [toast]);

  // server fx + combo fx
  useEffect(() => {
    if (!fx) return;
    if (fx.fx === 'confetti') setConfetti(fx.id + Date.now());
    if (fx.fx === 'sparkles') setSparkles(fx.id + Date.now());
    if (fx.fx === 'zoom') setZoom(fx.id + Date.now());
    if (fx.fx === 'shake') setShake(fx.id + Date.now());
    if (fx.fx === 'intro') setIntro({ k: Date.now(), text: fx.text, sub: fx.sub });
  }, [fx]);
  useEffect(() => { if (!zoom) return; const t = setTimeout(() => setZoom(0), 2600); return () => clearTimeout(t); }, [zoom]);
  useEffect(() => { if (!shake) return; const t = setTimeout(() => setShake(0), 600); return () => clearTimeout(t); }, [shake]);

  // speech → reaction caption + viewer callout
  useEffect(() => {
    if (!utterance) return;
    if (utterance.caption) setCap({ k: utterance.id, text: utterance.caption, style: utterance.captionStyle ?? 'slam' });
    if (utterance.replyTo) setCallout({ k: utterance.id, ...utterance.replyTo });
  }, [utterance?.id]);
  useEffect(() => { if (!cap) return; const t = setTimeout(() => setCap(null), 2800); return () => clearTimeout(t); }, [cap]);
  useEffect(() => { if (!callout) return; const t = setTimeout(() => setCallout(null), 5200); return () => clearTimeout(t); }, [callout]);

  const ap = { ...DEFAULT_APPEARANCE, ...(state?.appearance ?? {}) };
  const stats = state?.stats;
  const preShow = state && !state.showStarted;
  const onBreak = state?.segment === 'break';

  return (
    <div className="stage-wrap" onClick={() => rt.player.unlock()}>
      <div className="stage" style={{ transform: `scale(${scale})` }}>
        <div className={`camera ${shake && ap.intensity !== 'calm' ? 'cam-shake' : ''} ap-size-${ap.avatarSize} ap-${ap.layout} ap-int-${ap.intensity} ${ap.chatPanel ? '' : 'ap-nochat'}`}>
          <div className="bg" />
          <div className="aurora"><i /><i /><i /></div>
          <Leaves />

          <header className="topbar2">
            <div className="brand2">
              <img src="/assets-hubie/hubie-reference.png" alt="" />
              <div>
                <div className="brand2-title">{state?.showTitle ?? "Hubie's House Party"}</div>
                <div className="brand2-sub"><OnAirBadge onAir={state?.onAir} started={state?.showStarted} /><Clock /></div>
              </div>
            </div>
            <div className="seg2" key={state?.segmentSeq}><span>NOW</span>{state?.segmentTitle ?? '…'}</div>
            <div className="stats2">
              <div><span>ROUNDS</span><b>{stats?.rounds ?? 0}</b></div>
              <div><span>WINS</span><b>{stats?.wins ?? 0}</b></div>
              <div><span>BEST</span><b>{stats?.bestMultiplier ? fmt(stats.bestMultiplier) : '—'}</b></div>
            </div>
          </header>

          <section className="game2">
            <div className="game2-frame">
              {frame ? <img src={frame} alt="game" /> : <div className="game-wait">Waiting for the game…</div>}
              {(state?.gameSimulated || state?.gameSource === 'local-sim') && state?.gameSource !== 'limbo-sim' && <div className="sim-ribbon">LOCAL TEST GAME — SIMULATED</div>}
              {ann && <Announcement a={ann} />}
              {toast && <div key={toast.key} className={`toast2 toast2-${toast.kind}`}>{toast.text}</div>}
              {preShow && <div className="cover"><div className="cover-card"><b>STARTING SOON</b><span>Hubie is getting his hat ready…</span></div></div>}
              {onBreak && !preShow && <div className="cover brb"><div className="cover-card"><b>QUICK BREATHER</b><span>Stretch, hydrate, back in <Countdown until={state?.breakEndsAt} /></span></div></div>}
            </div>
            <div className="game2-meta">
              <span className="game-name">{state?.gameName ?? '—'}</span>
              <EventRail rounds={state?.recentRounds ?? []} />
              <Highlights rounds={state?.recentRounds ?? []} />
              {state?.gameSource === 'limbo-sim'
                ? <span className="demo-pill sim">DEMO PLAY · NOT REAL ODDS</span>
                : <span className="demo-pill">DEMO MODE · PLAY MONEY</span>}
            </div>
          </section>

          {ap.subtitles && <Subtitles u={utterance} progress={progress} />}

          <section className={`hubie2 ${zoom && ap.intensity !== 'calm' ? 'zoom' : ''}`}>
            <div className="spotlight" />
            {params && <HubieSvg p={params.p} t={params.t} width={600} height={600} />}
            {sparkles > 0 && <Sparkles k={sparkles} />}
          </section>
          {cap && <ReactionCaption text={cap.text} style={cap.style} k={cap.k} />}

          {ap.chatPanel && <ChatPanel chat={state?.chat ?? []} connected={state?.chatConnected} chatOff={state?.health.find((h) => h.name === 'kick')?.state === 'disabled'} />}
          {callout && <ViewerCallout reply={callout} k={callout.k} />}

          <div className="status2">
            {state?.demoMode && <span className="badge demo" title="Add an AI key in the control center">DEMO MODE</span>}
            {state?.brain && !state.demoMode && <span className="badge">🧠 {state.brain.replace(/ \(backup.*\)$/, '')}</span>}
            <span className="badge">🎙 {state?.voiceLabel ?? 'voice'}</span>
            <NowPlaying title={music.track} state={music.state} />
          </div>

          <Ticker state={state} />
          {ap.intensity !== 'calm' && <Confetti trigger={confetti} />}
          <SegmentCard title={state?.segmentTitle ?? ''} seq={state?.segmentSeq ?? 0} segment={state?.segment} />
          {intro && <Intro k={intro.k} title={intro.text} sub={intro.sub} />}
          {estop && <div className="estop"><div>Hubie is taking a short break.<small>We'll be right back.</small></div></div>}
          {!connected && <div className="conn">reconnecting…</div>}
          {audioBlocked && <div className="audio-hint">Click to enable Hubie's voice</div>}
        </div>
      </div>
    </div>
  );
}
