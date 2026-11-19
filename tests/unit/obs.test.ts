/**
 * OBS controller against a minimal fake obs-websocket v5 server (JSON protocol,
 * no auth). Verifies scene/browser-source setup, stream start, persisted
 * desired state, and recovery after "OBS restarts" (server goes away and back).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack'; // obs-websocket-js (Node) speaks obswebsocket.msgpack
import { ObsController } from '../../apps/stream-engine/src/obs.ts';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return; await wait(50); } throw new Error('timeout'); }

function fakeObs(port: number) {
  const calls: Array<{ type: string; data: any }> = [];
  const state = { scenes: ['Scene'], inputs: [] as string[], streaming: false, program: 'Scene' };
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
      calls.push({ type: t, data: d });
      let out: any = {};
      if (t === 'GetSceneList') out = { scenes: state.scenes.map((s) => ({ sceneName: s })), currentProgramSceneName: state.program };
      if (t === 'CreateScene') state.scenes.push(d.sceneName);
      if (t === 'GetInputList') out = { inputs: state.inputs.map((n) => ({ inputName: n })) };
      if (t === 'CreateInput') state.inputs.push(d.inputName);
      if (t === 'SetCurrentProgramScene') state.program = d.sceneName;
      if (t === 'GetStreamStatus') out = { outputActive: state.streaming, outputReconnecting: false, outputSkippedFrames: 0, outputTotalFrames: 100 };
      if (t === 'StartStream') state.streaming = true;
      if (t === 'StopStream') state.streaming = false;
      send({ op: 7, d: { requestType: t, requestId, requestStatus: { result: true, code: 100 }, responseData: out } });
    });
  });
  return new Promise<{ calls: typeof calls; state: typeof state; close: () => Promise<void> }>((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({
      calls, state,
      close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
    })));
}

const port = 45000 + Math.floor(Math.random() * 1000);
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-obs-')), 'obs-state.json');
let obsCtl: ObsController;
afterAll(async () => { await obsCtl?.obs.disconnect().catch(() => {}); });

describe('OBS controller (fake obs-websocket v5)', () => {
  it('reports down while OBS is not running, then connects and sets up the scene', async () => {
    const statuses: string[] = [];
    obsCtl = new ObsController({ url: `ws://127.0.0.1:${port}`, scene: 'Hubie Live', overlayUrl: 'http://127.0.0.1:8787/overlay', inputName: 'Hubie Overlay', stateFile, autostart: false, monitorAudio: false }, log);
    obsCtl.onStatus = (s) => statuses.push(s);
    obsCtl.start();
    await until(() => statuses.includes('down'));
    const obs = await fakeObs(port);
    await until(() => obsCtl.connected, 15_000);
    await until(() => obs.state.program === 'Hubie Live');
    expect(obs.state.scenes).toContain('Hubie Live');
    expect(obs.state.inputs).toContain('Hubie Overlay');
    const create = obs.calls.find((c) => c.type === 'CreateInput')!;
    expect(create.data.inputKind).toBe('browser_source');
    expect(create.data.inputSettings).toMatchObject({ width: 1920, height: 1080, reroute_audio: true });

    await obsCtl.startStream();
    expect(obs.state.streaming).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).live).toBe(true);

    // OBS "restarts": server dies, comes back empty, controller restores scene AND stream
    await obs.close();
    await until(() => !obsCtl.connected);
    const obs2 = await fakeObs(port);
    await until(() => obsCtl.connected, 20_000);
    await until(() => obs2.state.streaming, 10_000);
    expect(obs2.state.inputs).toContain('Hubie Overlay');
    await obsCtl.stopStream();
    expect(obs2.state.streaming).toBe(false);
    await obsCtl.obs.disconnect();
    await obs2.close();
  }, 60_000);
});
