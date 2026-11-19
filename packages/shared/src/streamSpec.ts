/**
 * Kick's published OBS requirements (help.kick.com "Stream settings / OBS") for a 1080p60 stream, and the checks Hubie runs
 * against what OBS actually reports. Nothing here claims a stream works — it only compares settings and measurements.
 *
 * Kick limits: H.264 only · CBR only · max 8,000 kbps · max 1920×1080 · max 60 fps · keyframe interval 2 s · stereo audio ≤ 48 kHz.
 * Recommended for 1080p60: 6,000–8,000 kbps (viewer upload ≥ 2× bitrate). x264: veryfast, profile main, tune zerolatency.
 */
export const KICK_1080P60 = {
  width: 1920, height: 1080, fps: 60,
  videoKbps: 6000, maxKbps: 8000, audioKbps: 160, sampleRate: 48000,
  keyframeSec: 2, keyint: 120, // 2 s × 60 fps
  encoder: 'x264', preset: 'veryfast', profile: 'main', tune: 'zerolatency',
  x264Opts: 'keyint=120 profile=main tune=zerolatency',
} as const;

/** OBS profile parameters (basic.ini) written through obs-websocket SetProfileParameter. Simple output mode, x264, CBR. */
export const OBS_PROFILE_PARAMS: Array<[category: string, name: string, value: string]> = [
  ['Output', 'Mode', 'Simple'],
  ['SimpleOutput', 'StreamEncoder', 'x264'],
  ['SimpleOutput', 'VBitrate', String(KICK_1080P60.videoKbps)],
  ['SimpleOutput', 'ABitrate', String(KICK_1080P60.audioKbps)],
  ['SimpleOutput', 'UseAdvanced', 'true'],
  ['SimpleOutput', 'Preset', KICK_1080P60.preset],
  ['SimpleOutput', 'x264Settings', KICK_1080P60.x264Opts],
  ['SimpleOutput', 'RecQuality', 'Stream'],
  ['Audio', 'SampleRate', String(KICK_1080P60.sampleRate)],
  ['Audio', 'ChannelSetup', 'Stereo'],
];

export interface Check { name: string; want: string; got: string; ok: boolean }
export interface VideoReadback { baseWidth: number; baseHeight: number; outputWidth: number; outputHeight: number; fpsNumerator: number; fpsDenominator: number }

export function evaluateVideo(v: VideoReadback | null): Check[] {
  if (!v) return [{ name: 'Video settings', want: '1920×1080 @ 60 fps', got: 'unreadable', ok: false }];
  const fps = v.fpsNumerator / (v.fpsDenominator || 1);
  return [
    { name: 'Canvas (base) resolution', want: '1920×1080', got: `${v.baseWidth}×${v.baseHeight}`, ok: v.baseWidth === 1920 && v.baseHeight === 1080 },
    { name: 'Output (scaled) resolution', want: '1920×1080', got: `${v.outputWidth}×${v.outputHeight}`, ok: v.outputWidth === 1920 && v.outputHeight === 1080 },
    { name: 'Frame rate', want: '60 fps', got: `${Math.round(fps * 100) / 100} fps`, ok: Math.abs(fps - 60) < 0.01 },
  ];
}

/** `get` returns the stored profile value for (category, name), or undefined when unreadable. */
export function evaluateProfile(get: (c: string, n: string) => string | undefined): Check[] {
  const g = (c: string, n: string) => get(c, n) ?? '(not set)';
  const mode = g('Output', 'Mode'), enc = g('SimpleOutput', 'StreamEncoder'), vb = Number(g('SimpleOutput', 'VBitrate'));
  const x264 = g('SimpleOutput', 'x264Settings'), adv = g('SimpleOutput', 'UseAdvanced');
  const sr = Number(g('Audio', 'SampleRate')), ch = g('Audio', 'ChannelSetup');
  const out: Check[] = [
    { name: 'Output mode', want: 'Simple', got: mode, ok: mode === 'Simple' },
    { name: 'Encoder (Kick: H.264 only)', want: 'x264 (H.264)', got: enc, ok: enc === 'x264' || /^(obs_)?x264$/.test(enc) },
    { name: 'Video bitrate (Kick max 8,000 kbps)', want: `${KICK_1080P60.videoKbps} kbps (6,000–8,000)`, got: Number.isFinite(vb) ? `${vb} kbps` : String(g('SimpleOutput', 'VBitrate')), ok: Number.isFinite(vb) && vb >= 4500 && vb <= KICK_1080P60.maxKbps },
    { name: 'Rate control (Kick: CBR only)', want: 'CBR', got: mode === 'Simple' ? 'CBR (Simple mode always uses CBR)' : 'depends on Advanced settings', ok: mode === 'Simple' },
    { name: 'Keyframe interval (Kick: 2 s)', want: 'keyint=120 at 60 fps', got: /keyint=(\d+)/.exec(x264)?.[0] ?? '(default — about 4 s)', ok: adv === 'true' && /keyint=120\b/.test(x264) },
    { name: 'x264 profile / tune', want: 'main · zerolatency', got: x264, ok: /profile=main/.test(x264) && /tune=zerolatency/.test(x264) },
    { name: 'x264 CPU preset', want: 'veryfast', got: g('SimpleOutput', 'Preset'), ok: g('SimpleOutput', 'Preset') === 'veryfast' },
    { name: 'Audio sample rate (Kick: ≤ 48 kHz)', want: '48000 Hz', got: `${sr} Hz`, ok: sr > 0 && sr <= 48000 },
    { name: 'Audio channels', want: 'Stereo', got: ch, ok: ch === 'Stereo' },
  ];
  return out;
}

export interface QualitySample { at: number; streaming: boolean; fps: number; kbps: number; congestionPct: number; renderSkippedPct: number; encodeSkippedPct: number; cpu: number; seconds: number }
/** Judge a measured window. Only a window measured on the real output counts as "verified". */
export function judgeQuality(q: QualitySample): { ok: boolean; problems: string[] } {
  const p: string[] = [];
  if (q.fps < 58) p.push(`OBS is rendering ${q.fps.toFixed(1)} fps, not 60 (lower the CPU load or use a hardware encoder)`);
  if (q.streaming && q.congestionPct >= 20) p.push(`OBS reports ${q.congestionPct.toFixed(0)}% network congestion toward Kick (upload too slow or unstable — lower the bitrate by 1,000 kbps)`);
  if (q.renderSkippedPct >= 1) p.push(`${q.renderSkippedPct.toFixed(1)}% of frames were skipped by OBS rendering (GPU/CPU too busy)`);
  if (q.encodeSkippedPct >= 1) p.push(`${q.encodeSkippedPct.toFixed(1)}% of frames were skipped by the encoder (CPU too slow for x264 veryfast at 1080p60 — try a hardware encoder)`);
  if (q.kbps > KICK_1080P60.maxKbps * 1.05) p.push(`bitrate ${Math.round(q.kbps)} kbps is above Kick's 8,000 kbps limit`);
  return { ok: p.length === 0, problems: p };
}
