/** Operator control panel: test triggers, local test chat, expressions, e-stop, health. */
import React, { useEffect, useState } from 'react';
import { COMBOS, EXPRESSIONS, type ControlAction } from '../../../../packages/shared/src/protocol.ts';
import { api, withToken } from '../api.ts';
import { useHubie } from '../useHubie.ts';
import { HubieSvg } from '../rig/HubieSvg.tsx';

export function Control() {
  // Control page plays no audio by default (the overlay does); ?audio=1 to hear it here.
  const { rt, state, params, connected, utterance, frame, audioBlocked } = useHubie('control', false);
  const [sayText, setSayText] = useState('');
  const [chatUser, setChatUser] = useState('local_tester');
  const [chatText, setChatText] = useState('Hi Hubie! How are you?');
  const [health, setHealth] = useState<any>(null);

  const control = (action: ControlAction, payload?: Record<string, unknown>) => rt.hub.send({ type: 'control', action, payload });

  useEffect(() => {
    const load = () => api('/api/health').then(setHealth).catch(() => setHealth(null));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="control">
      <header>
        <img src="/assets-hubie/hubie-reference.png" width={44} height={44} alt="" />
        <h1>Hubie Control</h1>
        <span className={`pill ${connected ? 'ok' : 'down'}`}>{connected ? 'hub connected' : 'hub offline'}</span>
        {state?.emergencyStop && <span className="pill down">EMERGENCY STOP</span>}
        <a href={withToken('/setup')}>setup wizard</a>
        <a href={withToken('/overlay')} target="_blank" rel="noreferrer">open overlay ↗</a>
      </header>

      <div className="grid">
        <section className="card preview">
          <h2>Preview</h2>
          <div className="preview-row">
            <div className="avatar-box">{params && <HubieSvg p={params.p} t={params.t} width={260} height={260} showBg />}</div>
            <div className="game-box">{frame ? <img src={frame} alt="game" /> : <em>no game frames</em>}</div>
          </div>
          <p className="now">{utterance ? <>🗣 <b>{utterance.provider}</b>: {utterance.text}</> : <i>silent</i>}</p>
          <p className="muted">Segment: <b>{state?.segmentTitle}</b> · Game: <b>{state?.gameName}</b>{state?.gameSource === 'limbo-sim' ? ' (demo play)' : state?.gameSimulated ? ' — LOCAL TEST GAME' : ''} · Rounds {state?.stats.rounds ?? 0}</p>
          {audioBlocked && <p className="muted">Audio blocked — click the page.</p>}
        </section>

        <section className="card">
          <h2>Safety</h2>
          {state?.emergencyStop
            ? <button className="big ok" onClick={() => control('resume')}>Resume show</button>
            : <button className="big danger" onClick={() => control('emergency_stop', { reason: 'operator' })}>EMERGENCY STOP</button>}
          <p className="muted">Stops speech, pauses the game and chat output. Also: <code>npm run estop</code> or create <code>data/ESTOP</code>.</p>
          <h2>Show {state && <small>{state.showStarted ? '(running)' : '(not started)'}</small>}</h2>
          <div className="row">
            {state?.showStarted ? <button onClick={() => control('stop_show')}>Stop show (pre-show screen)</button> : <button className="ok" onClick={() => control('start_show')}>▶ Start show</button>}
            <button onClick={() => control('next_segment')}>Next segment</button>
            <button onClick={() => control('restart_game_browser')}>Restart game browser</button>
          </div>
          <h2>OBS</h2>
          <div className="row">
            <button onClick={() => control('obs_setup')}>Create/repair scene</button>
            <button onClick={() => { if (confirm('Start the PUBLIC Kick stream now?')) control('obs_start', { confirm: 'GO LIVE' }); }}>Start stream (public)</button>
            <button onClick={() => control('obs_stop')}>Stop stream</button>
          </div>
        </section>

        <section className="card">
          <h2>Trigger test game events <small>(flagged simulated)</small></h2>
          <div className="row">
            <button onClick={() => control('trigger_game_event', { outcome: 'loss' })}>Loss</button>
            <button onClick={() => control('trigger_game_event', { outcome: 'loss', nearMiss: true })}>Near miss</button>
            <button onClick={() => control('trigger_game_event', { outcome: 'win', multiplier: 1.8 })}>Win 1.8×</button>
            <button onClick={() => control('trigger_game_event', { outcome: 'win', multiplier: 5 })}>Win 5×</button>
            <button onClick={() => control('trigger_game_event', { outcome: 'win', multiplier: 64 })}>Big win 64×</button>
            <button onClick={() => control('trigger_game_event', { kind: 'bonus', outcome: 'win', multiplier: 0 })}>Bonus</button>
          </div>
          <h2>Expressions</h2>
          <div className="row wrap">
            {EXPRESSIONS.map((e) => <button key={e} onClick={() => control('expression', { expression: e, holdMs: 3000 })}>{e}</button>)}
          </div>
          <h2>Animation combos</h2>
          <div className="row wrap">
            {COMBOS.map((c) => <button key={c} onClick={() => control('combo', { combo: c })}>{c.replace('_', ' ')}</button>)}
          </div>
          <h2>Make Hubie say</h2>
          <div className="row">
            <input value={sayText} onChange={(e) => setSayText(e.target.value)} placeholder="Text (safety-filtered)" />
            <button onClick={() => { if (sayText.trim()) control('say', { text: sayText }); setSayText(''); }}>Say</button>
          </div>
        </section>

        <section className="card">
          <h2>Local test chat {state && !state.testChatEnabled && <small>(disabled)</small>}</h2>
          <p className="muted">Clearly-labelled test messages for development. Set <code>ALLOW_TEST_CHAT=false</code> for broadcasts.</p>
          <div className="row">
            <input style={{ maxWidth: 140 }} value={chatUser} onChange={(e) => setChatUser(e.target.value)} />
            <input value={chatText} onChange={(e) => setChatText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && control('test_chat', { user: chatUser, text: chatText })} />
            <button onClick={() => control('test_chat', { user: chatUser, text: chatText })}>Send</button>
          </div>
          <div className="chatlog">{(state?.chat ?? []).slice(-8).map((c) => <div key={c.id}><b>{c.user}</b>: {c.text}</div>)}</div>
        </section>

        <section className="card">
          <h2>Health</h2>
          <table>
            <tbody>
              {(state?.health ?? []).map((h) => (
                <tr key={h.name}><td>{h.name}</td><td><span className={`pill ${h.state}`}>{h.state}</span></td><td className="muted">{h.detail}</td></tr>
              ))}
            </tbody>
          </table>
          {health && <p className="muted">LLM: {health.llm.demo ? 'demo' : health.llm.provider} (last: {health.llm.last}) · voice: {health.voice.chain.join('→')} · spoken {health.speech.spoken} · regenerated {health.speech.regenerated} · dropped {health.speech.dropped} · blocked {health.speech.blocked} · interrupts {health.speech.interrupted} · cached audio {health.speech.cachedAudio}{health.llm.lastError ? ` · last AI error: ${health.llm.lastError}` : ''}</p>}
        </section>
      </div>
    </div>
  );
}
