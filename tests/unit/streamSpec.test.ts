import { describe, it, expect } from 'vitest';
import { KICK_1080P60, OBS_PROFILE_PARAMS, evaluateVideo, evaluateProfile, judgeQuality } from '../../packages/shared/src/streamSpec.ts';

const applied = (over: Record<string, string> = {}) => { const m = new Map(OBS_PROFILE_PARAMS.map(([c, n, v]) => [`${c}/${n}`, v])); for (const [k, v] of Object.entries(over)) m.set(k, v); return (c: string, n: string) => m.get(`${c}/${n}`); };

describe('Kick 1080p60 spec', () => {
  it('stays inside Kick\'s published limits', () => {
    expect(KICK_1080P60.videoKbps).toBeLessThanOrEqual(8000);
    expect(KICK_1080P60.keyint / KICK_1080P60.fps).toBe(KICK_1080P60.keyframeSec);
    expect(KICK_1080P60.sampleRate).toBeLessThanOrEqual(48000);
    expect(KICK_1080P60.encoder).toBe('x264');
  });
  it('accepts the settings Hubie writes', () => {
    expect(evaluateProfile(applied()).filter((c) => !c.ok)).toEqual([]);
    expect(evaluateVideo({ baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }).every((c) => c.ok)).toBe(true);
  });
  it('rejects what Kick rejects or what is silently wrong', () => {
    const bad = (o: Record<string, string>) => evaluateProfile(applied(o)).filter((c) => !c.ok).map((c) => c.name);
    expect(bad({ 'SimpleOutput/VBitrate': '9000' })).toContain('Video bitrate (Kick max 8,000 kbps)');
    expect(bad({ 'SimpleOutput/StreamEncoder': 'hevc' })).toContain('Encoder (Kick: H.264 only)');
    expect(bad({ 'SimpleOutput/x264Settings': 'tune=zerolatency' })).toContain('Keyframe interval (Kick: 2 s)');
    expect(bad({ 'SimpleOutput/x264Settings': 'keyint=250 profile=main tune=zerolatency' })).toContain('Keyframe interval (Kick: 2 s)');
    expect(bad({ 'Audio/SampleRate': '96000' })).toContain('Audio sample rate (Kick: ≤ 48 kHz)');
    expect(bad({ 'Output/Mode': 'Advanced' })).toContain('Output mode');
    expect(evaluateVideo({ baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 }).filter((c) => !c.ok)).toHaveLength(3);
    expect(evaluateVideo(null)[0].ok).toBe(false);
  });
  it('judges measurements: 60 fps healthy passes; 42 fps, skipped frames, congestion or >8000 kbps fail with a reason', () => {
    const ok = { at: 1, streaming: true, fps: 59.9, kbps: 6100, congestionPct: 2, renderSkippedPct: 0, encodeSkippedPct: 0, cpu: 30, seconds: 90 };
    expect(judgeQuality(ok).ok).toBe(true);
    expect(judgeQuality({ ...ok, fps: 42 }).problems[0]).toMatch(/42\.0 fps, not 60/);
    expect(judgeQuality({ ...ok, encodeSkippedPct: 3 }).problems[0]).toMatch(/encoder/);
    expect(judgeQuality({ ...ok, renderSkippedPct: 2 }).ok).toBe(false);
    expect(judgeQuality({ ...ok, congestionPct: 60 }).problems[0]).toMatch(/congestion/);
    expect(judgeQuality({ ...ok, kbps: 9000 }).problems[0]).toMatch(/8,000/);
  });
});
