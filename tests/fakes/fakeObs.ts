/** Local stand-in for OBS Studio's obs-websocket v5 server (msgpack). Tests only. */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';

export async function startFakeObs() {
  const state = {
    scenes: ['Scene'], inputs: [] as Array<{ name: string; settings: any }>, streaming: false, program: 'Scene', frames: 0,
    svc: { streamServiceType: 'rtmp_custom', streamServiceSettings: {} as any },
    video: { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 },
    profile: new Map<string, string>([['Output/Mode', 'Advanced'], ['SimpleOutput/VBitrate', '2500'], ['SimpleOutput/StreamEncoder', 'x264'], ['Audio/SampleRate', '44100'], ['Audio/ChannelSetup', 'Stereo']]),
    /** what the stand-in 'encoder' reports; tests change these to simulate a struggling PC / bad upload */
    sim: { activeFps: 60, cpu: 28, renderSkippedPerSec: 0, outputSkippedPerSec: 0, kbps: 6000, congestion: 0.02 },
    recording: false, recStart: 0, streamStart: 0, bornAt: Date.now(),
    startKeys: [] as string[], calls: [] as string[],
  };
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
      state.calls.push(t);
      let out: any = {};
      switch (t) {
        case 'GetSceneList': out = { scenes: state.scenes.map((s) => ({ sceneName: s })), currentProgramSceneName: state.program }; break;
        case 'CreateScene': state.scenes.push(d.sceneName); break;
        case 'GetInputList': out = { inputs: state.inputs.map((i) => ({ inputName: i.name })) }; break;
        case 'CreateInput': state.inputs.push({ name: d.inputName, settings: d.inputSettings }); break;
        case 'SetInputSettings': { const i = state.inputs.find((x) => x.name === d.inputName); if (i) i.settings = { ...i.settings, ...d.inputSettings }; break; }
        case 'SetCurrentProgramScene': state.program = d.sceneName; break;
        case 'GetStreamStatus': { if (state.streaming) state.frames += 30; const dur = state.streaming ? Date.now() - state.streamStart : 0; out = { outputActive: state.streaming, outputReconnecting: false, outputSkippedFrames: 0, outputTotalFrames: state.frames, outputDuration: dur, outputBytes: Math.round((state.sim.kbps * 1000 / 8) * dur / 1000), outputCongestion: state.sim.congestion }; break; }
        case 'GetStats': { const el = (Date.now() - state.bornAt) / 1000; out = { cpuUsage: state.sim.cpu, activeFps: state.sim.activeFps, averageFrameRenderTime: 3.1, renderSkippedFrames: Math.round(state.sim.renderSkippedPerSec * el), renderTotalFrames: Math.round(state.sim.activeFps * el), outputSkippedFrames: Math.round(state.sim.outputSkippedPerSec * el), outputTotalFrames: Math.round(state.sim.activeFps * el) }; break; }
        case 'GetProfileParameter': out = { parameterValue: state.profile.get(`${d.parameterCategory}/${d.parameterName}`) ?? null, defaultParameterValue: null }; break;
        case 'SetProfileParameter': state.profile.set(`${d.parameterCategory}/${d.parameterName}`, String(d.parameterValue)); break;
        case 'StartRecord': state.recording = true; state.recStart = Date.now(); break;
        case 'GetRecordStatus': { const dur = state.recording ? Date.now() - state.recStart : 0; out = { outputActive: state.recording, outputPaused: false, outputTimecode: '00:00:00', outputDuration: dur, outputBytes: Math.round((state.sim.kbps * 1000 / 8) * dur / 1000) }; break; }
        case 'StopRecord': state.recording = false; out = { outputPath: '/fake/obs/recordings/hubie-perf-test.mkv' }; break;
        case 'StartStream': state.streaming = true; state.streamStart = Date.now(); state.frames = 0; state.startKeys.push(state.svc.streamServiceSettings.key); break;
        case 'StopStream': state.streaming = false; break;
        case 'GetStreamServiceSettings': out = state.svc; break;
        case 'SetStreamServiceSettings': state.svc = { streamServiceType: d.streamServiceType, streamServiceSettings: d.streamServiceSettings }; break;
        case 'GetVideoSettings': out = state.video; break;
        case 'SetVideoSettings': Object.assign(state.video, d); break;
        case 'GetVersion': out = { obsVersion: '31.0.0 (fake)' }; break;
      }
      send({ op: 7, d: { requestType: t, requestId, requestStatus: { result: true, code: 100 }, responseData: out } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    state, url: `ws://127.0.0.1:${(server.address() as any).port}`,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
  };
}
