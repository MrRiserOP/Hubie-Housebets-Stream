/** OBS readiness / output config / private test stream against a fake obs-websocket v5. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { ObsController } from '../../apps/stream-engine/src/obs.ts';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return; await wait(50); } throw new Error('timeout'); }

const KEY = 'live_123456789_abcdefghijklmnopqrstuv';
const state = { scenes: ['Scene'], inputs: [] as string[], streaming: false, program: 'Scene', svc: { streamServiceType: 'rtmp_custom', streamServiceSettings: {} as any }, video: { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 }, profile: new Map<string, string>(), frames: 0, keysUsedForStart: [] as string[] };
const server = http.createServer();
const wss = new WebSocketServer({ server, handleProtocols: () => 'obswebsocket.msgpack' });
wss.on('connection', (ws) => {
  const send = (o: unknown) => ws.send(encode(o));
  send({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } });
  ws.on('message', (raw) => {
    const m = decode(raw as Buffer) as any;
    if (m.op === 1) return send({ op: 2, d: { negotiatedRpcVersion: 1 } });
    if (m.op !== 6) return;
    const { requestType: t, requestId, requestData: d } = m.d;
    let out: any = {};
    if (t === 'GetSceneList') out = { scenes: state.scenes.map((s) => ({ sceneName: s })), currentProgramSceneName: state.program };
    if (t === 'CreateScene') state.scenes.push(d.sceneName);
    if (t === 'GetInputList') out = { inputs: state.inputs.map((n) => ({ inputName: n })) };
    if (t === 'CreateInput') state.inputs.push(d.inputName);
    if (t === 'SetCurrentProgramScene') state.program = d.sceneName;
    if (t === 'GetStreamStatus') { if (state.streaming) state.frames += 30; out = { outputActive: state.streaming, outputReconnecting: false, outputSkippedFrames: 1, outputTotalFrames: state.frames }; }
    if (t === 'StartStream') { state.streaming = true; state.frames = 0; state.keysUsedForStart.push(state.svc.streamServiceSettings.key); }
    if (t === 'StopStream') state.streaming = false;
    if (t === 'GetStreamServiceSettings') out = state.svc;
    if (t === 'SetStreamServiceSettings') state.svc = { streamServiceType: d.streamServiceType, streamServiceSettings: d.streamServiceSettings };
    if (t === 'GetVideoSettings') out = state.video;
    if (t === 'SetVideoSettings') Object.assign(state.video, d);
    if (t === 'GetProfileParameter') out = { parameterValue: state.profile.get(`${d.parameterCategory}/${d.parameterName}`) ?? null };
    if (t === 'SetProfileParameter') state.profile.set(`${d.parameterCategory}/${d.parameterName}`, String(d.parameterValue));
    if (t === 'GetStats') out = { cpuUsage: 10, activeFps: 60, renderSkippedFrames: 0, renderTotalFrames: 100, outputSkippedFrames: 0, outputTotalFrames: 100 };
    if (t === 'GetVersion') out = { obsVersion: '31.0.0' };
    send({ op: 7, d: { requestType: t, requestId, requestStatus: { result: true, code: 100 }, responseData: out } });
  });
});
const port = 46000 + Math.floor(Math.random() * 1000);
await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-obs2-')), 's.json');
const ctl = new ObsController({ url: `ws://127.0.0.1:${port}`, scene: 'Hubie Live', overlayUrl: 'http://127.0.0.1:8787/overlay', inputName: 'Hubie Overlay', stateFile, autostart: false, monitorAudio: false, streamKey: KEY, streamServer: 'rtmps://fake.ingest.example:443/app' }, log);
afterAll(async () => { await ctl.obs.disconnect().catch(() => {}); for (const c of wss.clients) c.terminate(); wss.close(); server.close(); });

describe('OBS go-live readiness', () => {
  it('sets up a custom RTMP service (Kick URL + key) with the server-side key and reports readiness without the key', async () => {
    ctl.start();
    await until(() => ctl.connected && state.program === 'Hubie Live', 15_000);
    await until(() => state.svc.streamServiceSettings.key === KEY);
    expect(state.svc).toMatchObject({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmps://fake.ingest.example:443/app' } });
    const r = await ctl.readiness();
    expect(r).toMatchObject({ connected: true, scene: true, source: true, programIsHubie: true, streamKeySet: true, service: 'custom RTMP server', streaming: false, obsVersion: '31.0.0' });
    expect(JSON.stringify(r)).not.toContain(KEY.slice(5));
  }, 30_000);

  it('configures 1920x1080 @ 60 fps output and reads every setting back', async () => {
    const checks = await ctl.configureOutput();
    const r = await ctl.readiness();
    expect(r.video).toBe('1920x1080 @ 60 fps');
    expect(r.videoOk).toBe(true);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.settingsOk).toBe(true);
  });
});
