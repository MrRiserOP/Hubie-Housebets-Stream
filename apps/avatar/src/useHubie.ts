/** Wires the hub, speech player and animation director together for a page. */
import { useEffect, useRef, useState } from 'react';
import type { AvatarStateName, ClientRole, Emotion, GameEvent, HubMessage, OverlayState, Utterance } from '../../../packages/shared/src/protocol.ts';
import { BrowserHub } from './hub.ts';
import { SpeechPlayer } from './speechPlayer.ts';
import { MusicPlayer } from './music.ts';
import { Animator } from './rig/animator.ts';
import type { RigParams } from './rig/params.ts';

export interface HubieRuntime { hub: BrowserHub; player: SpeechPlayer; animator: Animator; music?: MusicPlayer }
export type FxEvent = { id: number; fx: Extract<HubMessage, { type: 'fx' }>['fx']; text?: string; sub?: string };

const INTENSITY: Record<Emotion, number> = {
  hyped: 1, excited: 0.9, surprised: 0.8, dramatic: 0.75, playful: 0.7, mischievous: 0.6, friendly: 0.55, sarcastic: 0.45,
  suspicious: 0.4, relaxed: 0.45, warm: 0.45, disappointed: 0.35, calm: 0.3, sleepy: 0.15,
};

let fxSeq = 0;

