/**
 * Hubie Control Center — every setting in one place, no source-code editing.
 *   1 AI · 2 Voice · 3 Limbo · 4 Kick chat · 5 Kick stream · 6 OBS · 7 Audio · 8 Avatar · 9 Health · 10 Checklist
 * Secrets are typed in here, sent once to this server, and never shown again (only "saved ✓").
 */
import React, { useEffect, useState } from 'react';
import { api, withToken } from '../api.ts';
import { audioOut, type OutStatus } from '../audioOut.ts';
import { useHubie } from '../useHubie.ts';
import { SecPersonality, SecVoiceAudio, SecAvatarLife, SecStreaming, SecMonitoring } from './ControlCenterPlus.tsx';
import { HubieSvg } from '../rig/HubieSvg.tsx';
import { DEFAULT_APPEARANCE, type Appearance } from '../../../../packages/shared/src/protocol.ts';

type Cfg = Record<string, { value: string; secret: boolean; set: boolean }>;
type Status = { config: Cfg; voice: { voiceId: string; model: string; models: any[]; settings: { stability: number; similarity: number; style: number; speed: number; speakerBoost: boolean } }; started: boolean; demo: { llm: boolean; voice: boolean } };
type CheckStatus = 'Ready' | 'Connected' | 'Not configured' | 'Failed' | 'Testing';
type Check = { id: string; name: string; status: CheckStatus; detail: string; fix?: string; required: boolean };

const SECTIONS = [
  ['1', 'AI brain'], ['2', 'Voice'], ['3', 'Limbo game'], ['4', 'Kick chat'], ['5', 'Kick stream'],
  ['6', 'OBS'], ['7', 'Audio test'], ['8', 'Avatar & look'], ['9', 'System health'], ['10', 'Pre-stream checklist'], ['11', 'Cloud (Streamable)'],
  ['12', 'Personality'], ['13', 'Voice keys & music'], ['14', 'Avatar animation'], ['15', 'Streaming / ON AIR'], ['16', 'Monitoring'],
] as const;
type SectionId = (typeof SECTIONS)[number][0];

const STATUS_CLASS: Record<CheckStatus, string> = { Ready: 'st-work', Connected: 'st-conn', 'Not configured': 'st-need', Failed: 'st-fail', Testing: 'st-none' };
export function StatusChip({ s }: { s: CheckStatus }) { return <span className={`st ${STATUS_CLASS[s]}`}>{s}</span>; }

function Msg({ m }: { m: { ok: boolean; text: string } | null }) { return m ? <div className={`msg ${m.ok ? 'good' : 'bad'}`}>{m.text}</div> : null; }
function errText(r: any, fallback = 'Something went wrong.') { return r?.error?.message ?? r?.test?.error?.message ?? fallback; }

