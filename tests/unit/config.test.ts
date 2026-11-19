/** Secure API key storage for the setup wizard. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEnv, readEnvFile, publicConfig, mask } from '../../packages/shared/src/config.ts';
import { redact } from '../../packages/shared/src/node.ts';

const KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';

describe('config store', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-env-')), '.env');
  fs.writeFileSync(file, '# comment stays\nSHOW_TITLE=Old\nOTHER=1\n');
  it('writes keys server-side with 600 permissions, keeping other lines', () => {
    const changed = writeEnv({ OPENAI_API_KEY: KEY, SHOW_TITLE: "Hubie's Night" }, file);
    expect(changed.sort()).toEqual(['OPENAI_API_KEY', 'SHOW_TITLE']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# comment stays');
    expect(text).toContain('OTHER=1');
    expect(readEnvFile(file).values.OPENAI_API_KEY).toBe(KEY);
    expect(readEnvFile(file).values.SHOW_TITLE).toBe("Hubie's Night");
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('never exposes the raw key — only masked', () => {
    process.env.OPENAI_API_KEY = KEY;
    const pub = JSON.stringify(publicConfig());
    expect(pub).not.toContain(KEY);
    expect(publicConfig().OPENAI_API_KEY).toEqual({ value: mask(KEY), secret: true, set: true });
    expect(mask(KEY)).toBe('sk-••••••••');
    expect(mask(KEY)).not.toContain(KEY.slice(-4));
  });
  it('rejects keys the wizard may not write and strips newlines (no env injection)', () => {
    expect(() => writeEnv({ NODE_OPTIONS: '--inspect' }, file)).toThrow();
    writeEnv({ SHOW_TITLE: 'A\nOPENAI_API_KEY=evil' }, file);
    expect(readEnvFile(file).values.OPENAI_API_KEY).toBe(KEY);
  });
  it('log redaction hides the key', () => {
    process.env.OPENAI_API_KEY = KEY;
    expect(redact(`calling with ${KEY}`)).not.toContain(KEY);
    expect(redact('sk-anotherkey1234567890')).not.toContain('anotherkey');
  });
});
