/** Shared helpers for the E2E / failure-injection runners. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../packages/shared/src/node.ts';

export const PORT = Number(process.env.E2E_PORT || 8799);
export const BASE = `http://127.0.0.1:${PORT}`;
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-e2e-'));

export const ENV_FILE = path.join(TMP, 'test.env');
fs.writeFileSync(ENV_FILE, '# e2e env file (wizard writes here)\n', { mode: 0o600 });

export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HUBIE_ENV_FILE: ENV_FILE, HUBIE_DATA_DIR: path.join(TMP, 'data'), AUTO_START: 'true', SETUP_DONE: 'true', BROWSER_EXECUTABLE_PATH: process.env.BROWSER_EXECUTABLE_PATH ?? '',
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', ELEVENLABS_API_KEY: '', ELEVENLABS_BASE_URL: '', ELEVENLABS_VOICE_ID: '', LLM_PROVIDER: '', TTS_PROVIDER: '', ANTHROPIC_API_KEY: '', OBS_STREAM_KEY: '', OBS_STREAM_SERVER: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '', KICK_CHANNEL: '',
    CONTROLLER_PORT: String(PORT), HUB_URL: `ws://127.0.0.1:${PORT}/hub`, HUBIE_DB: path.join(TMP, 'hubie.db'),
    TTS_FALLBACKS: 'browser', GAME_ADAPTER: 'limbo-sim',
    ROUND_INTERVAL_SEC: '2', ALLOW_TEST_CHAT: 'true', KICK_ENABLED: 'false', OBS_ENABLED: 'false',
    CONTROL_TOKEN: '', GAME_HEADLESS: 'true', ...extra,
  };
}

const children = new Set<ChildProcess>();
let stopping = false;
export const stopAll = () => { stopping = true; killAll(); };
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
process.on('uncaughtException', (e) => { console.error(e); killAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); killAll(); process.exit(1); });

export function startProc(name: string, entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  const log = fs.createWriteStream(path.join(TMP, `${name}.log`), { flags: 'a' });
  const p = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', path.join(ROOT, entry)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.pipe(log); p.stderr!.pipe(log);
  children.add(p);
  // behave like the supervisor: a clean exit(0) is a planned reload → restart
  p.on('exit', (code) => { children.delete(p); if (code === 0 && !stopping) setTimeout(() => startProc(name, entry, env), 500); });
  return p;
}

export async function api(p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

export async function waitFor<T>(label: string, fn: () => Promise<T | undefined | false | null>, timeoutMs = 30_000, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (${(lastErr as Error).message})` : ''}`);
}

export const health = () => api('/api/health');
export const comp = async (name: string) => ((await health()).components as any[]).find((c) => c.name === name);
export const control = (action: string, payload: Record<string, unknown> = {}) => api('/api/control', { action, payload });

export function logTail(name: string, n = 30) {
  try { return fs.readFileSync(path.join(TMP, `${name}.log`), 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; }
}

export interface Result { name: string; status: 'PASS' | 'FAIL' | 'NOT TESTED'; detail: string }
export class Reporter {
  results: Result[] = [];
  async run(name: string, fn: () => Promise<string>) {
    const t0 = Date.now();
    try {
      const d = await fn();
      this.results.push({ name, status: 'PASS', detail: `${d} (${((Date.now() - t0) / 1000).toFixed(1)}s)` });
      console.log(`  ✔ ${name} — ${d}`);
    } catch (e) {
      this.results.push({ name, status: 'FAIL', detail: (e as Error).message });
      console.log(`  ✘ ${name} — ${(e as Error).message}`);
    }
  }
  skip(name: string, why: string) { this.results.push({ name, status: 'NOT TESTED', detail: why }); console.log(`  – ${name} — NOT TESTED: ${why}`); }
  markdown(title: string) {
    const rows = this.results.map((r) => `| ${r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚪'} ${r.status} | ${r.name} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    return `## ${title}\n\nRun at ${new Date().toISOString()} on ${os.platform()} ${os.release()}, Node ${process.version}\n\n| Result | Test | Detail |\n|---|---|---|\n${rows.join('\n')}\n`;
  }
  get failed() { return this.results.filter((r) => r.status === 'FAIL').length; }
}