export function useHubie(role: ClientRole, audioDefault: boolean) {
  const rt = useRef<HubieRuntime | null>(null);
  const [state, setState] = useState<OverlayState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const [utterance, setUtterance] = useState<Utterance | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [params, setParams] = useState<{ p: RigParams; t: number } | null>(null);
  const [estop, setEstop] = useState(false);
  const [fx, setFx] = useState<FxEvent | null>(null);
  const [progress, setProgress] = useState<{ t: number; d: number } | null>(null);

  if (!rt.current) {
    const q = new URLSearchParams(location.search);
    const audio = q.has('audio') ? q.get('audio') !== '0' : audioDefault;
    const hub = new BrowserHub(role, audio);
    const player = new SpeechPlayer(audio);
    const animator = new Animator();
    // only the page that actually plays sound (the OBS browser source) gets the music player
    const music = role === 'overlay' && audio && player.ctx ? new MusicPlayer(player.ctx) : undefined;
    rt.current = { hub, player, animator, music };
    // debug/test hook (read-only use by tests/e2e)
    (window as any).__hubie = { hub, player, animator, music, maxMouth: 0, spoken: [] as string[], audioModes: [] as string[], combos: [] as string[], expressions: [] as string[], captions: [] as string[], mouthSamples: [] as number[] };
  }

  useEffect(() => {
    const { hub, player, animator } = rt.current!;
    const dbg = (window as any).__hubie;
    const emitFx = (f: Omit<FxEvent, 'id'>) => setFx({ ...f, id: ++fxSeq });
    animator.onFx = (f) => emitFx({ fx: f });
    const music = rt.current!.music;
    if (music) music.onStatus = (st) => hub.send({ type: 'music_status', s: st });
    player.onStart = (u) => {
      animator.speaking = true; music?.duck(true);
      if (u.combo) { animator.playCombo(u.combo); dbg.combos.push(u.combo); }
      hub.send({ type: 'speech_started', id: u.id });
    };
    player.onEnd = (u, err) => {
      animator.speaking = false; music?.duck(false);
      setUtterance((cur) => (cur?.id === u.id ? null : cur));
      const l = player.lip;
      hub.send({ type: 'speech_ended', id: u.id, error: err && err !== 'stopped' ? err : undefined,
        lip: { mode: l.mode, peak: Math.round(l.peak * 100) / 100, activeFrac: l.frames ? Math.round((l.openFrames / l.frames) * 100) / 100 : 0, provider: u.provider } });
    };
    let cuesOn = true;
    const off = hub.on((m) => {
      switch (m.type) {
        case 'overlay_state':
          setState(m.state); setEstop(m.state.emergencyStop);
          if (m.state.avatarSettings) { const a = m.state.avatarSettings; animator.styleScale = (a.intensity / 100) * (({ calm: 0.6, normal: 1, lively: 1.3 } as Record<string, number>)[m.state.appearance?.intensity ?? 'normal'] ?? 1); animator.idleLife = a.idleLife; animator.talkGestures = a.talkGestures; animator.reactions = a.reactions; cuesOn = a.cues; }
          if (m.state.audio) { player.setVoiceVolume(m.state.audio.settings.voiceVolume); music?.apply(m.state.audio.settings, m.state.audio.tracks, m.state.audio.autoMood); }
          animator.styleScale = ({ calm: 0.6, normal: 1, lively: 1.3 } as Record<string, number>)[m.state.appearance?.intensity ?? 'normal'] ?? 1;
          break;
        case 'game_frame': setFrame(`data:${m.mime};base64,${m.data}`); break;
        case 'say': {
          const u = m.utterance;
          setUtterance(u);
          dbg.spoken.push(u.text);
          if (u.caption) dbg.captions.push(u.caption);
          dbg.expressions.push(u.expression);
          animator.speechIntensity = INTENSITY[u.emotion ?? u.tone] ?? 0.5;
          animator.setExpression(u.expression === 'speaking' ? 'idle' : u.expression, Math.max(2500, u.durationMs + 800));
          animator.lookAt(u.replyTo ? 'chat' : 'camera', u.replyTo ? 1200 : 1500);
          void player.play(u);
          break;
        }
        case 'stop_speech': player.stop(); break;
        case 'expression': animator.setExpression(m.expression, m.holdMs ?? 3000); dbg.expressions.push(m.expression); break;
        case 'combo': if (animator.reactions || m.combo === 'chat_interaction') { animator.playCombo(m.combo); dbg.combos.push(m.combo); } break;
        case 'avatar_cue': if (cuesOn && !player.speaking) { animator.setCue(m.cue); dbg.combos.push(`cue:${m.cue}`); } break;
        case 'fx': emitFx({ fx: m.fx, text: m.text, sub: m.sub }); break;
        case 'game_event':
          setLastEvent(m.event);
          if (m.event.kind === 'round_started') animator.lookAt('game', 2200);
          break;
        case 'estop': setEstop(m.on); if (m.on) player.stop(); break;
      }
    });

    const isOverlay = role === 'overlay' || role === 'avatar';
    const beat = () => { if (isOverlay) hub.send({ type: 'heartbeat', role, component: 'avatar', state: 'ok' }); };
    hub.onStatus = (c) => { setConnected(c); if (c) beat(); }; // report immediately on (re)connect
    const hb = window.setInterval(() => {
      beat();
      if (player.audioEnabled && isOverlay) {
        const blocked = player.audioBlocked;
        setAudioBlocked(blocked);
        hub.send({ type: 'heartbeat', role, component: 'audio', state: blocked ? 'degraded' : 'ok', detail: blocked ? 'autoplay blocked — click the page / enable audio in OBS' : `audio ${player.ctx?.state ?? 'speechSynthesis'}` });
      }
    }, 4000);

    // animation loop (capped at 60 fps)
    let raf = 0, last = performance.now(), n = 0, lastState: AvatarStateName = 'idle', lastStateAt = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      animator.mouth = player.update(dt);
      animator.speaking = player.speaking;
      const p = animator.tick(dt);
      if (player.speaking) {
        dbg.maxMouth = Math.max(dbg.maxMouth, p.mouthOpen);
        if (dbg.audioModes[dbg.audioModes.length - 1] !== player.mode) dbg.audioModes.push(player.mode);
        if (n++ % 6 === 0) { dbg.mouthSamples.push(Math.round(p.mouthOpen * 100) / 100); if (dbg.mouthSamples.length > 600) dbg.mouthSamples.shift(); }
      }
      dbg.expression = animator.expression; dbg.state = animator.state;
      if (isOverlay && animator.state !== lastState && performance.now() - lastStateAt > 400) { lastState = animator.state; lastStateAt = performance.now(); hub.send({ type: 'avatar_state', state: lastState, at: Date.now() }); }
      dbg.activeCombos = animator.activeCombos;
      setParams({ p, t: animator.time });
      setProgress(player.progress());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { off(); cancelAnimationFrame(raf); window.clearInterval(hb); };
  }, [role]);

  return { rt: rt.current!, state, frame, connected, lastEvent, utterance, audioBlocked, params, estop, fx, progress };
}
