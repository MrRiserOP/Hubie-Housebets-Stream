
// ElevenLabs voice provider against the STAND-IN server (tests/fakes/fakeElevenLabs.ts) — proves our code, not ElevenLabs' service.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { ElevenLabsTTS, ElevenLabsError, createVoice, listElevenVoices, pickBestVoice, explainElevenLabsError } from '../../services/tts/src/tts.ts';
import { settingsFor, DEFAULT_SETTINGS, DEFAULT_VOICE_ID } from '../../services/tts/src/voicePersonality.ts';
import { UsageLimiter } from '../../services/ai/src/usage.ts';

let el: Awaited<ReturnType<typeof startFakeElevenLabs>>;
let dir: string;

// Harmless placeholder: this test uses a local fake server, not a real API key.
const TEST_API_KEY = 'test-elevenlabs-placeholder';

const env = (o: Record<string, string> = {}) => ({
  ELEVENLABS_API_KEY: TEST_API_KEY,
  ELEVENLABS_BASE_URL: el.url,
  TTS_TIMEOUT_MS: '5000',
  ...o
});

beforeAll(async () => {
  el = await startFakeElevenLabs();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-test-'));
});

afterAll(async () => {
  await el.close();
});

describe('ElevenLabs synthesis', () => {
  it('POSTs the documented request and returns real MP3', async () => {
    const t = new ElevenLabsTTS(
      env({
        ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
        ELEVENLABS_MODEL: 'eleven_flash_v2_5'
      }),
      new UsageLimiter(0)
    );

    const r = await t.synth({
      id: 'a',
      text: 'Target 2x, rolled 3.5x!',
      tone: 'excited',
      rate: 1
    }, dir);

    expect(r.provider).toBe('elevenlabs');
    expect(
      fs.readFileSync(r.file!).subarray(0, 3).toString('latin1') === 'ID3' ||
      fs.readFileSync(r.file!)[0] === 0xff
    ).toBe(true);

    const q = el.ttsRequests().at(-1)!;

    expect(q.path).toBe('/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
    expect(q.key).toBe(TEST_API_KEY);
    expect(q.body.model_id).toBe('eleven_flash_v2_5');
    expect(q.body.text).toBe('Target 2 times, rolled 3.5 times!');
    expect(q.body.voice_settings).toMatchObject({
      use_speaker_boost: true
    });
  });

  it('caches identical lines (no second API call) and re-generates when settings change', async () => {
    const t = new ElevenLabsTTS(
      env({ ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb' }),
      new UsageLimiter(0)
    );

    const n0 = el.ttsRequests().length;

    await t.synth({
      id: 'c1',
      text: 'Cache me please',
      tone: 'friendly',
      rate: 1
    }, dir);

    const r2 = await t.synth({
      id: 'c2',
      text: 'Cache me please',
      tone: 'friendly',
      rate: 1
    }, dir);

    expect(r2.cached).toBe(true);
    expect(el.ttsRequests().length).toBe(n0 + 1);

    await new ElevenLabsTTS(
      env({
        ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
        ELEVENLABS_STYLE: '0.6'
      }),
      new UsageLimiter(0)
    ).synth({
      id: 'c3',
      text: 'Cache me please',
      tone: 'friendly',
      rate: 1
    }, dir);

    expect(el.ttsRequests().length).toBe(n0 + 2);
  });

  it('per-emotion settings: hype is more expressive than calm, never outside safe ranges', () => {
    const hype = settingsFor(DEFAULT_SETTINGS, 'hyped');
    const calm = settingsFor(DEFAULT_SETTINGS, 'calm');
    const sarc = settingsFor(DEFAULT_SETTINGS, 'sarcastic');

    expect(hype.stability).toBeLessThan(calm.stability);
    expect(hype.style).toBeGreaterThan(calm.style);
    expect(hype.speed).toBeGreaterThan(calm.speed);
    expect(sarc.stability).toBeGreaterThan(DEFAULT_SETTINGS.stability);

    for (const tone of ['hyped', 'sleepy', 'dramatic'] as const) {
      const s = settingsFor(
        { ...DEFAULT_SETTINGS, stability: 0, style: 1, speed: 1.2 },
        tone,
        1.5
      );

      expect(s.stability).toBeGreaterThanOrEqual(0.2);
      expect(s.style).toBeLessThanOrEqual(0.7);
      expect(s.speed).toBeLessThanOrEqual(1.2);
    }
  });

  it('uses the default voice when none is configured', async () => {
    await new ElevenLabsTTS(env(), new UsageLimiter(0)).synth({
      id: 'd',
      text: 'Default voice line',
      tone: 'relaxed',
      rate: 1
    }, dir);

    expect(el.ttsRequests().at(-1)!.path).toContain(DEFAULT_VOICE_ID);
  });

  it('enforces the hourly character cap', async () => {
    const t = new ElevenLabsTTS(
      env({ ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb' }),
      new UsageLimiter(10)
    );

    await expect(
      t.synth({
        id: 'l',
        text: 'This line is longer than ten characters',
        tone: 'relaxed',
        rate: 1
      }, dir)
    ).rejects.toMatchObject({ code: 'usage_limit' });
  });
});

describe('error explanations (readable, never contain the key)', () => {
  const cases: Array<[string, string, string, Record<string, string>?]> = [
    ['invalid_key', 'sk_invalid_xxxxxxxxxxxxxxxxxxxx', 'rejected the API key'],
    ['permissions', 'sk_noperm_xxxxxxxxxxxxxxxxxxxxx', 'lacks a permission'],
    ['quota', 'sk_noquota_xxxxxxxxxxxxxxxxxxxx', 'out of characters'],
    ['voice_not_found', TEST_API_KEY, 'voice ID was not found', {
      ELEVENLABS_VOICE_ID: 'nonexistentvoice0000'
    }]
  ];

  for (const [code, key, text, extra] of cases) {
    it(`maps → ${code}`, async () => {
      const t = new ElevenLabsTTS(
        env({
          ELEVENLABS_API_KEY: key,
          ...(extra ?? {})
        }),
        new UsageLimiter(0)
      );

      const e: any = await t.synth({
        id: 'x' + code,
        text: 'Fail please ' + code,
        tone: 'relaxed',
        rate: 1
      }, dir).catch((x) => x);

      expect(e).toBeInstanceOf(ElevenLabsError);
      expect(e.code).toBe(code);
      expect(e.message).toContain(text);
      expect(e.message).not.toContain(key);
    });
  }

  it('server errors are retryable, bad keys are not; network/timeouts are explained', async () => {
    el.failNext(1, 500);

    const e: any = await new ElevenLabsTTS(
      env({ ELEVENLABS_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb' }),
      new UsageLimiter(0)
    ).synth({
      id: 'f',
      text: 'Server error line',
      tone: 'relaxed',
      rate: 1
    }, dir).catch((x) => x);

    expect(explainElevenLabsError(e).retryable).toBe(true);
    expect(explainElevenLabsError(new Error('fetch failed')).code).toBe('network');
    expect(
      explainElevenLabsError(
        Object.assign(new Error('x'), { name: 'AbortError' })
      ).code
    ).toBe('timeout');
  });
});

describe('voice list + service wiring', () => {
  it('lists account voices and picks the best match for Hubie', async () => {
    const v = await listElevenVoices(env());

    expect(v.length).toBe(4);
    expect(pickBestVoice(v)!.name).toBe('Charlie');

    expect(
      pickBestVoice([
        { voice_id: 'a', name: 'Robot Gary', category: 'generated' },
        { voice_id: 'b', name: 'Zed', category: 'premade' }
      ])!.voice_id
    ).toBe('b');
  });

  it('invalid keys are caught by the voice list (used as the key test)', async () => {
    await expect(
      listElevenVoices(env({
        ELEVENLABS_API_KEY: 'sk_invalid_xxxxxxxxxxxxxxxxxxxx'
      }))
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('createVoice: ElevenLabs primary with a key, browser otherwise, and a leftover TTS_PROVIDER=openai is ignored', () => {
    expect(createVoice(env(), dir).chain.map((c) => c.name))
      .toEqual(['elevenlabs', 'browser']);

    expect(createVoice({ ELEVENLABS_API_KEY: '' }, dir).chain.map((c) => c.name))
      .toEqual(['browser']);

    expect(
      createVoice({
        TTS_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-whatever-0123456789abcdef'
      }, dir).chain.map((c) => c.name)
    ).toEqual(['browser']);
  });

  it('a failing ElevenLabs falls back to the browser voice and says so (never pretends)', async () => {
    const v = createVoice(
      env({ ELEVENLABS_API_KEY: 'sk_invalid_xxxxxxxxxxxxxxxxxxxx' }),
      dir
    );

    const r = await v.synth({
      id: 'fb',
      text: 'Fallback please',
      tone: 'relaxed',
      rate: 1
    });

    expect(r.provider).toBe('browser');
    expect(r.browserSpeech).toBe(true);
    expect(v.lastErrorCode).toBe('invalid_key');
  });
});
