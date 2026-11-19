/**
 * OBS integration via obs-websocket v5 (built into OBS 28+).
 *  - idempotent scene setup (scene + 1920×1080 browser source with OBS-controlled audio)
 *  - start/stop stream, remembers desired state and restores it after an OBS restart
 *  - health: stream status, dropped frames, overlay audio level (InputVolumeMeters)
 *  - self-healing: refreshes the browser source if the overlay stops heart-beating
 */
import fs from 'node:fs';
import path from 'node:path';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { Backoff, type Logger } from '../../../packages/shared/src/node.ts';
import { KICK_1080P60, OBS_PROFILE_PARAMS, evaluateVideo, evaluateProfile, judgeQuality, type Check, type QualitySample } from '../../../packages/shared/src/streamSpec.ts';
import type { ObsReadiness } from '../../../packages/shared/src/protocol.ts';

export interface ObsConfig {
  url: string; password?: string; scene: string; overlayUrl: string; inputName: string;
  stateFile: string; autostart: boolean; monitorAudio: boolean;
  streamServer?: string; streamKey?: string;
}

export class ObsController {
  obs = new OBSWebSocket();
  connected = false;
  private backoff = new Backoff(1000, 30_000);
  private desiredLive: boolean;
  private lastAudioPeak = 0;
  private lastAudioAt = 0;
  private lastRefreshAt = 0;
  onStatus?: (state: 'ok' | 'degraded' | 'down', detail: string) => void;

  constructor(private cfg: ObsConfig, private log: Logger) {
    // Restore "live" only after a crash/restart within 10 minutes. A stale "live" flag from days ago
    // must never start a public stream by itself.
    const st = this.readState();
    const recent = !!st.at && Date.now() - st.at < 10 * 60_000;
    this.desiredLive = st.live !== undefined && recent ? st.live : cfg.autostart;
    this.obs.on('ConnectionClosed', () => {
      if (!this.connected) return;
      this.connected = false;
      this.onStatus?.('down', 'OBS connection closed');
      this.log.warn('OBS connection closed; will reconnect');
      this.scheduleConnect();
    });
    this.obs.on('InputVolumeMeters', ({ inputs }) => {
      const me = (inputs as any[]).find((i) => i.inputName === this.cfg.inputName);
      const levels: number[][] = me?.inputLevelsMul ?? [];
      const peak = Math.max(0, ...levels.map((ch) => ch[1] ?? 0));
      if (peak > 0.01) { this.lastAudioPeak = peak; this.lastAudioAt = Date.now(); }
    });
    this.obs.on('StreamStateChanged', ({ outputActive, outputState }) => this.log.info(`stream state: ${outputState} (active=${outputActive})`));
  }

