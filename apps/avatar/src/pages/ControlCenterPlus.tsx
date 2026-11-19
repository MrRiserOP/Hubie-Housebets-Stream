/**
 * Control Center sections 12–16 (entertainment upgrade):
 *   12 Personality · 13 Voice keys & music · 14 Avatar · 15 Streaming (ON AIR) · 16 Monitoring
 * Full API keys are typed here once, sent to the server, and never returned (only masked hints).
 */
import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { AVATAR_STATES } from '../../../../packages/shared/src/protocol.ts';

type Msg = { ok: boolean; text: string } | null;
const Note = ({ m }: { m: Msg }) => (m ? <div className={`msg ${m.ok ? 'good' : 'bad'}`}>{m.text}</div> : null);
const T = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'object' && (v as any).message ? String((v as any).message) : JSON.stringify(v));
const em = (r: any, d = 'Something went wrong.') => r?.error?.message ?? d;
const ago = (t?: number | null) => { if (!t) return 'never'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const dur = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`; };
function usePoll<T>(path: string, ms: number): [T | null, () => void] {
  const [d, setD] = useState<T | null>(null);
  const load = () => api<T>(path).then(setD).catch(() => {});
  useEffect(() => { load(); const i = setInterval(load, ms); return () => clearInterval(i); }, [path]);
  return [d, load];
}
function Slider({ label, value, min = 0, max = 100, step = 1, suffix = '', onCommit, help }: { label: string; value: number; min?: number; max?: number; step?: number; suffix?: string; onCommit: (v: number) => void; help?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="field"><label>{label}: <b>{v}{suffix}</b></label>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onMouseUp={() => onCommit(v)} onTouchEnd={() => onCommit(v)} onKeyUp={() => onCommit(v)} />
      {help && <small>{help}</small>}</div>
  );
}
function Toggle({ label, on, onChange, help }: { label: string; on: boolean; onChange: (v: boolean) => void; help?: string }) {
  return <label className="row" style={{ margin: '8px 0' }}><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> <span>{label}{help && <small> — {help}</small>}</span></label>;
}
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return <div className="field"><label>{label}</label><div className="chips">{options.map(([v, n]) => <button key={v} className={v === value ? 'ok' : ''} onClick={() => onChange(v)}>{n}</button>)}</div></div>;
}

/* ---------------- 12 — Personality ---------------- */
export function SecPersonality() {
  const [d, load] = usePoll<any>('/api/personality', 5000);
  const [msg, setMsg] = useState<Msg>(null);
  const save = async (b: object) => { const r = await api<any>('/api/personality', b); setMsg(r.ok ? { ok: true, text: 'Saved — applies to Hubie\'s very next line.' } : { ok: false, text: em(r) }); load(); };
  if (!d) return <section><h2>12 — Personality</h2><p>Loading…</p></section>;
  const s = d.settings;
  return (
    <section>
      <h2>12 — Personality</h2>
      <p className="small">How Hubie talks. Changes apply immediately; nothing here needs a restart.</p>
      <Slider label="Humour" value={s.humor} onCommit={(v) => save({ humor: v })} help="How often he goes for a joke. Not every line is a joke even at 100." />
      <Slider label="Sarcasm" value={s.sarcasm} onCommit={(v) => save({ sarcasm: v })} />
      <Slider label="Friendly roasting" value={s.roast} onCommit={(v) => save({ roast: v })} help="Playful teasing of viewers. Never cruel, never about protected traits." />
      <Choice label="Gameplay commentary" value={s.commentary} options={[['quiet', 'Quiet (natural silences)'], ['balanced', 'Balanced'], ['chatty', 'Chatty']]} onChange={(v) => save({ commentary: v })} />
      <Choice label="How often he answers chat" value={s.chatFrequency} options={[['low', 'Low'], ['normal', 'Normal'], ['high', 'High']]} onChange={(v) => save({ chatFrequency: v })} />
      <Choice label="Repetition guard" value={s.repetition} options={[['normal', 'Normal'], ['strict', 'Strict']]} onChange={(v) => save({ repetition: v })} />
      <Choice label="The top hat" value={s.hat} options={[['only_when_asked', 'Only when a viewer mentions it'], ['rare', 'Rarely, when it fits'], ['never', 'Never']]} onChange={(v) => save({ hat: v })} />
      <Slider label="Conversation memory" value={s.memoryTurns} min={4} max={60} suffix=" turns" onCommit={(v) => save({ memoryTurns: v })} />
      <div className="row"><button onClick={async () => { const r = await api<any>('/api/personality/reset', {}); setMsg({ ok: !!r.ok, text: 'Reset to defaults.' }); load(); }}>Reset to defaults</button></div>
      <Note m={msg} />
      <h3>What he is doing right now</h3>
      <div className="card">
        Last humour style: <b>{d.lastHumour ?? '—'}</b> · hat lines blocked: <b>{d.hatBlocked}</b> · lines regenerated for repetition: <b>{d.regenerated ?? 0}</b> · dropped: <b>{d.dropped ?? 0}</b><br />
        Topics he is tracking: {d.topics?.length ? d.topics.join(', ') : '—'}
      </div>
      <h3>Recent conversation</h3>
      {!d.conversation?.length ? <p className="small">No chat yet.</p> : d.conversation.map((t: any, i: number) => (
        <div className="card" key={i} style={{ marginBottom: 6 }}><b>{t.user}</b> <small>({t.tone})</small>: {t.said}<br /><span className="small">Hubie: {t.reply ?? <i>not answered</i>}</span></div>
      ))}
    </section>
  );
}

/* ---------------- 13 — Voice keys & music ---------------- */
export function SecVoiceAudio() {
  const [k, loadK] = usePoll<any>('/api/voice/keys', 4000);
  const [a, loadA] = usePoll<any>('/api/audio', 4000);
  const [msg, setMsg] = useState<Msg>(null);
  const [f, setF] = useState({ name: '', key: '' });
  const [busy, setBusy] = useState(false);
  const kcall = async (p: string, b: object = {}, ok = 'Done.') => { setBusy(true); try { const r = await api<any>(`/api/voice/${p}`, b); setMsg(r.ok === false ? { ok: false, text: em(r) } : { ok: true, text: r.message ?? ok }); } catch (e: any) { setMsg({ ok: false, text: e.message }); } setBusy(false); loadK(); };
  const acall = async (b: object) => { await api('/api/audio', b); loadA(); };
  const move = (i: number, dir: -1 | 1) => { const ids = k.keys.map((x: any) => x.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; kcall('keys/reorder', { ids }, 'Order saved.'); };
  const stClass = (s: string) => (s === 'ok' ? 'good-t' : s === 'unknown' ? '' : 'bad-t');
  return (
    <section>
      <h2>13 — Audio: voice keys & music</h2>
      <h3>ElevenLabs keys (automatic failover)</h3>
      <p className="small">Add as many backup keys as you like. Hubie uses the first healthy key in the order below and switches automatically on out-of-credits, rate limits, bad keys and outages. Keys are never shown again after you save them.</p>
      {k && (
        <div className="card">
          Active key: <b>{k.activeKey ?? 'none'}</b> · keys: <b>{k.enabledKeys}/{k.totalKeys}</b> enabled · engine: <b>{k.engine}</b> · local fallback: <b>{k.localFallback}</b>{k.localFallbackActive && <span className="bad-t"> (IN USE)</span>}<br />
          Last successful speech: <b>{ago(k.lastSuccessAt)}</b> · characters sent: <b>{k.charsSent}</b> · est. credits: <b>{k.estimatedCredits}</b> · silent lines: <b>{k.silent}</b>
          {k.lastError && <div className="bad-t small">Last error: {T(k.lastError)}</div>}
        </div>
      )}
      {k?.keys?.map((x: any, i: number) => (
        <div className="card" key={x.id} style={{ marginTop: 8 }}>
          <div className="row wrap">
            <b>{x.name}</b> <code>{x.masked}</code> {x.active && <span className="good-t">● ACTIVE</span>}
            <span className={stClass(x.status)}>{x.status}</span>{!x.enabled && <span className="small">(disabled)</span>}
            {x.sharesAllowanceWith?.length > 0 && <span className="small" title="Same ElevenLabs account — shares one allowance">⚠ shares one allowance with {x.sharesAllowanceWith.join(', ')} (a backup on the same account won't add credits)</span>}
          </div>
          <div className="small">{x.detail}{x.usage ? ` · used ${x.usage.used}/${x.usage.limit}${x.usage.resetAt ? `, resets ${new Date(x.usage.resetAt).toLocaleDateString()}` : ''}` : ''} · {x.requests ?? 0} requests · last ok {ago(x.lastOkAt)}</div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button disabled={busy} onClick={() => move(i, -1)}>↑</button><button disabled={busy} onClick={() => move(i, 1)}>↓</button>
            <button disabled={busy} onClick={() => kcall('keys/test', { id: x.id })}>Test</button>
            <button disabled={busy} onClick={() => kcall('keys/update', { id: x.id, enabled: !x.enabled }, x.enabled ? 'Disabled.' : 'Enabled.')}>{x.enabled ? 'Disable' : 'Enable'}</button>
            {!x.fromWizard && <button className="danger" disabled={busy} onClick={() => confirm(`Remove "${x.name}"?`) && kcall('keys/remove', { id: x.id }, 'Removed.')}>Remove</button>}
          </div>
        </div>
      ))}
      <div className="field"><label>Add a backup key</label>
        <div className="row"><input placeholder="Name (e.g. Backup 2)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><input type="password" autoComplete="off" placeholder="sk_…" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
          <button className="ok" disabled={busy || !f.key} onClick={async () => { await kcall('keys/add', f, 'Key added and tested.'); setF({ name: '', key: '' }); }}>Add</button></div></div>
      <div className="row wrap"><button disabled={busy} onClick={() => kcall('keys/refresh-usage', {}, 'Usage refreshed (needs the user_read permission on the key).')}>Refresh usage</button></div>
      {k && <>
        <Choice label="If every key fails, use" value={k.localFallback} options={[['browser', 'Browser voice (free)'], ['espeak', 'eSpeak (server, free)'], ['none', 'Stay silent']]} onChange={(v) => kcall('failover-settings', { localFallback: v }, 'Saved.')} />
        <p className="small">Hubie never silently switches to another paid provider. If all engines fail he keeps streaming without speech.</p>
      </>}
      <Note m={msg} />
      {k?.failovers?.length > 0 && <><h3>Failover history</h3>{k.failovers.slice(0, 10).map((h: any, i: number) => <div key={i} className="small">{new Date(h.at).toLocaleTimeString()} — {h.from} → {h.to} ({h.reason})</div>)}</>}
      {k?.errors?.length > 0 && <><h3>Recent key errors</h3>{k.errors.slice(0, 10).map((h: any, i: number) => <div key={i} className="small bad-t">{new Date(h.at).toLocaleTimeString()} — {h.keyName} — {h.code}: {h.message}</div>)}</>}

      <h3>Background music</h3>
      {a && <>
        <p className="small">{a.license ?? 'Original loops made for Hubie.'} You can also drop your own licensed files into <code>{a.musicFolder}</code>.</p>
        <Toggle label="Music on" on={a.settings.musicEnabled} onChange={(v) => acall({ musicEnabled: v })} />
        <Slider label="Music volume" value={a.settings.musicVolume} suffix="%" onCommit={(v) => acall({ musicVolume: v })} />
        <Slider label="Hubie's voice volume" value={a.settings.voiceVolume} suffix="%" onCommit={(v) => acall({ voiceVolume: v })} />
        <Toggle label="Duck music while Hubie speaks" on={a.settings.duckEnabled} onChange={(v) => acall({ duckEnabled: v })} />
        <Slider label="Music level while he speaks" value={a.settings.duckLevel} suffix="%" onCommit={(v) => acall({ duckLevel: v })} />
        <Choice label={`Mood (auto follows the show: now “${a.autoMood}”)`} value={a.settings.mood} options={[['auto', 'Auto'], ['funky', 'Funky'], ['electronic', 'Electronic'], ['chill', 'Chill'], ['hype', 'Hype'], ['ambient', 'Ambient']]} onChange={(v) => acall({ mood: v })} />
        <div className="card">Player: <b>{a.status?.state ?? 'no overlay open'}</b>{a.status?.track && <> · {a.status.track}</>}{a.status?.ducked && ' · ducked'} · plays {a.status?.plays ?? 0} · failures {a.status?.failures ?? 0}{a.status?.lastError && <div className="bad-t small">{T(a.status.lastError)}</div>}</div>
        <h4>Tracks</h4>
        {a.tracks.map((t: any) => { const off = a.settings.disabledTracks.includes(t.id); return <Toggle key={t.id} label={`${t.title} (${t.mood}, ${Math.round(t.seconds ?? 0)}s)`} on={!off} onChange={(v) => acall({ disabledTracks: v ? a.settings.disabledTracks.filter((x: string) => x !== t.id) : [...a.settings.disabledTracks, t.id] })} />; })}
      </>}
    </section>
  );
}

/* ---------------- 14 — Avatar ---------------- */
export function SecAvatarLife() {
  const [d, load] = usePoll<any>('/api/avatar', 1500);
  const save = async (b: object) => { await api('/api/avatar', b); load(); };
  if (!d) return <section><h2>14 — Avatar animation</h2><p>Loading…</p></section>;
  const s = d.settings;
  return (
    <section>
      <h2>14 — Avatar animation</h2>
      <div className="card">Right now Hubie is: <b style={{ fontSize: 20 }}>{d.state}</b></div>
      <Slider label="Animation intensity" value={s.intensity} min={40} max={160} suffix="%" onCommit={(v) => save({ intensity: v })} help="100 = normal. Lower is calmer, higher is more theatrical." />
      <Toggle label="Idle life" on={s.idleLife} onChange={(v) => save({ idleLife: v })} help="blinks, glances, head and body drift" />
      <Toggle label="Talking gestures" on={s.talkGestures} onChange={(v) => save({ talkGestures: v })} />
      <Toggle label="Big reactions" on={s.reactions} onChange={(v) => save({ reactions: v })} help="laugh, surprise, celebration on game events" />
      <Toggle label="Listening / thinking cues" on={s.cues} onChange={(v) => save({ cues: v })} />
      <h3>Preview a state (shows on the open overlay)</h3>
      <div className="chips">{AVATAR_STATES.filter((x) => x !== 'idle' && x !== 'speaking').map((st) => <button key={st} onClick={() => api('/api/avatar/preview', { state: st })}>{st}</button>)}</div>
      <p className="small">Speaking is driven by real audio, so use Section 7's voice test to preview it.</p>
      {d.counts && <><h3>States seen this session</h3><div className="small">{Object.entries(d.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div></>}
    </section>
  );
}

/* ---------------- 15 — Streaming / ON AIR ---------------- */
export function SecStreaming() {
  const [d] = usePoll<any>('/api/live/stats', 3000);
  if (!d) return <section><h2>15 — Streaming</h2><p>Loading…</p></section>;
  return (
    <section>
      <h2>15 — Streaming & ON AIR counter</h2>
      <div className="card">
        Status: {d.live ? <b className="good-t">● LIVE (confirmed)</b> : <b className="bad-t">OFFLINE — counter paused</b>} · evidence: <b>{d.source}</b><br />
        <small>{d.detail}</small><br />
        Total confirmed live time: <b>{d.label}</b> ({dur(d.totalMs)}) · this session: <b>{dur(d.currentMs)}</b> · sessions: <b>{d.sessionsCount}</b> · reconnects: <b>{d.reconnects}</b><br />
        Milestone 150 h: {d.milestoneReached ? <b className="good-t">reached</b> : `${Math.max(0, 150 - d.totalMs / 3600000).toFixed(1)} h to go`}
      </div>
      <p className="small">{d.note} The overlay shows “150+ HOURS” only once the real total reaches 150 h. Nothing is estimated or imported.</p>
      <HistoryBadgeEditor />
      <h3>Measured live time (what Hubie has actually tracked)</h3>
      <p className="small">The figures above are measured by Hubie from confirmed-live time only. They are shown here for monitoring and are separate from the "{'150+ HOURS ON AIR'}" history badge on the overlay.</p>
      <h3>Session history</h3>
      {d.sessions.length === 0 ? <p className="small">No live sessions recorded yet.</p> : d.sessions.map((x: any, i: number) => <div className="small" key={i}>{new Date(x.start).toLocaleString()} → {x.live ? 'now' : new Date(x.end).toLocaleString()} · {dur(x.ms)} · {x.source}</div>)}
      <h3>Disconnect log</h3>
      {d.disconnects.length === 0 ? <p className="small">None.</p> : d.disconnects.map((x: any, i: number) => <div className="small" key={i}>{new Date(x.at).toLocaleString()} — {x.detail ?? 'stream no longer live'}</div>)}
      <p className="small">Go-live controls and the pre-stream checklist are in Sections 5, 10 and 11.</p>
    </section>
  );
}

function HistoryBadgeEditor() {
  const [d, load] = usePoll<any>('/api/history-badge', 8000);
  const [t, setT] = useState('');
  useEffect(() => { if (d && !t) setT(d.text); }, [d]);
  if (!d) return null;
  return (
    <>
      <h3>History badge on the overlay</h3>
      <div className="card">
        <Toggle label="Show the history badge" on={d.enabled} onChange={async (v) => { await api('/api/history-badge', { enabled: v }); load(); }} />
        <div className="row"><input value={t} maxLength={40} onChange={(e) => setT(e.target.value)} /><button className="ok" onClick={async () => { await api('/api/history-badge', { text: t }); load(); }}>Save</button></div>
        <small>Always visible while on. It represents Hubie's established history across earlier streams — it is not a session timer and is not reset by disconnects. It is a figure you state; Hubie does not measure it.</small>
      </div>
    </>
  );
}

/* ---------------- 16 — Monitoring ---------------- */
function Spark({ vals, color = '#3cd8ff' }: { vals: number[]; color?: string }) {
  if (vals.length < 2) return <span className="small">collecting…</span>;
  const max = Math.max(1, ...vals), w = 220, h = 36;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return <svg width={w} height={h} role="img"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" /></svg>;
}
export function SecMonitoring() {
  const [d] = usePoll<any>('/api/monitor', 4000);
  if (!d) return <section><h2>16 — Monitoring</h2><p>Loading…</p></section>;
  const n = d.now;
  return (
    <section>
      <h2>16 — Monitoring</h2>
      <div className="card">
        Controller uptime: <b>{dur(d.uptimeSec * 1000)}</b> · memory: <b>{n?.rssMB ?? '…'} MB</b> (heap {n?.heapMB ?? '…'}) · CPU avg <b>{d.avgCpuPct}%</b> · event-loop lag avg <b>{d.avgLagMs} ms</b> (max {d.maxLagMs})<br />
        Memory change over the last {dur(d.windowSec * 1000)}: <b>{d.rssGrowthMB >= 0 ? '+' : ''}{d.rssGrowthMB} MB</b>
        <div className="row wrap" style={{ gap: 24, marginTop: 6 }}><div><small>memory MB</small><br /><Spark vals={d.series.map((x: any) => x.rssMB)} /></div><div><small>CPU %</small><br /><Spark vals={d.series.map((x: any) => x.cpuPct)} color="#ff9d3c" /></div></div>
      </div>
      <h3>Speech</h3>
      <div className="card">Queue: <b>{d.speech.queued}/{d.speech.cap}</b> · spoken {d.speech.spoken} · interrupted {d.speech.interrupted} · dropped {d.speech.dropped} · regenerated {d.speech.regenerated} · blocked {d.speech.blocked} · hat lines blocked {d.speech.hatBlocked}{d.estop && <b className="bad-t"> · EMERGENCY STOP ON</b>}</div>
      <h3>Voice engine</h3>
      <div className="card">Engine: <b>{d.voice.engine}</b> · last success {ago(Math.max(0, ...Object.values<number>(d.voice.lastOkAt ?? {})))} · served {Object.entries(d.voice.served ?? {}).map(([e, n]) => `${e} ${n}`).join(', ') || '0'} · silent {d.voice.silent} · failovers {d.voice.failovers} · characters {d.voice.charsSent} (≈{d.voice.estimatedCredits} credits){d.voice.lastError && <div className="bad-t small">{T(d.voice.lastError)}</div>}</div>
      {d.voice.keyErrors.length > 0 && d.voice.keyErrors.map((e: any, i: number) => <div key={i} className="small bad-t">{new Date(e.at).toLocaleTimeString()} {e.keyName} — {e.code}: {e.message}</div>)}
      <h3>AI brain</h3>
      <div className="card">Provider: <b>{d.llm.provider}</b> · last used: {T(d.llm.last) || '—'}{d.llm.lastError && <div className="bad-t small">{T(d.llm.lastErrorCode)}: {T(d.llm.lastError)}</div>}</div>
      <h3>Music & avatar</h3>
      <div className="card">Music: <b>{d.music?.state ?? 'no overlay open'}</b>{d.music?.track && ` · ${d.music.track}`}{d.music?.failures ? ` · ${d.music.failures} failures recovered` : ''} · Avatar: <b>{d.avatarState}</b> · connected pages: {d.clients.map((c: any) => c.role).join(', ') || 'none'}</div>
      <h3>Components</h3>
      {d.components.map((c: any, i: number) => <div key={i} className="small">{c.state === 'down' || c.ok === false ? '✗' : '✓'} {T(c.name ?? c.id)}: {T(c.detail ?? c.state ?? c.status)}</div>)}
    </section>
  );
}