export function ControlCenter() {
  const [sec, setSec] = useState<SectionId>(() => (SECTIONS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : '1') as SectionId);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const hub = useHubie('control', false);
  const refresh = () => api<Status>('/api/setup/status').then(setStatus).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); }, []);
  useEffect(() => { location.hash = sec; }, [sec]);
  const insecureRemote = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  return (
    <div className="wiz cc">
      <aside className="wiz-side">
        <div className="wiz-hubie">{hub.params && <HubieSvg p={hub.params.p} t={hub.params.t} width={300} height={300} />}</div>
        <h1>HUBIE CONTROL CENTER</h1>
        <p className="cc-brain">{hub.state?.brain ?? '…'}<br /><small>{hub.state?.voiceLabel}</small></p>
        <ol className="wiz-steps">
          {SECTIONS.map(([id, name]) => <li key={id} className={id === sec ? 'on' : ''} onClick={() => setSec(id)}><span>{id}</span>{name}</li>)}
        </ol>
        <div className="cc-links">
          <a href={withToken('/overlay')} target="_blank" rel="noreferrer">Open overlay ↗</a>
          <a href={withToken('/control')} target="_blank" rel="noreferrer">Operator panel ↗</a>
        </div>
        <button className="danger big" onClick={() => api('/api/estop', { on: !hub.estop, reason: 'control center' })}>{hub.estop ? 'RESUME HUBIE' : '■ EMERGENCY STOP'}</button>
      </aside>
      <main className="wiz-main">
        {err && <div className="msg bad">{err}</div>}
        {insecureRemote && <div className="msg warn">You are using plain HTTP from another computer. Keys you type here travel unencrypted. Prefer the SSH-tunnel link from docs/VPS-DEPLOYMENT.md.</div>}
        {!status ? <p>Loading…</p> : (
          <>
            {sec === '1' && <SecAI status={status} refresh={refresh} />}
            {sec === '2' && <SecVoice status={status} refresh={refresh} />}
            {sec === '3' && <SecLimbo frame={hub.frame} />}
            {sec === '4' && <SecKickChat />}
            {sec === '5' && <SecKickStream />}
            {sec === '6' && <SecObs />}
            {sec === '7' && <SecAudio />}
            {sec === '8' && <SecAvatar title={hub.state?.showTitle ?? ''} ap={hub.state?.appearance} />}
            {sec === '9' && <SecHealth />}
            {sec === '10' && <SecChecklist started={!!hub.state?.showStarted} />}
            {sec === '11' && <SecCloud />}
            {sec === '12' && <SecPersonality />}
            {sec === '13' && <SecVoiceAudio />}
            {sec === '14' && <SecAvatarLife />}
            {sec === '15' && <SecStreaming />}
            {sec === '16' && <SecMonitoring />}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------- shared: secret field ---------------- */
function SecretField({ label, saved, placeholder, onSave, busy }: { label: string; saved?: { value: string; set: boolean }; placeholder: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState('');
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label>{label} {saved?.set && <span className="saved">saved ✓ {saved.value}</span>}</label>
      <div className="row">
        <input type={show ? 'text' : 'password'} value={v} placeholder={saved?.set ? 'paste a new key to replace it' : placeholder} autoComplete="off" spellCheck={false} onChange={(e) => setV(e.target.value)} />
        <button onClick={() => setShow(!show)} title="show/hide while typing">{show ? 'Hide' : 'Show'}</button>
        <button className="ok" disabled={!v.trim() || busy} onClick={() => { onSave(v.trim()); setV(''); setShow(false); }}>{busy ? 'Testing…' : 'Save & test'}</button>
      </div>
    </div>
  );
}

/* ---------------- A — AI ---------------- */
function SecAI({ status, refresh }: { status: Status; refresh: () => void }) {
  const c = status.config;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<{ anthropic: string[]; openai: string[] } | null>(null);
  const provider = c.LLM_PROVIDER?.value || 'auto';
  useEffect(() => { api('/api/setup/ai-models').then(setModels).catch(() => {}); }, [c.ANTHROPIC_API_KEY?.set]);
  const saveKey = async (kind: 'anthropic' | 'openai', key: string) => {
    setBusy(true); setMsg(null);
    const r = await api<any>(`/api/setup/${kind}-key`, { key }).catch((e) => ({ ok: false, error: { message: e.message } }));
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `Saved and tested ✓ — ${kind === 'anthropic' ? 'Claude' : 'OpenAI'} replied “${r.test?.reply ?? 'ok'}”.` } : { ok: false, text: r.saved ? `Saved, but the test failed: ${errText(r)}` : errText(r) });
    refresh();
  };
  const set = async (body: object) => { await api('/api/setup/ai', body); refresh(); };
  const test = async () => { setBusy(true); const r = await api<any>('/api/setup/test', { what: 'ai' }); setBusy(false); setMsg({ ok: r.ok, text: r.detail }); };
  return (
    <section>
      <h2>1 — AI brain</h2>
      <p>Hubie’s commentary and chat replies come from an AI model. <b>Anthropic (Claude)</b> is used when its key is set; <b>OpenAI</b> is an optional text-only backup. Claude thinks; <b>ElevenLabs</b> (section 2) speaks. OpenAI is never used for voice.</p>
      <SecretField label="Anthropic API key (console.anthropic.com → API Keys)" saved={c.ANTHROPIC_API_KEY} placeholder="sk-ant-…" busy={busy} onSave={(k) => saveKey('anthropic', k)} />
      <SecretField label="OpenAI API key — OPTIONAL backup brain (text only, not used for voice)" saved={c.OPENAI_API_KEY} placeholder="sk-…" busy={busy} onSave={(k) => saveKey('openai', k)} />
      <div className="grid2">
        <div className="field"><label>Provider</label>
          <select value={provider} onChange={(e) => set({ provider: e.target.value })}>
            <option value="auto">Automatic (Anthropic if set, else OpenAI)</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="openai">OpenAI</option>
            <option value="mock">Built-in demo lines (no AI)</option>
          </select></div>
        <div className="field"><label>If the main AI fails</label>
          <select value={c.LLM_FALLBACK?.value === 'false' ? 'no' : 'yes'} onChange={(e) => set({ fallback: e.target.value === 'yes' })}>
            <option value="yes">Use the other AI (if its key is saved)</option>
            <option value="no">Only built-in lines</option>
          </select></div>
        <div className="field"><label>Claude model</label>
          <select value={c.ANTHROPIC_MODEL?.value || 'claude-haiku-5-5'} onChange={(e) => set({ anthropicModel: e.target.value })}>
            {[...new Set([c.ANTHROPIC_MODEL?.value || 'claude-haiku-5-5', ...(models?.anthropic ?? [])])].map((m) => <option key={m}>{m}</option>)}
          </select><small>Haiku is fastest for live commentary.</small></div>
        <div className="field"><label>OpenAI model</label>
          <select value={c.OPENAI_MODEL?.value || 'gpt-5.4-mini'} onChange={(e) => set({ openaiModel: e.target.value })}>
            {[...new Set([c.OPENAI_MODEL?.value || 'gpt-5.4-mini', ...(models?.openai ?? [])])].map((m) => <option key={m}>{m}</option>)}
          </select></div>
      </div>
      <button className="big" disabled={busy} onClick={test}>Test the AI (one real line)</button>
      <Msg m={msg} />
      <p className="small">Keys are stored only in this server’s <code>.env</code> file (owner-only permissions) and are never sent back to any browser.</p>
    </section>
  );
}

/* ---------------- B — Voice ---------------- */
const BROWSER_PREVIEW = "Hey chat, I'm Hubie. This is the browser's built-in voice, a fallback, not my real ElevenLabs voice.";

/** Live player status: what is playing, level meter, stop, volume. Shared by Voice and Audio test. */
export function PlayerPanel() {
  const [st, setSt] = useState<OutStatus>(audioOut.status);
  useEffect(() => audioOut.on(setSt), []);
  return (
    <div className={`player ${st.state}`}>
      <span className="pl-dot" />
      <span className="pl-state">{st.state === 'playing' ? `▶ Playing — ${st.label ?? ''}` : st.state === 'loading' ? `Loading audio… (${st.label ?? ''})` : st.state === 'error' ? 'Playback problem' : 'Ready'}</span>
      <span className="pl-meter"><i style={{ width: `${Math.round((st.state === 'playing' ? st.peak ?? 0 : 0) * 100)}%` }} /></span>
      <button onClick={() => audioOut.stop()} disabled={st.state !== 'playing' && st.state !== 'loading'}>■ Stop</button>
      <label className="pl-vol">🔊 <input type="range" min={0} max={1} step={0.05} value={st.volume} onChange={(e) => audioOut.setVolume(Number(e.target.value))} /> {Math.round(st.volume * 100)}%</label>
      {st.volume === 0 && <div className="msg warn">Volume is at 0 % — move the slider up.</div>}
      {st.state === 'error' && st.error && <div className="msg bad">{st.error}</div>}
    </div>
  );
}

function SecVoice({ status, refresh }: { status: Status; refresh: () => void }) {
  const c = status.config, v0 = status.voice;
  const [voiceId, setVoiceId] = useState(v0.voiceId);
  const [model, setModel] = useState(v0.model);
  const [st, setSt] = useState(v0.settings);
  const [list, setList] = useState<{ voices: any[]; recommended: string[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = !!c.ELEVENLABS_API_KEY?.set;
  const loadVoices = () => api<any>('/api/setup/voices').then((r) => { if (r.ok) setList(r); else setMsg({ ok: false, text: errText(r) }); }).catch(() => {});
  useEffect(() => { if (hasKey) loadVoices(); }, [hasKey]);
  const saveKey = async (key: string) => {
    setBusy('key'); setMsg(null);
    const r = await api<any>('/api/setup/elevenlabs-key', { key }).catch((e) => ({ ok: false, error: { message: e.message } }));
    setBusy('');
    setMsg(r.ok ? { ok: true, text: `Saved and tested ✓ — ElevenLabs answered; ${r.voices} voices available to your account. Now pick a voice and press Preview.` } : { ok: false, text: r.saved ? `Saved, but NOT verified: ${errText(r)}` : errText(r) });
    refresh();
  };
  const preview = async (id: string, tone = 'playful') => {
    audioOut.unlock(); // inside the click, before any await — required by Safari/Firefox
    setBusy('prev:' + id + tone); setMsg(null);
    try {
      const r = await api<any>('/api/setup/voice-preview', { voiceId: id, tone, model, ...st });
      if (!r.ok) { setMsg({ ok: false, text: errText(r) }); return; }
      const name = list?.voices.find((x) => x.voice_id === id)?.name ?? id;
      const p = await audioOut.playUrl(withToken(r.url), `ElevenLabs · ${name}`);
      if (audioOut.status.state !== 'idle' || p.durationMs === 0) return;
      setMsg({ ok: p.peak > 0.02, text: p.peak > 0.02 ? `Played real ElevenLabs speech (${name}, ${(p.durationMs / 1000).toFixed(1)} s, level ${p.peak.toFixed(2)}${r.cached ? ', from cache' : ''}). If you heard it, the voice works.` : 'The audio played but the level stayed at zero — check the volume slider and your computer volume.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(''); }
  };
  const previewBrowser = async () => { audioOut.unlock(); setMsg(null); try { await audioOut.speakBrowser(BROWSER_PREVIEW); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };
  const save = async () => {
    const name = list?.voices.find((x) => x.voice_id === voiceId)?.name ?? voiceId;
    const r = await api<any>('/api/setup/voice', { voiceId, model, ...st });
    setMsg(r.ok ? { ok: true, text: `Hubie will now speak with “${name}”.` } : { ok: false, text: errText(r) }); refresh();
  };
  const slider = (k: 'stability' | 'similarity' | 'style' | 'speed', label: string, lo: number, hi: number, hint: string) => (
    <div className="field"><label>{label}: {Number(st[k]).toFixed(2)} <small>{hint}</small></label>
      <input type="range" min={lo} max={hi} step={0.05} value={st[k]} onChange={(e) => setSt({ ...st, [k]: Number(e.target.value) })} /></div>);
  const rec = new Set(list?.recommended ?? []);
  return (
    <section>
      <h2>2 — Hubie’s voice (ElevenLabs)</h2>
      <p>Claude writes Hubie’s lines; <b>ElevenLabs</b> speaks them. Create a key at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">elevenlabs.io → Developers → API Keys</a> (enable <i>Text to Speech</i> and <i>Voices: read</i>). The key is stored only on the server.</p>
      <SecretField label="ElevenLabs API key" saved={c.ELEVENLABS_API_KEY} placeholder="sk_…" busy={busy === 'key'} onSave={saveKey} />
      {!hasKey && <div className="msg warn">No ElevenLabs key saved yet. Until then Hubie can only use the browser’s built-in voice, always labelled as a <b>fallback</b>.<div className="row"><button onClick={previewBrowser}>▶ Preview browser voice (fallback — not ElevenLabs)</button></div></div>}
      {hasKey && <>
        <h3>Choose Hubie’s voice</h3>
        <p className="small">Voices that fit a warm, energetic, cheeky host are listed first (★). Press ▶ to hear each one with the current settings.</p>
        <div className="voices">
          {(list?.voices ?? [{ voice_id: voiceId, name: 'Current voice' }]).slice(0, 24).map((v) => (
            <div key={v.voice_id} className={`vcard ${v.voice_id === voiceId ? 'sel' : ''}`}>
              <b>{rec.has(v.voice_id) ? '★ ' : ''}{v.name}</b>
              <small>{[v.labels?.accent, v.labels?.age, v.labels?.descriptive ?? v.labels?.description].filter(Boolean).join(' · ') || v.category || ''}</small>
              <span><button disabled={!!busy} onClick={() => preview(v.voice_id)}>{busy === 'prev:' + v.voice_id + 'playful' ? '…' : '▶'}</button> <button className={v.voice_id === voiceId ? 'ok' : ''} onClick={() => setVoiceId(v.voice_id)}>{v.voice_id === voiceId ? 'Selected' : 'Select'}</button></span>
            </div>))}
        </div>
        <div className="field"><label>Voice ID (advanced — paste any voice ID from your ElevenLabs library)</label><input value={voiceId} onChange={(e) => setVoiceId(e.target.value.trim())} /></div>
        <div className="field"><label>Model</label><select value={model} onChange={(e) => setModel(e.target.value)}>{v0.models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
        <div className="grid2">
          {slider('stability', 'Stability', 0, 1, 'lower = more expressive')}
          {slider('style', 'Style / drama', 0, 1, 'higher = more acting')}
          {slider('similarity', 'Clarity & similarity', 0, 1, '')}
          {slider('speed', 'Speed', 0.7, 1.2, '1.00 = normal')}
        </div>
        <div className="row">
          <button className="ok" disabled={!!busy} onClick={() => preview(voiceId)}>{busy.startsWith('prev:' + voiceId) ? 'Generating…' : '▶ Preview (normal)'}</button>
          <button disabled={!!busy} onClick={() => preview(voiceId, 'hyped')}>▶ Big win</button>
          <button disabled={!!busy} onClick={() => preview(voiceId, 'sarcastic')}>▶ Sarcastic loss</button>
          <button className="ok" onClick={save}>Use this voice</button>
        </div>
        <p className="small">Hubie automatically gets more excited on big wins and drier on losses (stability/style shift per line) without shouting constantly. The same settings are used for the live stream.</p>
      </>}
      <PlayerPanel />
      <Msg m={msg} />
      <p className="small">Can’t hear anything? Check the volume slider above, your computer’s volume and output device, and that this browser tab isn’t muted (right-click the tab). Section 7 runs a full audio test.</p>
    </section>
  );
}

/* ---------------- 7 — Audio test ---------------- */
function SecAudio() {
  const [as, setAs] = useState<any>(null);
  const [res, setRes] = useState<{ ok: boolean; text: string }[]>([]);
  const [busy, setBusy] = useState('');
  const load = () => api('/api/audio/status').then(setAs).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, []);
  const add = (ok: boolean, text: string) => setRes((r) => [{ ok, text }, ...r].slice(0, 6));
  const testHere = async () => {
    audioOut.unlock();
    setBusy('here');
    try {
      const r = await api<any>('/api/audio/test', {});
      if (r.url && r.ok) {
        const p = await audioOut.playUrl(withToken(r.url), `${r.provider === 'elevenlabs' ? 'ElevenLabs' : r.provider} · ${r.voice}`);
        add(p.peak > 0.02, p.peak > 0.02
          ? `✓ ${r.provider === 'elevenlabs' ? 'Real ElevenLabs speech' : `${r.provider} speech`}: ${r.bytes} bytes valid MP3, generated in ${r.ms} ms, played ${(p.durationMs / 1000).toFixed(1)} s at level ${p.peak.toFixed(2)}. If you heard it, browser audio works.`
          : '✗ The audio played but the level stayed at zero — check the volume slider.');
      } else {
        add(false, `✗ ${r.error ?? 'No audio returned.'}`);
        if (r.fallback && r.text) { await audioOut.speakBrowser(r.text).catch(() => {}); add(false, 'Played the browser’s built-in voice instead — this is a FALLBACK, not ElevenLabs.'); }
      }
    } catch (e) { add(false, `✗ ${(e as Error).message}`); } finally { setBusy(''); load(); }
  };
  const testOverlay = async () => {
    setBusy('overlay');
    try {
      const r = await api<any>('/api/audio/test-overlay', {});
      if (!r.ok) { add(false, `✗ ${errText(r)}`); return; }
      let rec: any = null;
      for (let i = 0; i < 40 && !rec; i++) { await new Promise((x) => setTimeout(x, 500)); const l = await api<any>('/api/speech/lipsync'); rec = l.recent.filter((x: any) => x.at >= r.since).at(-1); }
      if (!rec) add(false, '✗ The overlay did not report playing the test line within 20 s. Is Hubie stopped (emergency stop)?');
      else if (rec.mode === 'audio') add(true, `✓ Overlay played the line as real audio (${rec.provider ?? '?'}) and Hubie’s mouth followed the sound (peak ${rec.peak}, mouth open ${Math.round(rec.activeFrac * 100)} % of the time).`);
      else add(false, `✗ Overlay used "${rec.mode}" mode — no audio file was played. ${rec.mode === 'text' ? 'In a normal browser tab click the overlay once to allow sound; in OBS this is automatic.' : ''}`);
      const st = await api<any>('/api/audio/status');
      if (st.obsAudio?.connected) add(st.obsAudio.heardSecAgo >= 0 && st.obsAudio.heardSecAgo < 30, st.obsAudio.heardSecAgo >= 0 && st.obsAudio.heardSecAgo < 30 ? `✓ OBS heard Hubie's voice ${st.obsAudio.heardSecAgo}s ago (level ${st.obsAudio.peak}).` : '✗ OBS is connected but has not heard Hubie’s voice — press “Set up OBS scene” in section 6.');
    } finally { setBusy(''); load(); }
  };
  const row = (k: string, v: React.ReactNode) => <tr><td>{k}</td><td>{v}</td></tr>;
  return (
    <section>
      <h2>7 — Audio test</h2>
      <p>Run this before every stream. It uses exactly the same voice settings and playback as the live show.</p>
      <table className="tbl">
        <tbody>
          {row('Voice provider', as ? (as.provider === 'elevenlabs' && as.keySet ? <span className="good-t">ElevenLabs ({as.model})</span> : <span className="bad-t">Browser voice — fallback (no ElevenLabs key)</span>) : '…')}
          {row('Selected voice', as ? `${as.voice} at ${as.speed}×` : '…')}
          {row('API connection', as ? (as.lastError ? <span className="bad-t">{as.lastError}</span> : as.keySet ? 'no errors so far — press Test voice' : 'not configured') : '…')}
          {row('This browser’s audio output', <AudioCtxState />)}
          {row('Overlay pages open', as ? as.overlays : '…')}
          {row('OBS hears Hubie', as?.obsAudio ? (as.obsAudio.connected ? (as.obsAudio.heardSecAgo >= 0 ? `yes, ${as.obsAudio.heardSecAgo}s ago` : 'not yet') : 'OBS not connected') : 'OBS not set up')}
        </tbody>
      </table>
      <div className="row">
        <button className="ok" disabled={!!busy} onClick={testHere}>{busy === 'here' ? 'Generating…' : '▶ Test voice (in this browser)'}</button>
        <button disabled={!!busy} onClick={testOverlay}>{busy === 'overlay' ? 'Waiting for overlay…' : '▶ Test on stream overlay / OBS'}</button>
      </div>
      <PlayerPanel />
      <ul className="results">{res.map((r, i) => <li key={i} className={r.ok ? 'good-t' : 'bad-t'}>{r.text}</li>)}</ul>
    </section>
  );
}
function AudioCtxState() {
  const [st, setSt] = useState<OutStatus>(audioOut.status);
  useEffect(() => audioOut.on(setSt), []);
  if (st.context === 'none') return <span>not started yet (starts when you press a test button)</span>;
  return <span className={st.context === 'running' ? 'good-t' : 'bad-t'}>{st.context === 'running' ? `ready (${st.sampleRate} Hz)` : `${st.context} — click a test button to allow sound`}</span>;
}

/* ---------------- E — Streaming & OBS ---------------- */
function SecObs() {
  const [o, setO] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ url: '', password: '' });
  const load = () => api('/api/obs').then((x: any) => { setO(x); setF((p) => ({ ...p, url: p.url || x.url })); }).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, 2500); return () => clearInterval(i); }, []);
  const post = async (p: string, body: object = {}) => { const r = await api<any>(p, body); setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved ✓' } : { ok: false, text: errText(r) }); load(); return r; };
  const r = o?.readiness;
  return (
    <section>
      <h2>6 — OBS connection</h2>
      <p>OBS Studio (free) is the encoder that sends Hubie’s picture and voice to Kick. Hubie controls OBS through its built-in WebSocket remote control: it creates the scene, adds the overlay (game + Hubie + subtitles + chat, with Hubie’s voice), sets 1080p, puts in your Kick stream URL and key, and starts/stops the stream.</p>
      <p className="small">Credentials on this page: <b>OBS WebSocket password only</b>. (Kick chat login → section 4 · Kick stream key → section 5.)</p>
      <ol className="steps">
        <li>Install <a href="https://obsproject.com/download" target="_blank" rel="noreferrer">OBS Studio ↗</a> on the same computer/server as Hubie and open it. (The server installer does this for you.)</li>
        <li>In OBS: <b>Tools → WebSocket Server Settings</b> → tick <i>Enable WebSocket server</i> → <i>Show Connect Info</i> → copy the <b>Server Password</b>. <a href="https://obsproject.com/kb/remote-control-guide" target="_blank" rel="noreferrer">OBS guide ↗</a></li>
        <li><div className="row"><input placeholder="ws://127.0.0.1:4455" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /><input type="password" placeholder={o?.passwordSet ? 'password saved ✓' : 'OBS WebSocket password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <button className="ok" onClick={() => { post('/api/obs/settings', { enabled: true, url: f.url, ...(f.password ? { password: f.password } : {}) }); setF({ ...f, password: '' }); }}>Save & connect</button></div></li>
        <li><div className="row">
          <button onClick={() => post('/api/obs/check')}>Test OBS</button>
          <button onClick={() => post('/api/obs/setup')}>Set up the Hubie scene automatically</button>
          <button className="ok" onClick={() => post('/api/obs/configure-output')}>Apply 1080p60 settings</button>
          <button onClick={() => post('/api/obs/performance-test')} disabled={r?.perfTest?.running}>{r?.perfTest?.running ? 'Testing… (30 s)' : 'Run 30-second local performance test'}</button>
        </div></li>
      </ol>
      <Msg m={msg} />
      <div className="card">
        <b>OBS:</b> {o?.enabled ? (r?.connected ? <span className="good-t">connected (OBS {r.obsVersion})</span> : <span className="bad-t">{o?.health?.detail ?? 'not connected'} — Hubie reconnects automatically when OBS comes back</span>) : 'off'}
        {r?.connected && <ul className="ready">
          <li className={r.scene && r.source ? 'y' : 'n'}>Hubie scene with the overlay (game, avatar, subtitles, chat)</li>
          <li className={r.streamKeySet ? 'y' : 'n'}>Kick stream URL + key in OBS {r.service && `(${r.service})`} — set in section 5</li>
          <li className={r.videoOk ? 'y' : 'n'}>Video: {r.video || '?'} {r.videoOk ? '— 1920×1080 at 60 fps ✓' : '— Kick 1080p60 needs 1920×1080 at 60 fps'}</li>
          <li className={r.audioSeenSecAgo >= 0 ? 'y' : 'n'}>Hubie’s voice reaching OBS: {r.audioSeenSecAgo >= 0 ? `yes, ${r.audioSeenSecAgo}s ago` : 'not heard yet — run section 7 “Test on stream overlay / OBS”'}</li>
          <li>OBS output: {r.streaming ? <b>sending to Kick</b> : 'not streaming'}</li>
        </ul>}
        {r?.connected && r.checks?.length ? <details open={!r.settingsOk}><summary><b>1080p60 settings read back from OBS</b> — {r.settingsOk ? 'all match Kick’s requirements' : `${r.checks.filter((c: any) => !c.ok).length} need fixing`}</summary>
          <table className="kv"><tbody>{r.checks.map((c: any) => <tr key={c.name}><td>{c.ok ? '✓' : '✗'} {c.name}</td><td>{c.got}{c.ok ? '' : ` — Kick wants ${c.want}`}</td></tr>)}</tbody></table>
          <small>Applied by “Apply 1080p60 settings”. OBS reads encoder settings when the output next starts; stop the stream first.</small></details> : null}
        {r?.perfTest && <div className={`msg ${r.perfTest.running ? 'warn' : r.perfTest.ok ? 'good' : 'bad'}`}><b>Local performance test:</b> {r.perfTest.detail}</div>}
        {r?.quality && <div className="msg good"><b>Measured now:</b> {r.quality.fps.toFixed(1)} fps · {Math.round(r.quality.kbps)} kbps · CPU {r.quality.cpu.toFixed(0)}% · skipped {r.quality.renderSkippedPct.toFixed(2)}% render / {r.quality.encodeSkippedPct.toFixed(2)}% encoder{r.quality.problems.length ? <> — <b>{r.quality.problems.join('; ')}</b></> : null}</div>}
        {r?.connected && <div className={`msg ${r.liveVerifiedAt ? 'good' : 'warn'}`}>{r.liveVerifiedAt ? `1080p60 verified on a live stream (${new Date(r.liveVerifiedAt).toLocaleTimeString()}).` : '1080p60 is not verified on a live stream yet — it is checked automatically after one minute of real streaming.'}</div>}
        {o?.lastError && <div className="msg bad">{o.lastError.message}</div>}
      </div>
      <p className="small">Why OBS and not direct streaming? Capturing a browser’s sound and picture reliably for hours needs a real encoder; OBS is free, recovers from dropped connections and restarts, and lets you check everything before going live.</p>
    </section>
  );
}


/* ---------------- 11 — Cloud (Streamable) ---------------- */
function SecCloud() {
  const [c, setC] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [shown, setShown] = useState(false);
  const load = () => api('/api/cloud/status').then(setC).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, []);
  const post = async (p: string, body: object = {}) => { const r = await api<any>(p, body); setMsg(r.ok ? { ok: true, text: r.message ?? 'Done ✓' } : { ok: false, text: errText(r) }); load(); };
  const v = c?.verdict, t = v?.cloud;
  return (
    <section>
      <h2>11 — Run the stream in Streamable’s cloud</h2>
      <p>Your PC only opens this page. Hubie’s brain, game player and voice run on the Hubie server; <b>Streamable’s cloud OBS</b> renders the overlay (avatar, subtitles, game, Hubie’s voice) and its GPU encodes 1080p60 and sends it to Kick.</p>
      <div className="msg warn"><b>What Streamable does not offer (as far as its public pages show):</b> no documented API/OAuth, no OBS WebSocket endpoint, no scene/source API, no server-spec API. So Hubie cannot start or stop the cloud stream or add the Browser Source for you — you do those two things once in Streamable (steps below). Nothing here is claimed to work until it reports below.</div>
      <ol className="steps">
        <li>Turn on cloud mode: <button onClick={() => post('/api/cloud/mode', { cloud: true })}>{c?.mode === 'streamable-cloud' ? 'Cloud mode is ON ✓' : 'Turn on cloud mode'}</button> (keeps this computer’s OBS off).</li>
        <li>Copy this link. In Streamable <b>Remote OBS</b> → add a <b>Browser Source</b> → paste it → width <b>1920</b>, height <b>1080</b>, tick custom frame rate <b>60</b>.
          {c?.overlayUrl
            ? <div className="row"><input readOnly value={shown ? c.overlayUrl : c.overlayUrl.replace(/otoken=.*/, 'otoken=••••••••')} onFocus={(e) => e.currentTarget.select()} />
                <button onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button>
                <button onClick={() => navigator.clipboard?.writeText(c.overlayUrl).then(() => setMsg({ ok: true, text: 'Copied ✓' }))}>Copy</button>
                <button onClick={() => post('/api/cloud/rotate-overlay-token')}>New link</button></div>
            : <div className="msg bad">No public address yet. This needs Hubie on an internet server (docs/VPS-DEPLOYMENT.md) — the installer sets it up.</div>}
          <small>This link is view-only (it cannot control Hubie). If it leaks, press “New link”.</small></li>
        <li>In Streamable → Destinations: add Kick (Login with Kick). Press Start Stream in Streamable. Hubie’s Kick section then confirms whether Kick really shows you live.</li>
      </ol>
      <Msg m={msg} />
      <div className="card">
        <b>Measured inside cloud OBS:</b>{' '}
        {!v ? '…' : v.state === 'ok' ? <span className="good-t">{v.detail}</span> : v.state === 'problem' ? <span className="bad-t">{v.detail}</span> : <span>{v.detail}</span>}
        {t && <table className="kv"><tbody>
          <tr><td>Overlay frame rate</td><td>{t.fps} fps (p95 frame {t.p95Ms} ms, worst {t.worstMs} ms)</td></tr>
          <tr><td>Browser graphics</td><td>{t.gpu} {t.software ? '— SOFTWARE rendering' : '— GPU'}</td></tr>
          <tr><td>CPU threads / memory</td><td>{t.cores || '?'} / {t.memGB ? `≥ ${t.memGB} GB` : 'not reported'}</td></tr>
          <tr><td>Browser-source size</td><td>{t.w}×{t.h}</td></tr>
        </tbody></table>}
        {c?.kickLive && <p>Kick says the channel is <b>{c.kickLive.live ? `LIVE (${c.kickLive.viewers ?? 0} viewers)` : 'offline'}</b>.</p>}
        <p className="small"><b>Not measurable from Hubie:</b> {c?.unverified?.join(' · ')}. Open Remote OBS → <i>View → Stats</i> during a 5-minute test and check: dropped frames 0 %, skipped frames 0 %, CPU low, bitrate ≈ 6,000–8,000 kbps.</p>
      </div>
    </section>
  );
}

/* ---------------- 8 — Avatar & look ---------------- */
const TEST_EXPRESSIONS = ['happy', 'excited', 'surprised', 'sad', 'disappointed', 'confident', 'mischievous', 'suspicious', 'thinking', 'laughing', 'celebrating', 'sleepy', 'angry'];
const TEST_COMBOS = ['big_win', 'bad_result', 'celebration', 'facepalm', 'shrug', 'hat_tip', 'welcome_wave', 'surprise', 'thinking', 'clap', 'point_game', 'point_chat', 'laughing', 'mischief'];
function SecAvatar({ title, ap }: { title: string; ap?: Appearance }) {
  const [a, setA] = useState<Appearance>({ ...DEFAULT_APPEARANCE, ...(ap ?? {}) });
  const [t, setT] = useState(title);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (ap) setA({ ...DEFAULT_APPEARANCE, ...ap }); }, [JSON.stringify(ap)]);
  useEffect(() => { setT(title); }, [title]);
  const save = async () => { const r = await api<any>('/api/appearance', { ...a, title: t }); setMsg(r.ok ? { ok: true, text: 'Applied — the overlay updates live.' } : { ok: false, text: errText(r) }); };
  const ctl = (action: string, payload: object) => api('/api/control', { action, payload });
  const sel = <K extends keyof Appearance>(k: K, opts: Array<[string, string]>) => <select value={String(a[k])} onChange={(e) => setA({ ...a, [k]: e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value } as Appearance)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  return (
    <section>
      <h2>8 — Avatar, animation & look</h2>
      <h3>Test Hubie’s animations</h3>
      <p className="small">Plays on Hubie at the left and on every open overlay (and therefore in OBS).</p>
      <div className="chips">{TEST_COMBOS.map((c) => <button key={c} onClick={() => ctl('combo', { combo: c })}>{c.replace(/_/g, ' ')}</button>)}</div>
      <div className="chips">{TEST_EXPRESSIONS.map((e) => <button key={e} onClick={() => ctl('expression', { expression: e, holdMs: 3000 })}>{e}</button>)}</div>
      <h3>Look of the stream</h3>
      <div className="grid2">
        <div className="field"><label>Stream title (top of overlay)</label><input value={t} maxLength={60} onChange={(e) => setT(e.target.value)} /></div>
        <div className="field"><label>Hubie size</label>{sel('avatarSize', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])}</div>
        <div className="field"><label>Layout</label>{sel('layout', [['game-left', 'Game left, Hubie right'], ['game-right', 'Hubie left, game right']])}</div>
        <div className="field"><label>Animation intensity</label>{sel('intensity', [['calm', 'Calm'], ['normal', 'Normal'], ['lively', 'Lively']])}</div>
        <div className="field"><label>Chat panel</label>{sel('chatPanel', [['true', 'Show'], ['false', 'Hide']])}</div>
        <div className="field"><label>Subtitles</label>{sel('subtitles', [['true', 'Show'], ['false', 'Hide']])}</div>
      </div>
      <div className="field"><label>18+ notice (always shown)</label><input value={a.ageNotice} maxLength={160} onChange={(e) => setA({ ...a, ageNotice: e.target.value })} /></div>
      <div className="field"><label>Responsible-gambling notice (always shown)</label><input value={a.rgText} maxLength={160} onChange={(e) => setA({ ...a, rgText: e.target.value })} /></div>
      <button className="ok big" onClick={save}>Apply</button>
      <Msg m={msg} />
      <p className="small">The 18+ and responsible-gambling notices can be reworded but not removed. The stream also shows a short “Demo play · not real odds” line, because the game's win settings are not real casino odds.</p>
    </section>
  );
}

/* ---------------- 9 — System health ---------------- */
const COMP_NAMES: Record<string, string> = { controller: 'Hubie controller', 'game-agent': 'Game player', 'game-browser': 'Game display', ai: 'AI brain', tts: 'Voice', avatar: 'Overlay / avatar page', audio: 'Overlay audio', kick: 'Kick chat', obs: 'OBS' };
function healthWord(state: string): CheckStatus { return state === 'ok' ? 'Ready' : state === 'degraded' ? 'Connected' : state === 'down' ? 'Failed' : state === 'disabled' ? 'Not configured' : 'Testing'; }
function SecHealth() {
  const [h, setH] = useState<any>(null);
  useEffect(() => { const load = () => api('/api/health').then(setH).catch(() => {}); load(); const i = setInterval(load, 2000); return () => clearInterval(i); }, []);
  if (!h) return <p>Loading…</p>;
  return (
    <section>
      <h2>9 — System health</h2>
      <p>Live view, refreshed every 2 seconds. Each part restarts by itself if it crashes; “restarts” counts recoveries.</p>
      <table className="tbl checks"><tbody>
        {h.components.filter((c: any) => c.name !== 'kick' || c.state !== 'disabled').map((c: any) => <tr key={c.name}><td><b>{COMP_NAMES[c.name] ?? c.name}</b></td><td><StatusChip s={healthWord(c.state)} /></td><td>{c.detail ?? ''}{c.restarts ? <small> · restarts: {c.restarts}</small> : null}</td></tr>)}
      </tbody></table>
      <p className="small">Show: {h.started ? 'running' : 'not started'} · emergency stop: {h.estop ? 'ON' : 'off'} · rounds {h.stats?.rounds ?? 0} · memory {h.memory?.rssMB} MB · AI calls: {Object.entries(h.llm?.usage ?? {}).map(([k, v]: any) => `${k} ${v.calls} (${v.failures} errors, avg ${v.avgMs} ms)`).join(', ') || 'none yet'}</p>
    </section>
  );
}

/* ---------------- 10 — Pre-stream checklist ---------------- */
export function useChecks() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); const r = await api<{ checks: Check[] }>('/api/check-all', {}).catch(() => null); setBusy(false); if (r) setChecks(r.checks); };
  return { checks, busy, run };
}
function SecChecklist({ started }: { started: boolean }) {
  const { checks, busy, run } = useChecks();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [alsoStream, setAlsoStream] = useState(true);
  const blocking = (checks ?? []).filter((c) => c.required && c.status !== 'Ready' && c.status !== 'Connected');
  const obsOk = (checks ?? []).some((c) => c.id === 'obs' && (c.status === 'Ready' || c.status === 'Connected'));
  const start = async () => {
    if (alsoStream && obsOk) {
      if (!confirm('This starts the PUBLIC Kick stream. Viewers will see Hubie live. Go live now?')) return;
      const r = await api<any>('/api/obs/start', { confirm: 'GO LIVE' });
      if (!r.ok) { setMsg({ ok: false, text: errText(r) }); return; }
    }
    await api('/api/control', { action: 'start_show' });
    setMsg({ ok: true, text: alsoStream && obsOk ? 'Hubie is starting and OBS is starting the stream. “LIVE” is only shown once Kick confirms it.' : 'Hubie is starting (no stream started).' });
  };
  return (
    <section>
      <h2>10 — Pre-stream checklist</h2>
      <p>Runs real checks now: an AI line, real voice audio, the game, the overlay sound + lip-sync, Kick chat, the Kick channel status, OBS, security and safety. “Ready” is only shown when it was proven just now.</p>
      <button className="big ok" disabled={busy} onClick={run}>{busy ? 'Testing… (up to 40 s)' : 'CHECK EVERYTHING'}</button>
      {busy && <p><StatusChip s="Testing" /> running the checks…</p>}
      {checks && <table className="tbl checks"><tbody>
        {checks.map((c) => <tr key={c.id}><td><b>{c.name}</b>{!c.required && <small> (optional)</small>}</td><td><StatusChip s={c.status} /></td><td>{c.detail}{c.fix && <div className="fix">→ {c.fix}</div>}</td></tr>)}
      </tbody></table>}
      <p className="small"><StatusChip s="Ready" /> proven just now · <StatusChip s="Connected" /> reachable, not fully proven · <StatusChip s="Not configured" /> a setting is missing · <StatusChip s="Failed" /> tried and failed · <StatusChip s="Testing" /> running</p>
      {checks && blocking.length > 0 && <div className="msg warn">Not ready yet: {blocking.map((b) => b.name).join(', ')}. You can still start Hubie for a private rehearsal (without the stream).</div>}
      <label className="check"><input type="checkbox" checked={alsoStream && obsOk} onChange={(e) => setAlsoStream(e.target.checked)} disabled={!obsOk} /> Also start the Kick stream in OBS {obsOk ? '' : '(run the checks; OBS must be ready)'}</label>
      {started
        ? <button className="danger big" onClick={async () => { await api('/api/control', { action: 'stop_show' }); if (alsoStream) await api('/api/obs/stop', {}); setMsg({ ok: true, text: 'Stopped.' }); }}>STOP HUBIE{alsoStream ? ' & stream' : ''}</button>
        : <button className="ok big golive" onClick={start}>▶ START HUBIE</button>}
      <Msg m={msg} />
    </section>
  );
}