  private readState(): { live?: boolean; at?: number } {
    try { return JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8')); } catch { return {}; }
  }
  private writeState() {
    fs.mkdirSync(path.dirname(this.cfg.stateFile), { recursive: true });
    fs.writeFileSync(this.cfg.stateFile, JSON.stringify({ live: this.desiredLive, at: Date.now() }));
  }

  start() { void this.connect(); setInterval(() => this.poll(), Number(process.env.OBS_POLL_MS) || 5_000).unref(); }

  private scheduleConnect() {
    const d = this.backoff.next() ?? 30_000;
    setTimeout(() => void this.connect(), d);
  }

  private async connect() {
    try {
      await this.obs.connect(this.cfg.url, this.cfg.password || undefined, {
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
      });
      this.connected = true;
      this.backoff.reset();
      this.log.info(`connected to OBS at ${this.cfg.url}`);
      await this.setupScene();
      if (this.desiredLive) await this.startStream(false);
      this.onStatus?.('ok', 'connected');
    } catch (e) {
      this.connected = false;
      this.onStatus?.('down', `cannot reach OBS: ${(e as Error).message}`);
      this.log.warn(`OBS connect failed: ${(e as Error).message}`);
      this.scheduleConnect();
    }
  }

  async setupScene() {
    const { scenes } = await this.obs.call('GetSceneList');
    if (!(scenes as any[]).some((s) => s.sceneName === this.cfg.scene)) {
      await this.obs.call('CreateScene', { sceneName: this.cfg.scene });
      this.log.info(`created scene "${this.cfg.scene}"`);
    }
    const settings = {
      url: this.cfg.overlayUrl, width: KICK_1080P60.width, height: KICK_1080P60.height, fps: KICK_1080P60.fps, fps_custom: true,
      reroute_audio: true, // "Control audio via OBS" so Hubie's voice is in the stream mix
      shutdown: false, restart_when_active: false, css: '',
    };
    const { inputs } = await this.obs.call('GetInputList');
    if (!(inputs as any[]).some((i) => i.inputName === this.cfg.inputName)) {
      await this.obs.call('CreateInput', { sceneName: this.cfg.scene, inputName: this.cfg.inputName, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: true });
      this.log.info(`created browser source "${this.cfg.inputName}" → ${this.cfg.overlayUrl}`);
    } else {
      await this.obs.call('SetInputSettings', { inputName: this.cfg.inputName, inputSettings: settings, overlay: true });
    }
    if (this.cfg.monitorAudio) {
      await this.obs.call('SetInputAudioMonitorType', { inputName: this.cfg.inputName, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }).catch(() => {});
    }
    await this.obs.call('SetInputMute', { inputName: this.cfg.inputName, inputMuted: false }).catch(() => {});
    await this.obs.call('SetCurrentProgramScene', { sceneName: this.cfg.scene });
    await this.applyStreamKey();
  }

  /** Put the Kick stream URL + key (kept server-side in .env, from the Kick creator dashboard) into OBS as a custom RTMP(S) service. */
  private async applyStreamKey(key = this.cfg.streamKey) {
    if (!key || !this.cfg.streamServer) return;
    await this.obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: this.cfg.streamServer, key } });
  }

  /**
   * Apply Kick's published 1080p60 settings: 1920×1080 canvas + output at 60 fps, and (Simple output mode) x264 / CBR /
   * 6,000 kbps / keyframe every 2 s / profile main / tune zerolatency / 48 kHz stereo. Then READ EVERYTHING BACK from OBS and report
   * what OBS actually holds. Only allowed while not streaming (OBS refuses video changes otherwise). Encoder settings are read
   * by OBS when the output next starts.
   */
  async configureOutput(): Promise<Check[]> {
    if (!this.connected) throw new Error('OBS is not connected');
    const st = await this.obs.call('GetStreamStatus');
    if (st.outputActive) throw new Error('Stop the stream before changing video settings');
    await this.obs.call('SetVideoSettings', { baseWidth: KICK_1080P60.width, baseHeight: KICK_1080P60.height, outputWidth: KICK_1080P60.width, outputHeight: KICK_1080P60.height, fpsNumerator: KICK_1080P60.fps, fpsDenominator: 1 });
    for (const [parameterCategory, parameterName, parameterValue] of OBS_PROFILE_PARAMS) {
      await this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
    }
    await this.setupScene(); // browser source also renders at 60 fps
    const checks = await this.readChecks();
    const bad = checks.filter((c) => !c.ok);
    this.log.info(`OBS 1080p60 applied; read back ${checks.length - bad.length}/${checks.length} settings correct${bad.length ? ` (wrong: ${bad.map((b) => b.name).join(', ')})` : ''}`);
    return checks;
  }

  private async readProfile(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    await Promise.all(OBS_PROFILE_PARAMS.map(async ([c, n]) => {
      try { const r: any = await this.obs.call('GetProfileParameter', { parameterCategory: c, parameterName: n }); if (r.parameterValue != null) m.set(`${c}/${n}`, String(r.parameterValue)); } catch { /* unreadable */ }
    }));
    return m;
  }
  async readChecks(): Promise<Check[]> {
    const [vid, prof] = await Promise.all([this.obs.call('GetVideoSettings').catch(() => null), this.readProfile()]);
    return [...evaluateVideo(vid as any), ...evaluateProfile((c, n) => prof.get(`${c}/${n}`))];
  }

  /* ---------- measurements: only numbers OBS itself reports while it is encoding ---------- */
  private win?: { startedAt: number; fpsSum: number; n: number; bytes0: number; dur0: number; congSum: number; rs0: number; rt0: number; os0: number; ot0: number; last?: QualitySample };
  quality?: QualitySample & { ok: boolean; problems: string[] };
  liveVerifiedAt?: number;
  perfTest?: { at: number; ok: boolean; detail: string; running?: boolean };

  /** Called every few seconds while connected. While a stream or recording is active it accumulates a measurement window. */
  async sampleQuality(active: boolean, duration: number, bytes: number, congestion: number) {
    const s: any = await this.obs.call('GetStats').catch(() => null);
    if (!s) return;
    if (!active) { this.win = undefined; return; }
    if (!this.win) this.win = { startedAt: Date.now(), fpsSum: 0, n: 0, bytes0: bytes, dur0: duration, congSum: 0, rs0: s.renderSkippedFrames, rt0: s.renderTotalFrames, os0: s.outputSkippedFrames, ot0: s.outputTotalFrames };
    const w = this.win;
    w.fpsSum += s.activeFps; w.n++; w.congSum += congestion;
    const rt = Math.max(1, s.renderTotalFrames - w.rt0), ot = Math.max(1, s.outputTotalFrames - w.ot0);
    const sample: QualitySample = {
      at: Date.now(), streaming: true, fps: w.fpsSum / w.n, kbps: ((bytes - w.bytes0) * 8) / 1000 / Math.max(1, (duration - w.dur0) / 1000),
      congestionPct: (w.congSum / w.n) * 100, renderSkippedPct: ((s.renderSkippedFrames - w.rs0) / rt) * 100, encodeSkippedPct: ((s.outputSkippedFrames - w.os0) / ot) * 100,
      cpu: s.cpuUsage, seconds: (duration - w.dur0) / 1000,
    };
    this.quality = { ...sample, ...judgeQuality(sample) };
  }

  /**
   * Local performance test: records ~30 s with the same encoder settings. NOTHING is broadcast. It proves this PC can render
   * 60 fps and encode 1080p60 without skipping frames; it does not test the connection to Kick. The recording stays in OBS's
   * recording folder (the path is reported) — delete it when you like.
   */
  async performanceTest(seconds = 30): Promise<void> {
    if (!this.connected) throw new Error('OBS is not connected');
    const st: any = await this.obs.call('GetStreamStatus');
    if (st.outputActive) throw new Error('A stream is running — the local test only runs while you are NOT streaming.');
    const checks = await this.readChecks();
    if (!checks.filter((c) => c.name.startsWith('Canvas') || c.name.startsWith('Output (') || c.name === 'Frame rate').every((c) => c.ok)) throw new Error('OBS is not set to 1920×1080 at 60 fps yet — press “Apply 1080p60 settings” first.');
    this.perfTest = { at: Date.now(), ok: false, detail: 'Recording for ~30 s to measure frame rate and encoder load (nothing is broadcast)…', running: true };
    this.win = undefined;
    await this.obs.call('StartRecord');
    let last: any;
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < seconds * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        const rs: any = await this.obs.call('GetRecordStatus');
        if (!rs.outputActive) throw new Error('OBS stopped recording by itself — check the recording folder permissions and disk space.');
        await this.sampleQuality(true, rs.outputDuration, rs.outputBytes, 0);
        last = this.quality;
      }
    } finally {
      const out: any = await this.obs.call('StopRecord').catch(() => null);
      this.win = undefined;
      const q = last as (QualitySample & { ok: boolean; problems: string[] }) | undefined;
      this.perfTest = q
        ? { at: Date.now(), ok: q.ok, running: false, detail: q.ok ? `PASS on this PC: ${q.fps.toFixed(1)} fps, ${Math.round(q.kbps)} kbps, ${q.renderSkippedPct.toFixed(2)}% render-skipped, ${q.encodeSkippedPct.toFixed(2)}% encoder-skipped, CPU ${q.cpu.toFixed(0)}%.${out?.outputPath ? ` Test recording: ${out.outputPath}` : ''}` : `NOT OK: ${q.problems.join('; ')}.${out?.outputPath ? ` Test recording: ${out.outputPath}` : ''}` }
        : { at: Date.now(), ok: false, running: false, detail: 'No measurement could be taken.' };
      this.quality = undefined;
    }
  }

  /**
   * Everything the GO LIVE checklist needs, WITHOUT the stream key itself
   * (only whether one is set).
   */
  async readiness(): Promise<ObsReadiness> {
    const r: ObsReadiness = { connected: this.connected, scene: false, source: false, programIsHubie: false, streamKeySet: false, service: '', streaming: false, video: '', audioSeenSecAgo: this.lastAudioAt ? Math.round((Date.now() - this.lastAudioAt) / 1000) : -1, audioPeak: Math.round(this.lastAudioPeak * 100) / 100, obsVersion: '' };
    if (!this.connected) return r;
    const [scenes, inputs, svc, st, vid, ver] = await Promise.all([
      this.obs.call('GetSceneList').catch(() => null), this.obs.call('GetInputList').catch(() => null),
      this.obs.call('GetStreamServiceSettings').catch(() => null), this.obs.call('GetStreamStatus').catch(() => null),
      this.obs.call('GetVideoSettings').catch(() => null), this.obs.call('GetVersion').catch(() => null),
    ]);
    r.scene = !!(scenes as any)?.scenes?.some((x: any) => x.sceneName === this.cfg.scene);
    r.programIsHubie = (scenes as any)?.currentProgramSceneName === this.cfg.scene;
    r.source = !!(inputs as any)?.inputs?.some((x: any) => x.inputName === this.cfg.inputName);
    const ss = (svc as any)?.streamServiceSettings ?? {};
    r.streamKeySet = !!ss.key; // boolean only — the key never leaves this process
    r.service = (svc as any)?.streamServiceType === 'rtmp_common' ? String(ss.service ?? 'service') : (svc as any)?.streamServiceType === 'rtmp_custom' ? 'custom RTMP server' : '';
    r.streaming = !!(st as any)?.outputActive;
    if (vid) r.video = `${(vid as any).outputWidth}x${(vid as any).outputHeight} @ ${Math.round((vid as any).fpsNumerator / ((vid as any).fpsDenominator || 1))} fps`;
    r.obsVersion = (ver as any)?.obsVersion ?? '';
    const checks = await this.readChecks().catch(() => [] as Check[]);
    r.checks = checks; r.settingsOk = checks.length > 0 && checks.every((c) => c.ok);
    r.videoOk = checks.filter((c) => /^(Canvas|Output \(|Frame rate)/.test(c.name)).every((c) => c.ok) && checks.length > 0;
    if (this.quality) r.quality = this.quality;
    if (this.liveVerifiedAt) r.liveVerifiedAt = this.liveVerifiedAt;
    if (this.perfTest) r.perfTest = this.perfTest;
    return r;
  }

  async startStream(remember = true) {
    if (remember) { this.desiredLive = true; this.writeState(); }
    if (!this.connected) return;
    const st = await this.obs.call('GetStreamStatus');
    if (!st.outputActive) { await this.obs.call('StartStream'); this.log.info('stream started'); }
  }

  async stopStream() {
    this.desiredLive = false; this.writeState();
    if (!this.connected) return;
    const st = await this.obs.call('GetStreamStatus');
    if (st.outputActive) { await this.obs.call('StopStream'); this.log.info('stream stopped'); }
  }

  async refreshOverlay(reason: string) {
    if (!this.connected || Date.now() - this.lastRefreshAt < 60_000) return;
    this.lastRefreshAt = Date.now();
    this.log.warn(`refreshing overlay browser source: ${reason}`);
    await this.obs.call('PressInputPropertiesButton', { inputName: this.cfg.inputName, propertyName: 'refreshnocache' }).catch((e) => this.log.warn(`refresh failed: ${e.message}`));
  }

  private async poll() {
    if (this.desiredLive) this.writeState(); // keeps the crash-recovery timestamp fresh while live
    if (!this.connected) return;
    try {
      const st = await this.obs.call('GetStreamStatus');
      const audioAgo = this.lastAudioAt ? Math.round((Date.now() - this.lastAudioAt) / 1000) : -1;
      const detail = `${st.outputActive ? 'LIVE' : 'not streaming'}${st.outputActive ? ` · skipped ${st.outputSkippedFrames}/${st.outputTotalFrames}${this.quality ? ` · ${this.quality.fps.toFixed(0)} fps · ${Math.round(this.quality.kbps)} kbps` : ''}` : ''} · overlay audio ${audioAgo < 0 ? 'none yet' : `${audioAgo}s ago (peak ${this.lastAudioPeak.toFixed(2)})`}`;
      const degraded = (this.desiredLive && !st.outputActive) || st.outputReconnecting;
      if (st.outputActive) await this.sampleQuality(true, st.outputDuration, st.outputBytes, st.outputCongestion ?? 0); else if (!this.perfTest?.running) { this.win = undefined; this.quality = undefined; }
      const q = this.quality;
      if (st.outputActive && q && q.ok && q.seconds >= (Number(process.env.OBS_LIVE_VERIFY_SECONDS) || 60) && !this.liveVerifiedAt) {
        const checks = await this.readChecks().catch(() => [] as Check[]);
        if (checks.length && checks.every((c) => c.ok)) { this.liveVerifiedAt = Date.now(); this.log.info(`1080p60 verified on a live stream: ${q.fps.toFixed(1)} fps, ${Math.round(q.kbps)} kbps over ${Math.round(q.seconds)} s`); }
      }
      if (!st.outputActive) this.liveVerifiedAt = undefined;
      this.onStatus?.(degraded ? 'degraded' : 'ok', detail);
      if (this.desiredLive && !st.outputActive && !st.outputReconnecting) await this.startStream(false);
    } catch (e) { this.onStatus?.('degraded', `poll failed: ${(e as Error).message}`); }
  }
}
