/** Node-only helpers shared by all processes: config, logging, hub client, backoff. */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { decode, encode, type ClientRole, type ComponentName, type HealthState, type HubMessage } from './protocol.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The .env file is written by the setup wizard. Under the supervisor/PM2
 * (HUBIE_SUPERVISED=1) it is the single source of truth and overrides inherited
 * values, so a restarted process picks up wizard changes. Run directly from a
 * shell, explicitly exported variables win.
 */
/** Runtime data (DB, tokens, caches, ESTOP flag). Override with HUBIE_DATA_DIR (tests use a temp dir). */
export const DATA_DIR = process.env.HUBIE_DATA_DIR ? path.resolve(process.env.HUBIE_DATA_DIR) : path.join(ROOT, 'data');
export const ENV_FILE = process.env.HUBIE_ENV_FILE || path.join(ROOT, '.env');
dotenv.config({ path: ENV_FILE, override: process.env.HUBIE_SUPERVISED === '1', quiet: true } as dotenv.DotenvConfigOptions);

export function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
export function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
}
export function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const CONTROLLER_PORT = envNum('CONTROLLER_PORT', 8787);
export const HUB_URL = env('HUB_URL', `ws://127.0.0.1:${CONTROLLER_PORT}/hub`);

/* ---------- logging (stdout + rotating-ish file) ---------- */
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /oauth:[a-z0-9]{10,}/gi,
  /(?<=(api[_-]?key|token|secret|password)["'=:\s]+)[A-Za-z0-9._-]{8,}/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  // also redact any literal env secret values
  for (const k of Object.keys(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(k)) {
      const v = process.env[k];
      if (v && v.length >= 8) out = out.split(v).join('[REDACTED]');
    }
  }
  return out;
}

export function makeLogger(name: string) {
  const file = path.join(LOG_DIR, `${name}.log`);
  const write = (level: string, msg: string, extra?: unknown) => {
    const line = `${new Date().toISOString()} [${name}] ${level.toUpperCase()} ${redact(msg)}${extra !== undefined ? ' ' + redact(safeJson(extra)) : ''}`;
    (level === 'error' ? console.error : console.log)(line);
    try {
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      if (st && st.size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, line + '\n');
    } catch { /* never crash on logging */ }
  };
  return {
    info: (m: string, e?: unknown) => write('info', m, e),
    warn: (m: string, e?: unknown) => write('warn', m, e),
    error: (m: string, e?: unknown) => write('error', m, e),
  };
}
export type Logger = ReturnType<typeof makeLogger>;

function safeJson(x: unknown): string {
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  try { return JSON.stringify(x); } catch { return String(x); }
}

/* ---------- backoff ---------- */
export class Backoff {
  private attempt = 0;
  constructor(private baseMs = 1000, private maxMs = 30000, private maxAttempts = Infinity) {}
  next(): number | null {
    if (this.attempt >= this.maxAttempts) return null;
    const d = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt++;
    return Math.round(d);
  }
  reset() { this.attempt = 0; }
  get attempts() { return this.attempt; }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- hub client with auto-reconnect ---------- */
export class HubClient {
  private ws: WebSocket | null = null;
  private backoff = new Backoff(500, 10000);
  private handlers: Array<(m: HubMessage) => void> = [];
  private queue: string[] = [];
  private closed = false;
  private hbTimer: NodeJS.Timeout | null = null;
  public connected = false;

  constructor(private role: ClientRole, private log: Logger, private url = HUB_URL) {}

  start() { this.connect(); return this; }

  on(fn: (m: HubMessage) => void) { this.handlers.push(fn); }

  send(m: HubMessage) {
    const s = encode(m);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (m.type !== 'game_frame' && m.type !== 'heartbeat') {
      this.queue.push(s);
      if (this.queue.length > 200) this.queue.shift();
    }
  }

  heartbeat(component: ComponentName, state: HealthState, detail?: string) {
    this.send({ type: 'heartbeat', role: this.role, component, state, detail });
  }

  close() { this.closed = true; this.ws?.close(); if (this.hbTimer) clearInterval(this.hbTimer); }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff.reset();
      this.log.info(`connected to hub ${this.url}`);
      ws.send(encode({ type: 'hello', role: this.role }));
      while (this.queue.length) ws.send(this.queue.shift()!);
    });
    ws.on('message', (raw) => {
      const m = decode(raw.toString());
      if (m) for (const h of this.handlers) { try { h(m); } catch (e) { this.log.error('handler error', e); } }
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.closed) return;
      const d = this.backoff.next() ?? 10000;
      this.log.warn(`hub connection closed; reconnecting in ${d}ms`);
      setTimeout(() => this.connect(), d);
    });
    ws.on('error', (e) => this.log.warn(`hub socket error: ${(e as Error).message}`));
  }
}