/* placeholders replaced below */

/* ---------------- 3 — Simulated Limbo ---------------- */
type Tier = { id: string; label: string; weight: number; win: boolean; targets: number[] };
function SecLimbo({ frame }: { frame: string | null }) {
  const [g, setG] = useState<any>(null);
  const [set, setSet] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api('/api/game').then((x: any) => setG(x.status)).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, 2500); api('/api/limbo/settings').then((x: any) => setSet(x.settings)); return () => clearInterval(i); }, []);
  const save = async (body: object) => {
    const r = await api<any>('/api/limbo/settings', body);
    if (r.ok) { setSet(r.settings); setMsg({ ok: true, text: 'Saved — the game uses the new settings from the next round.' }); } else setMsg({ ok: false, text: errText(r) });
  };
  const L = g?.limbo;
  const tiers: Tier[] = set?.outcomes ?? [];
  const total = tiers.reduce((a, t) => a + (t.weight > 0 ? t.weight : 0), 0) || 1;
  const winShare = tiers.filter((t) => t.win).reduce((a, t) => a + Math.max(0, t.weight), 0) / total;
  const setTier = (i: number, patch: Partial<Tier>) => setSet({ ...set, outcomes: tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  return (
    <section>
      <h2>3 — Limbo game</h2>
      <div className="srcbar real">LIMBO · DEMO PLAY · {g?.source === 'limbo-sim' ? `round ${L?.roundNumber ?? 0} · ${Number(L?.balance ?? 0).toFixed(2)} demo credits` : g?.source === 'local-sim' ? 'developer test game running' : 'game not running'}{g?.paused ? ' · paused' : ''}</div>
      <p>Hubie plays his own Limbo game. Results come from a random generator on this computer — <b>no Housebets connection, no account, no real money</b>. The win-heavy settings below make the show fun; they are <b>not</b> Housebets’ odds, RTP or payout rules, so the stream carries a small “Demo play · not real odds” note.</p>
      {g?.error && <div className="msg bad">{g.error}</div>}
      <div className="limbo-wrap">
        {frame ? <img className="limbo-frame" src={frame} alt="live game" /> : <div className="limbo-frame empty">Game picture appears here when the game is running</div>}
        <div className="limbo-hist">
          <b>Recent results</b>
          {(L?.history ?? []).slice().reverse().map((r: any) => <div key={r.roundId} className={`lh ${r.outcome}`}><span>#{r.roundNumber}</span><span>{r.resultMultiplier.toFixed(2)}x</span><span>target {r.targetMultiplier}x</span><span>{r.outcome === 'win' ? `paid ${r.payoutMultiplier}x` : '0x'}</span></div>)}
          {!L?.history?.length && <small>No rounds yet — rounds start when the show starts (section 10).</small>}
        </div>
      </div>
      <div className="row">
        <button onClick={() => api('/api/control', { action: g?.paused ? 'game_resume' : 'game_pause' })}>{g?.paused ? '▶ Resume game' : '⏸ Pause game'}</button>
        <button onClick={() => api('/api/control', { action: 'restart_game_browser' })}>Restart game</button>
        <a className="btnlink" href={withToken('/limbo-sim/index.html')} target="_blank" rel="noreferrer">Open the game to try it yourself ↗</a>
      </div>
      {set && <>
        <h3>Settings</h3>
        <div className="grid2">
          <div className="field"><label>Delay between rounds (seconds)</label><input type="number" min={2} max={120} value={set.roundDelaySec} onChange={(e) => setSet({ ...set, roundDelaySec: Number(e.target.value) })} /></div>
          <div className="field"><label>Bet per round (virtual demo credits)</label><input type="number" min={1} value={set.betAmount} onChange={(e) => setSet({ ...set, betAmount: Number(e.target.value) })} /></div>
          <div className="field"><label>Target multiplier</label>
            <select value={set.targetMode} onChange={(e) => setSet({ ...set, targetMode: e.target.value })}><option value="auto">Hubie varies it (per outcome tier)</option><option value="fixed">Always the same target</option></select></div>
          <div className="field"><label>Fixed target (if "always the same")</label><input type="number" min={1.01} step={0.01} value={set.fixedTarget} onChange={(e) => setSet({ ...set, fixedTarget: Number(e.target.value) })} disabled={set.targetMode !== 'fixed'} /></div>
        </div>
        <h3>Outcome mix <small>(relative weights — simulated win share {Math.round(winShare * 100)} %)</small></h3>
        <table className="tbl"><thead><tr><th>Outcome</th><th>Weight</th><th>Share</th><th>Targets Hubie picks (x)</th></tr></thead><tbody>
          {tiers.map((t, i) => <tr key={t.id}><td>{t.label}{t.win ? '' : ' (loss)'}</td>
            <td><input type="number" min={0} value={t.weight} onChange={(e) => setTier(i, { weight: Number(e.target.value) })} style={{ width: 80 }} /></td>
            <td>{Math.round((Math.max(0, t.weight) / total) * 1000) / 10} %</td>
            <td><input value={t.targets.join(', ')} onChange={(e) => setTier(i, { targets: e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0) })} /></td></tr>)}
        </tbody></table>
        <div className="row"><button className="ok" onClick={() => save({ settings: set })}>Save settings</button><button onClick={() => save({ reset: true })}>Reset to defaults</button></div>
        <Msg m={msg} />
        <p className="small">How a round works: an outcome is drawn by these weights, then a result multiplier is generated (≥ target for a win, below it for a loss), then compared with the target. A win pays bet × target; a loss returns 0. Results are never changed after they are generated, and the commentary is checked against them. The weights are stored in <code>data/limbo-settings.json</code> (defaults: <code>config/limbo-sim.json</code>).</p>
      </>}
    </section>
  );
}

/* ---------------- 4 — Kick chat ---------------- */
function useKick() {
  const [k, setK] = useState<any>(null);
  const load = () => api('/api/kick').then(setK).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, 2500); return () => clearInterval(i); }, []);
  return { k, load };
}
function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <span className="copy"><code>{text}</code><button onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? 'Copied ✓' : 'Copy'}</button></span>;
}
const STEP_ICON: Record<string, string> = { done: '✓', todo: '○', working: '…', error: '!' };
function SecKickChat() {
  const { k, load } = useKick();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ channel: '', clientId: '', clientSecret: '' });
  const [busy, setBusy] = useState('');
  useEffect(() => { if (k) setF((p) => ({ ...p, channel: p.channel || k.channel })); }, [k?.channel]);
  const post = async (p: string, body: object = {}, label = '') => { setBusy(label || p); const r = await api<any>(p, body); setBusy(''); setMsg(r.ok ? { ok: true, text: r.message ?? 'Done ✓' } : { ok: false, text: errText(r) }); load(); return r; };
  const connect = async (slot: 'broadcaster' | 'bot') => { const w = window.open('', '_blank'); const r = await api<any>('/api/kick/connect', { slot }); if (r.ok && w) w.location.href = r.url; else { w?.close(); setMsg({ ok: false, text: errText(r) }); } };
  const w = k?.wizard; const acc = k?.accounts ?? {}; const pn = w?.panel;
  const step = (id: string) => w?.steps?.find((x: any) => x.id === id);
  const t = (at?: number) => (at ? new Date(at).toLocaleTimeString() : '—');
  return (
    <section>
      <h2>4 — Connect Kick Chat</h2>
      <p>Hubie reads your Kick chat and replies to viewers by name. It uses Kick’s official developer API: you sign in on kick.com (Hubie never sees your password) and Kick sends chat messages to Hubie as signed events. No terminal commands — every step below is a button.</p>
      <div className="card">
        <b>Kick chat: </b>{w?.connected ? <StatusChip s="Ready" /> : <StatusChip s={k?.enabled ? 'Testing' : 'Not configured'} />}{' '}
        <b>{w?.connected ? 'Connected — tested both ways' : 'Not connected until the test passes'}</b>
        <div className="small" style={{ marginTop: 6 }}>{w?.next}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ok" disabled={!!busy} onClick={() => post('/api/kick/test', {}, 'test')}>{busy === 'test' ? 'Sending…' : 'Test Kick Chat'}</button>
          <button disabled={!acc.broadcaster && !acc.bot} onClick={() => connect(acc.broadcaster || !acc.bot ? 'broadcaster' : 'bot')}>Reconnect</button>
          <button onClick={() => post('/api/kick/resubscribe', {}, 'subs')}>Re-check subscription</button>
        </div>
      </div>
      <Msg m={msg} />
      <ol className="wizard">
        {(w?.steps ?? []).map((s: any, n: number) => (
          <li key={s.id} className={`wz ${s.state}`}>
            <div className="wzh"><span className="wzi">{STEP_ICON[s.state]}</span><b>{n + 1}. {s.title}</b></div>
            <div className="small">{s.detail}{s.fix && s.state !== 'done' ? <> <b>→ {s.fix}</b></> : null}</div>
            {s.id === 'app' && s.state !== 'done' && (
              <div className="wzb">
                <small>Create an app at <a href="https://kick.com/settings/developer" target="_blank" rel="noreferrer">kick.com/settings/developer ↗</a> (two-factor login must be on). Name “Hubie”. <b>Redirect URL</b> — paste exactly: <Copy text={k?.redirectUri ?? ''} /> Tick every permission it offers, save, then copy the Client ID and Client Secret here.</small>
                <div className="row"><input placeholder="your channel name (kick.com/…)" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} />
                  <input placeholder={k?.clientIdSet ? 'Client ID saved ✓' : 'Client ID'} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
                  <input type="password" placeholder={k?.clientSecretSet ? 'Client Secret saved ✓ (hidden)' : 'Client Secret'} value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></div>
                <button className="ok" onClick={async () => { await post('/api/kick/settings', { channel: f.channel, ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), enabled: true, ...(k?.webhookUrl ? {} : { tunnel: true }) }, 'save'); setF({ ...f, clientId: '', clientSecret: '' }); }}>Save and turn Kick on</button>
              </div>)}
            {s.id === 'account' && s.state !== 'done' && step('app')?.state === 'done' && (
              <div className="wzb"><small>Log in to kick.com <b>as the channel owner</b> first, then:</small> <button className="ok" onClick={() => connect('broadcaster')}>Connect Kick account</button> <small>Kick opens in a new tab; when you approve, Hubie finishes automatically.</small></div>)}
            {s.id === 'account' && s.state === 'done' && <div className="wzb"><small>Optional separate chat account for Hubie (e.g. “HubieBot”): log in to kick.com as that account, then <button onClick={() => connect('bot')}>Connect chat account</button>{acc.bot ? <span className="saved"> {acc.bot.username} ✓</span> : null}</small></div>}
            {s.id === 'tunnel' && (
              <div className="wzb">
                {k?.tunnelStatus?.state === 'running' || k?.tunnel === 'cloudflared'
                  ? <button onClick={() => post('/api/kick/tunnel/stop', {}, 'tstop')}>Stop public address</button>
                  : <button className="ok" disabled={!!busy} onClick={() => post('/api/kick/tunnel/start', {}, 'tstart')}>{busy === 'tstart' ? 'Starting…' : 'Start public address'}</button>}
                {k?.tunnelStatus?.state === 'running' && <button onClick={() => post('/api/kick/tunnel/check', {}, 'tcheck')}>Check again</button>}
                <br /><small>Uses Cloudflare’s free quick tunnel (installed automatically, no account). Its address changes whenever it restarts — Hubie tells you when to paste the new one.</small>
              </div>)}
            {s.id === 'webhook' && pn?.webhook && (
              <div className="wzb">
                <b>The one address to paste:</b> <Copy text={pn.webhook} />
                <ol className="small"><li>Open <a href="https://kick.com/settings/developer" target="_blank" rel="noreferrer">kick.com/settings/developer ↗</a> → your Hubie app.</li><li>Turn <b>Enable Webhooks</b> on and paste the address above into <b>Webhook URL</b>.</li><li>Save, then press <b>Test Kick Chat</b> above.</li></ol>
                {pn.tunnelChanged && <div className="msg warn">The address changed since Kick last used it — paste the new one.</div>}
              </div>)}
          </li>))}
      </ol>
      <h3>Status</h3>
      <div className="card">
        <table className="kv"><tbody>
          <tr><td>Account</td><td>{pn?.account ? `${pn.account} → #${pn.channel}` : 'not connected'}</td></tr>
          <tr><td>OAuth / permissions</td><td>{pn?.oauth}</td></tr>
          <tr><td>Receiving chat</td><td>{pn?.receiving}</td></tr>
          <tr><td>Sending chat</td><td>{pn?.sending}</td></tr>
          <tr><td>Webhook address</td><td>{pn?.webhook ? <code>{pn.webhook}</code> : '—'} <small>({pn?.webhookState})</small></td></tr>
          <tr><td>Last received</td><td>{pn?.lastReceived ? `${pn.lastReceived.user}: “${pn.lastReceived.text}” at ${t(pn.lastReceived.at)}` : 'nothing yet'}</td></tr>
          <tr><td>Last sent</td><td>{pn?.lastSent ? `${pn.lastSent.ok ? '✓' : '✗'} “${pn.lastSent.text}” at ${t(pn.lastSent.at)}${pn.lastSent.error ? ` — ${pn.lastSent.error}` : ''}` : 'nothing yet'}</td></tr>
        </tbody></table>
        {(pn?.errors ?? []).map((e: string, n: number) => <div key={n} className="msg bad">{e}</div>)}
      </div>
      <details><summary>More</summary>
        <label className="check"><input type="checkbox" checked={!!k?.autoModerate} onChange={(e) => post('/api/kick/settings', { autoModerate: e.target.checked })} /> Moderation: remove messages with links or abuse from Kick chat (Hubie always ignores them either way).</label>
        <p className="small">Already have a fixed https address (a server)? <input placeholder="https://…/kick/webhook" defaultValue={k?.webhookUrl} onBlur={(e) => e.target.value !== (k?.webhookUrl ?? '') && post('/api/kick/settings', { webhookUrl: e.target.value, tunnel: false })} /> — then the quick tunnel is switched off.</p>
        {(acc.broadcaster || acc.bot) && <div className="row">{acc.broadcaster && <button className="danger" onClick={() => post('/api/kick/disconnect', { slot: 'broadcaster' })}>Disconnect channel account</button>}{acc.bot && <button className="danger" onClick={() => post('/api/kick/disconnect', { slot: 'bot' })}>Disconnect chat account</button>}</div>}
        <p className="small">Opening Hubie from another computer? The Kick login returns to <code>localhost</code>, so use the SSH-tunnel link (docs/VPS-DEPLOYMENT.md).</p>
      </details>
    </section>
  );
}

