/** Real ObsController against the obs-websocket STAND-IN (tests/fakes/fakeObs.ts): apply → read back → measure. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeObs } from '../fakes/fakeObs.ts';
import { ObsController } from '../../apps/stream-engine/src/obs.ts';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await wait(100); } throw new Error('timeout'); }
let fake: Awaited<ReturnType<typeof startFakeObs>>; let ctl: ObsController;
beforeAll(async () => {
  process.env.OBS_POLL_MS = '400'; process.env.OBS_LIVE_VERIFY_SECONDS = '4';
  fake = await startFakeObs();
  ctl = new ObsController({ url: fake.url, scene: 'Hubie Live', overlayUrl: 'http://127.0.0.1:8787/overlay', inputName: 'Hubie Overlay', stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-obs60-')), 's.json'), autostart: false, monitorAudio: false }, log);
  ctl.start(); await until(() => ctl.connected);
});
afterAll(async () => { await ctl.obs.disconnect().catch(() => {}); await fake.close(); });

describe('1080p60 through obs-websocket', () => {
  it('starts from a wrong setup (720p30, Advanced mode) and says so', async () => {
    const r = await ctl.readiness();
    expect(r.videoOk).toBe(false); expect(r.settingsOk).toBe(false);
    expect(r.checks!.filter((c) => !c.ok).map((c) => c.name)).toEqual(expect.arrayContaining(['Frame rate', 'Output mode', 'Keyframe interval (Kick: 2 s)']));
  });
  it('apply writes 1920×1080@60 + x264/CBR/6000/keyint 120 and every value reads back correct', async () => {
    const checks = await ctl.configureOutput();
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(fake.state.video).toMatchObject({ baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 });
    expect(fake.state.profile.get('SimpleOutput/x264Settings')).toContain('keyint=120');
    expect(fake.state.profile.get('SimpleOutput/VBitrate')).toBe('6000');
    expect(fake.state.inputs.find((i) => i.name === 'Hubie Overlay')!.settings).toMatchObject({ width: 1920, height: 1080, fps: 60 });
    expect((await ctl.readiness()).settingsOk).toBe(true);
  });
  it('refuses to change video while streaming', async () => {
    await ctl.startStream(false);
    await expect(ctl.configureOutput()).rejects.toThrow(/Stop the stream/);
    await ctl.stopStream();
  });
  it('local performance test passes on a healthy simulated PC and records nothing public', async () => {
    fake.state.sim.activeFps = 60;
    await ctl.performanceTest(4);
    const r = await ctl.readiness();
    expect(r.perfTest?.ok).toBe(true);
    expect(r.perfTest?.detail).toMatch(/PASS on this PC: 6\d\.\d fps|PASS on this PC: 5\d\.\d fps/);
    expect(fake.state.streaming).toBe(false);
  }, 30_000);
  it('local performance test FAILS and explains when the PC cannot keep up (42 fps, encoder skipping)', async () => {
    fake.state.sim.activeFps = 42; fake.state.sim.outputSkippedPerSec = 9;
    await ctl.performanceTest(4);
    const r = await ctl.readiness();
    expect(r.perfTest?.ok).toBe(false);
    expect(r.perfTest?.detail).toMatch(/42\.0 fps, not 60/);
    expect(r.perfTest?.detail).toMatch(/encoder/);
    fake.state.sim.activeFps = 60; fake.state.sim.outputSkippedPerSec = 0;
  }, 30_000);
  it('only after real streaming for the window is it "verified on a live stream"; early on it is not', async () => {
    expect((await ctl.readiness()).liveVerifiedAt).toBeUndefined();
    await ctl.startStream(false);
    await wait(1500);
    expect((await ctl.readiness()).liveVerifiedAt).toBeUndefined(); // too short
    await until(async () => !!(await ctl.readiness()).liveVerifiedAt, 20_000);
    const r = await ctl.readiness();
    expect(r.quality!.kbps).toBeGreaterThan(4000); expect(r.quality!.kbps).toBeLessThan(8000);
    expect(r.quality!.fps).toBeGreaterThan(58);
  }, 40_000);
  it('a struggling live stream is reported with causes and never verified', async () => {
    await ctl.stopStream(); await wait(800);
    expect((await ctl.readiness()).liveVerifiedAt).toBeUndefined();
    fake.state.sim.kbps = 9500; fake.state.sim.congestion = 0.7; fake.state.sim.activeFps = 51;
    await ctl.startStream(false);
    await until(async () => { const q = (await ctl.readiness()).quality; return !!q && q.seconds >= 2; }, 20_000);
    const r = await ctl.readiness();
    expect(r.quality!.ok).toBe(false);
    expect(r.quality!.problems.join(' ')).toMatch(/congestion/); expect(r.quality!.problems.join(' ')).toMatch(/8,000/); expect(r.quality!.problems.join(' ')).toMatch(/51\.0 fps/);
    expect(r.liveVerifiedAt).toBeUndefined();
    await ctl.stopStream();
  }, 40_000);
});
