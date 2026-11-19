/**
 * Server-side configuration store backed by the .env file.
 *  - The setup wizard writes here; secrets never leave the server.
 *  - Writes are atomic (tmp + rename) and the file is chmod 600.
 *  - publicConfig() returns non-secret values plus MASKED secrets only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE } from './node.ts';

export const SECRET_KEYS = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'KICK_CLIENT_SECRET',
  'OBS_WS_PASSWORD', 'OBS_STREAM_KEY', 'CONTROL_TOKEN', 'OVERLAY_TOKEN',
]);

/** Keys the wizard is allowed to write. Anything else is rejected. */
export const WRITABLE_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'LLM_PROVIDER', 'TTS_PROVIDER',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL', 'ELEVENLABS_STABILITY', 'ELEVENLABS_SIMILARITY', 'ELEVENLABS_STYLE', 'ELEVENLABS_SPEED', 'ELEVENLABS_SPEAKER_BOOST', 'ELEVENLABS_MAX_CHARS_PER_HOUR',
  'KICK_ENABLED', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'KICK_WEBHOOK_URL', 'KICK_TUNNEL', 'KICK_AUTO_MODERATE', 'KICK_REDIRECT_URI',
  'OBS_ENABLED', 'OBS_WS_URL', 'OBS_WS_PASSWORD', 'OBS_STREAM_SERVER', 'OBS_STREAM_KEY', 'OBS_AUTOSTART_STREAM',
  'STREAM_MODE', 'OVERLAY_TOKEN', 'GAME_ADAPTER', 'SHOW_TITLE', 'SETUP_DONE', 'ALLOW_TEST_CHAT',
  'OPENAI_MAX_LLM_CALLS_PER_HOUR',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'LLM_FALLBACK', 'AI_MAX_CALLS_PER_HOUR',
  'GAME_FALLBACK_TO_SIM',
  'APPEARANCE_JSON',
]);

export function mask(v: string | undefined): string {
  if (!v) return '';
  // never any part of the secret itself — not even the last characters (screenshots, screen shares)
  const kind = /^sk-ant-/.test(v) ? 'sk-ant-' : /^sk_/.test(v) ? 'sk_' : /^sk-/.test(v) ? 'sk-' : /^live_/.test(v) ? 'live_' : '';
  return `${kind}••••••••`;
}

/** Parse KEY=VALUE lines, preserving everything else. */
export function readEnvFile(file = ENV_FILE): { lines: string[]; values: Record<string, string> } {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const values: Record<string, string> = {};
  for (const l of lines) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) values[m[1]] = unquote(m[2]);
  }
  return { lines, values };
}

function unquote(v: string) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
function quote(v: string) {
  return /[\s#"'=]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

export function sanitizeValue(key: string, v: unknown): string {
  const s = String(v ?? '').replace(/[\r\n]/g, '').trim();
  if (s.length > 2000) throw new Error(`${key} is too long`);
  return s;
}

/** Update keys in the env file + process.env. Returns the keys actually changed. */
export function writeEnv(updates: Record<string, unknown>, file = ENV_FILE): string[] {
  const { lines, values } = readEnvFile(file);
  const changed: string[] = [];
  const out = [...lines];
  for (const [k, raw] of Object.entries(updates)) {
    if (!WRITABLE_KEYS.has(k)) throw new Error(`setting ${k} cannot be changed from the wizard`);
    const v = sanitizeValue(k, raw);
    const current = values[k] ?? process.env[k] ?? '';
    if (current === v) continue; // already in effect — no write, no needless restarts
    changed.push(k);
    const idx = out.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    const line = `${k}=${quote(v)}`;
    if (idx >= 0) out[idx] = line; else out.push(line);
    process.env[k] = v;
  }
  if (!changed.length) return changed;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return changed;
}

/** Everything the wizard UI may see. Secrets are masked; raw values are never included. */
export function publicConfig(): Record<string, { value: string; secret: boolean; set: boolean }> {
  const out: Record<string, { value: string; secret: boolean; set: boolean }> = {};
  for (const k of WRITABLE_KEYS) {
    const v = process.env[k] ?? '';
    const secret = SECRET_KEYS.has(k);
    out[k] = { value: secret ? mask(v) : v, secret, set: !!v };
  }
  return out;
}