/* ---------------- 5 — Kick stream ---------------- */
function SecKickStream() {
  const { k, load } = useKick();
  const [o, setO] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ server: '', key: '', title: '', cat: '', catId: 0 });
  const [cats, setCats] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => { const l = () => api('/api/obs').then(setO).catch(() => {}); l(); const i = setInterval(l, 3000); return () => clearInterval(i); }, []);
  useEffect(() => { if (k?.live?.title && !f.title) setF((p) => ({ ...p, title: k.live.title })); }, [k?.live?.title]);
  const post = async (p: string, body: object = {}) => { const r = await api<any>(p, body); setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved ✓' } : { ok: false, text: errText(r) }); load(); return r; };
  const search = async (q: string) => { setF((p) => ({ ...p, cat: q })); if (q.length < 2) return setCats([]); const r = await api<any>(`/api/kick/categories?q=${encodeURIComponent(q)}`); setCats(r.ok ? r.categories : []); };
  const live = k?.live;
  return (
    <section>
      <h2>5 — Kick stream</h2>
      <div className="card">
        <b>Kick says:</b> {!k?.enabled ? 'Kick not connected (section 4)' : !live ? 'checking…' : live.error ? <span className="bad-t">{live.error}</span> : live.live ? <span className="good-t">LIVE · {live.viewers ?? 0} viewers</span> : 'offline'}
        {live?.title && <> · “{live.title}”</>}{live?.category && <> · {live.category}</>}
        {live?.checkedAt ? <small> · checked {new Date(live.checkedAt).toLocaleTimeString()}</small> : null} <button onClick={() => post('/api/kick/refresh-status')}>Refresh status</button>
        <br /><small>The overlay only shows “LIVE” when Kick reports the channel is live.</small>
      </div>
      <h3>Stream URL & key (for OBS)</h3>
      <p className="small">Credentials here: <b>Kick stream key</b> only. It is stored on this server, pushed into OBS, and never shown again. Never show it on stream.</p>
      <ol className="steps">
        <li>On Kick: <a href="https://dashboard.kick.com/channel/stream" target="_blank" rel="noreferrer">Creator Dashboard → Settings → Stream URL & Key ↗</a>. Copy the <b>Stream URL</b> (starts with <code>rtmps://</code>) and the <b>Stream Key</b>.</li>
        <li><div className="row"><input placeholder={o?.streamServer ? o.streamServer : 'rtmps://…'} value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} /><input type="password" placeholder={o?.streamKeySaved ? 'stream key saved ✓ (hidden)' : 'Stream Key'} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
          <button className="ok" disabled={!f.server && !f.key} onClick={() => { post('/api/obs/settings', { ...(f.server ? { streamServer: f.server } : {}), ...(f.key ? { streamKey: f.key } : {}) }); setF({ ...f, key: '' }); }}>Save</button></div></li>
        <li>OBS readiness (section 6): {o?.readiness?.streamKeySet ? <span className="good-t">stream URL + key are in OBS ✓</span> : 'not in OBS yet — connect OBS in section 6'}</li>
      </ol>
      <h3>Title & category</h3>
      {!k?.accounts?.broadcaster ? <p className="small">Connect your channel account in section 4 to change these from here.</p> : <>
        <div className="field"><label>Stream title</label><input value={f.title} maxLength={140} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="field"><label>Category</label><input value={f.cat} placeholder="type to search, e.g. Slots & Casino" onChange={(e) => search(e.target.value)} />
          {cats.length > 0 && <div className="chips">{cats.map((c) => <button key={c.id} className={f.catId === c.id ? 'ok' : ''} onClick={() => setF({ ...f, catId: c.id, cat: c.name })}>{c.name}</button>)}</div>}</div>
        <button className="ok" onClick={() => post('/api/kick/channel', { title: f.title, categoryId: f.catId || undefined })}>Update on Kick</button>
      </>}
      <Msg m={msg} />
      <h3>Start / stop</h3>
      <p className="small">Starting the public stream always asks for confirmation — use <b>section 10 → START HUBIE</b> (with “Also start the Kick stream”) or the buttons below. Kick has no private test mode, so your first test is a real (short) stream.</p>
      <div className="row">
        <button onClick={async () => { if (!confirm('Start the PUBLIC Kick stream now?')) return; await post('/api/obs/start', { confirm: 'GO LIVE' }); }}>▶ Start Kick stream (public)</button>
        <button className="danger" onClick={() => post('/api/obs/stop')}>■ Stop stream</button>
      </div>
    </section>
  );
}
