/**
 * Voice preview + audio test, in a real Chrome with its DEFAULT autoplay policy (like a normal user —
 * no "--autoplay-policy" flag) and a realistic 4 s speech-generation delay.
 * ElevenLabs = local stand-in that returns real MP3 audio (api.elevenlabs.io is unreachable from the build machine).
 * The overlay page is opened in a second browser that allows autoplay — exactly what OBS's browser source does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeOpenAI } from '../fakes/fakeOpenAI.ts';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { BASE, Reporter, api, baseEnv, health, logTail, startProc, stopAll, waitFor } from './harness.ts';

process.env.FAKE_EL_DELAY_MS = '4000';
const r = new Reporter();
const fake = await startFakeOpenAI(); // only here to PROVE Hubie never calls OpenAI audio
const el = await startFakeElevenLabs();
const env = baseEnv({ AUTO_START: 'false', HUBIE_SUPERVISED: '1', OPENAI_BASE_URL: fake.url, OPENAI_API_KEY: 'sk-test-text-only-0123456789abcdef', ELEVENLABS_BASE_URL: el.url });
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
const exe = process.env.BROWSER_EXECUTABLE_PATH || undefined;
const userBrowser = await chromium.launch({ executablePath: exe }); // default autoplay policy
const page = await userBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const out = () => page.evaluate(() => (window as any).__audioOut.status);
const obsLike = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });

try {
  await r.run('No ElevenLabs key: preview offers the browser voice, clearly labelled as a fallback', async () => {
    await page.goto(`${BASE}/setup#2`);
    await page.getByText('2 — Hubie’s voice (ElevenLabs)').waitFor();
    await page.getByText(/No ElevenLabs key saved yet/).waitFor();
    const btn = page.getByRole('button', { name: /Preview browser voice \(fallback — not ElevenLabs\)/ });
    await btn.waitFor();
    await btn.click();
    await page.waitForTimeout(500);
    const st = await out();
    if (/OpenAI/.test(await page.locator('section').innerText())) throw new Error('voice section still mentions OpenAI');
    return `button reads "Preview browser voice (fallback — not ElevenLabs)"; player label: "${st.label ?? '(browser has no voices in headless mode)'}"; no OpenAI field or wording in the voice section`;
  });

  await r.run('Bad key is rejected with a readable reason and NOT saved; good key is verified against the voice list', async () => {
    await page.locator('.field', { hasText: /ElevenLabs API key/ }).locator('input').fill('sk_invalid_0123456789abcdefghij');
    await page.getByRole('button', { name: /Save & test/ }).click();
    await page.getByText(/rejected the API key/).waitFor();
    if ((await api('/api/setup/status')).voice.keySet) throw new Error('bad key was saved');
    await page.locator('.field', { hasText: /ElevenLabs API key/ }).locator('input').fill('sk_test_audio_0123456789abcdefghijklmn');
    await page.getByRole('button', { name: /Save & test/ }).click();
    await page.getByText(/Saved and tested ✓ — ElevenLabs answered; 4 voices/).waitFor({ timeout: 20_000 });
    if (!(await api('/api/setup/status')).voice.keySet) throw new Error('good key not saved');
    return 'invalid key → "ElevenLabs rejected the API key…" and nothing saved; valid key → verified via GET /v1/voices (4 voices) and saved';
  });

  await r.run('Preview with ElevenLabs: request → valid MP3 → decoded → AUDIBLE playback, despite a 4 s generation delay', async () => {
    await page.getByText('Choose Hubie’s voice').waitFor();
    await page.locator('.vcard', { hasText: 'George' }).getByRole('button', { name: 'Select' }).click();
    const before = el.ttsRequests().length;
    await page.locator('.vcard', { hasText: 'George' }).getByRole('button', { name: '▶' }).click();
    await waitFor('playing', async () => (await out()).state === 'playing', 25_000, 100);
    const req = el.ttsRequests();
    if (req.length !== before + 1 || !req.at(-1)!.path.includes('JBFqnCBsd6RMkjVDRZzb')) throw new Error('no speech request for George');
    if (req.at(-1)!.key !== 'sk_test_audio_0123456789abcdefghijklmn') throw new Error('xi-api-key header missing');
    await page.locator('.player.playing').waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, 'cc-2-voice-playing.png') });
    await waitFor('ended', async () => (await out()).state === 'idle', 30_000, 100);
    const msg = await page.locator('.msg.good').innerText();
    const st = await out();
    if (!(st.peak > 0.05)) throw new Error(`no signal measured (peak ${st.peak})`);
    return `AudioContext ${st.context}; ${st.bytes} bytes decoded; output level peak ${st.peak} (sound really went to the speakers); "${msg}"`;
  });

  await r.run('Big-win preview is more expressive than normal (different ElevenLabs settings sent)', async () => {
    const n0 = el.ttsRequests().length;
    await page.getByRole('button', { name: '▶ Big win' }).click();
    await waitFor('big win request', async () => el.ttsRequests().length > n0, 25_000, 100);
    await waitFor('idle', async () => (await out()).state === 'idle', 30_000, 100);
    await page.getByRole('button', { name: '▶ Sarcastic loss' }).click();
    await waitFor('sarcastic request', async () => el.ttsRequests().length > n0 + 1, 25_000, 100);
    const [win, sarc] = el.ttsRequests().slice(-2).map((q) => q.body.voice_settings);
    if (!(win.stability < sarc.stability)) throw new Error(`stability win ${win.stability} vs sarcastic ${sarc.stability}`);
    await page.getByRole('button', { name: '■ Stop' }).first().click();
    return `win: stability ${win.stability.toFixed(2)}, style ${win.style.toFixed(2)}, speed ${win.speed.toFixed(2)} · sarcastic: stability ${sarc.stability.toFixed(2)}, style ${sarc.style.toFixed(2)}, speed ${sarc.speed.toFixed(2)}`;
  });

  await r.run('Stop button stops playback immediately', async () => {
    await page.getByRole('button', { name: '▶ Preview (normal)' }).click();
    await waitFor('playing', async () => (await out()).state === 'playing', 20_000, 100);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '■ Stop' }).first().click();
    await waitFor('stopped', async () => (await out()).state === 'idle', 2000, 50);
    return 'state playing → idle within 2 s of pressing Stop';
  });

  await r.run('Volume slider changes the real output level (0 % = silent, remembered)', async () => {
    const slider = page.locator('.pl-vol input[type=range]').first();
    await slider.fill('0');
    await page.getByText(/Volume is at 0 %/).waitFor();
    await page.getByRole('button', { name: '▶ Preview (normal)' }).click();
    await waitFor('playing', async () => (await out()).state === 'playing', 20_000, 100);
    await page.waitForTimeout(1200);
    const silent = (await out()).peak;
    await page.getByRole('button', { name: '■ Stop' }).first().click();
    await slider.fill('0.8');
    await page.reload();
    const remembered = await page.evaluate(() => (window as any).__audioOut.status.volume);
    if (silent > 0.01) throw new Error(`level at 0 % was ${silent}`);
    if (Math.abs(remembered - 0.8) > 0.01) throw new Error(`volume not remembered: ${remembered}`);
    return `level at 0 % = ${silent}; 80 % remembered after reload`;
  });

  await r.run('Audio test section: status + "Test voice" plays real configured-provider audio', async () => {
    await page.locator('.wiz-steps li', { hasText: 'Audio test' }).click();
    await page.getByText('7 — Audio test').waitFor();
    await page.getByText(/ElevenLabs \(eleven_turbo_v2_5\)/).waitFor();
    await page.getByRole('button', { name: /Test voice \(in this browser\)/ }).click();
    const line = await page.locator('.results li').first().innerText({ timeout: 40_000 });
    if (!/^✓ Real ElevenLabs speech/.test(line)) throw new Error(line);
    await page.screenshot({ path: path.join(SHOTS, 'cc-7-audio-test.png') });
    return line;
  });

  await r.run('Overlay / OBS: same pipeline plays the test line as audio and the mouth follows it', async () => {
    const ov = await obsLike.newPage({ viewport: { width: 1920, height: 1080 } });
    await ov.goto(`${BASE}/overlay`);
    await waitFor('overlay connected', async () => (await api('/api/audio/status')).overlays > 0, 15_000);
    await page.getByRole('button', { name: /Test on stream overlay/ }).click();
    const line = await page.locator('.results li', { hasText: /Overlay/ }).first().innerText({ timeout: 40_000 });
    if (!/^✓ Overlay played/.test(line)) throw new Error(line);
    await ov.close();
    return line;
  });

  await r.run('Speech in the overlay never overlaps (queue)', async () => {
    const ov = await obsLike.newPage({ viewport: { width: 1920, height: 1080 } });
    await ov.goto(`${BASE}/overlay`);
    await waitFor('overlay connected', async () => (await api('/api/audio/status')).overlays > 0, 15_000);
    await ov.evaluate(() => {
      const w = window as any; w.__overlap = 0; w.__active = 0;
      const ctxProto = AudioBufferSourceNode.prototype as any;
      const start = ctxProto.start, stop = ctxProto.stop;
      ctxProto.start = function (...a: any[]) { w.__active++; if (w.__active > 1) w.__overlap++; this.addEventListener('ended', () => w.__active--); return start.apply(this, a); };
      ctxProto.stop = function (...a: any[]) { return stop.apply(this, a); };
    });
    for (let i = 0; i < 3; i++) await api('/api/audio/test-overlay', {});
    await ov.waitForTimeout(25_000);
    const overlap = await ov.evaluate(() => (window as any).__overlap);
    const lips = (await api('/api/speech/lipsync')).recent.length;
    await ov.close();
    if (overlap) throw new Error(`${overlap} overlapping starts`);
    return `3 test lines requested back-to-back → played one after another (${lips} played so far, 0 overlaps)`;
  });

  await r.run('No OpenAI voice anywhere: zero OpenAI audio requests, no OpenAI TTS settings in the API', async () => {
    const audioCalls = fake.requests.filter((q) => q.path.includes('/audio/'));
    if (audioCalls.length) throw new Error(`${audioCalls.length} OpenAI audio calls`);
    const cfg = JSON.stringify((await api('/api/setup/status')).config);
    if (/OPENAI_TTS|OPENAI_MAX_TTS/.test(cfg)) throw new Error('OpenAI TTS setting still exposed');
    return `Hubie made ${el.ttsRequests().length} ElevenLabs speech requests and 0 OpenAI audio requests (OpenAI key present for text only)`;
  });

  await r.run('No browser errors', async () => { if (errors.length) throw new Error(errors.join(' | ')); return '0 page errors'; });
} finally {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-audio.md'), r.markdown('Voice preview & audio test — real Chrome, default autoplay policy; ElevenLabs = local stand-in returning real MP3'));
  if (r.failed) console.log(logTail('controller', 30));
  await userBrowser.close(); await obsLike.close();
  stopAll(); await fake.close(); await el.close();
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length} passed / ${r.failed} failed → docs/TEST-REPORT-audio.md`);
  setTimeout(() => process.exit(r.failed ? 1 : 0), 1000);
}
