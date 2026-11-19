/**
 * Tunnel manager — gives Kick a public HTTPS address for chat webhooks without any terminal work.
 *
 * Runs Cloudflare's free "quick tunnel" (`cloudflared tunnel --url …`, no account) as a child of the controller, so it
 * keeps running when the Kick agent reloads. It:
 *   - finds cloudflared (CLOUDFLARED_PATH, data/bin, PATH) or downloads the official release from github.com/cloudflare/cloudflared
 *   - reads the https://….trycloudflare.com address from its output
 *   - restarts it with back-off if it exits, and reports when the address CHANGED (Kick must then be updated)
 *   - probes the address from outside the process (GET …/kick/webhook) so "reachable" is a measured fact
 *
 * Quick-tunnel addresses change every time cloudflared restarts. That is a Cloudflare property, not something Hubie can hide;
 * the wizard shows the change and asks for the new address to be pasted into the Kick app again. The VPS install uses a
 * stable address instead.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type TunnelState = 'off' | 'installing' | 'starting' | 'running' | 'error';
export interface TunnelStatus {
  state: TunnelState; detail: string; url?: string; webhookUrl?: string;
  /** probe result of GET <url>/kick/webhook */
  reachable?: boolean; reachableAt?: number; reachableError?: string;
  restarts: number; binary?: string; changedFrom?: string; startedAt?: number;
}
interface Opts {
  dataDir: string; port: () => number; log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
  onChange: (s: TunnelStatus) => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function cloudflaredAsset(platform = process.platform, arch = process.arch): { file: string; tgz: boolean } | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!a) return null;
  if (platform === 'win32') return { file: `cloudflared-windows-${a}.exe`, tgz: false };
  if (platform === 'linux') return { file: `cloudflared-linux-${a}`, tgz: false };
  if (platform === 'darwin') return { file: `cloudflared-darwin-${a}.tgz`, tgz: true };
  return null;
}

export class TunnelManager {
  private proc?: ChildProcess;
  private wanted = false;
  private timer?: NodeJS.Timeout;
  private probeTimer?: NodeJS.Timeout;
  private backoff = 3000;
  private s: TunnelStatus = { state: 'off', detail: 'Tunnel is off.', restarts: 0 };
  private lastUrl?: string;
  private stateFile: string;
  constructor(private o: Opts) {
    this.stateFile = path.join(o.dataDir, 'tunnel.json');
    try { this.lastUrl = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).url; } catch { /* first run */ }
    process.on('exit', () => this.killNow());
  }
  status(): TunnelStatus { return { ...this.s }; }
  private set(p: Partial<TunnelStatus>) { this.s = { ...this.s, ...p }; this.o.onChange(this.status()); }

  /* ---------- binary ---------- */
  private binDir() { return path.join(this.o.dataDir, 'bin'); }
  private localBinary() { return path.join(this.binDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'); }
  private runs(bin: string): Promise<boolean> {
    return new Promise((res) => execFile(bin, ['--version'], { timeout: 15_000, windowsHide: true }, (e) => res(!e)));
  }
  async findBinary(): Promise<string | null> {
    const cands = [process.env.CLOUDFLARED_PATH, this.localBinary(), 'cloudflared'].filter(Boolean) as string[];
    for (const c of cands) { if (await this.runs(c)) return c; }
    return null;
  }
  /** Official release download (free). Verified only by running `--version`; Cloudflare does not publish a signature file next to the binary. */
  async install(): Promise<string> {
    const asset = cloudflaredAsset();
    if (!asset) throw new Error(`There is no official cloudflared download for ${process.platform}/${process.arch}. Install it from developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and set CLOUDFLARED_PATH.`);
    this.set({ state: 'installing', detail: 'Downloading cloudflared (free, from Cloudflare’s official GitHub release)…' });
    const base = process.env.CLOUDFLARED_DOWNLOAD_BASE || 'https://github.com/cloudflare/cloudflared/releases/latest/download';
    const res = await fetch(`${base}/${asset.file}`, { redirect: 'follow' }).catch((e) => { throw new Error(`Could not download cloudflared (${(e as Error).message}). Check the internet connection or install it manually.`); });
    if (!res.ok) throw new Error(`Cloudflare's download returned ${res.status}. Try again in a minute or install cloudflared manually.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000 && !process.env.CLOUDFLARED_DOWNLOAD_BASE) throw new Error('The cloudflared download was incomplete. Try again.');
    fs.mkdirSync(this.binDir(), { recursive: true });
    const dest = this.localBinary();
    if (asset.tgz) {
      const tgz = path.join(this.binDir(), asset.file);
      fs.writeFileSync(tgz, buf);
      await new Promise<void>((ok, bad) => execFile('tar', ['-xzf', tgz, '-C', this.binDir()], (e) => (e ? bad(new Error(`Could not unpack cloudflared: ${e.message}`)) : ok())));
      fs.rmSync(tgz, { force: true });
    } else fs.writeFileSync(dest, buf);
    try { fs.chmodSync(dest, 0o755); } catch { /* windows */ }
    if (!(await this.runs(dest))) { fs.rmSync(dest, { force: true }); throw new Error('The downloaded cloudflared did not start (it was removed). Install it manually and set CLOUDFLARED_PATH.'); }
    this.o.log.info(`cloudflared installed at ${dest}`);
    return dest;
  }

  /* ---------- lifecycle ---------- */
  async start(): Promise<void> {
    this.wanted = true;
    if (this.proc || this.s.state === 'installing') return;
    let bin = await this.findBinary();
    if (!bin) {
      try { bin = await this.install(); }
      catch (e) { this.set({ state: 'error', detail: (e as Error).message, url: undefined, webhookUrl: undefined }); this.schedule(30_000); return; }
    }
    this.spawn(bin);
  }
  private spawn(bin: string) {
    this.set({ state: 'starting', detail: 'Starting the public address…', binary: bin, reachable: undefined, reachableError: undefined });
    let p: ChildProcess;
    try { p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.o.port()}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { this.set({ state: 'error', detail: `Could not start cloudflared: ${(e as Error).message}` }); this.schedule(); return; }
    this.proc = p;
    const onData = (b: Buffer) => {
      const m = b.toString().match(URL_RE);
      if (!m || this.s.url === m[0]) return;
      const changedFrom = this.lastUrl && this.lastUrl !== m[0] ? this.lastUrl : undefined;
      this.lastUrl = m[0];
      try { fs.mkdirSync(this.o.dataDir, { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify({ url: m[0], at: Date.now() })); } catch { /* ignore */ }
      this.backoff = 3000;
      this.o.log.info(`public webhook address ready: ${m[0]}/kick/webhook${changedFrom ? ' (CHANGED)' : ''}`);
      this.set({ state: 'running', detail: 'Public address is up.', url: m[0], webhookUrl: `${m[0]}/kick/webhook`, startedAt: Date.now(), changedFrom });
      this.probe(true);
    };
    p.stdout?.on('data', onData); p.stderr?.on('data', onData);
    p.on('error', (e) => { this.proc = undefined; this.set({ state: 'error', detail: `cloudflared could not run: ${e.message}`, url: undefined, webhookUrl: undefined }); this.schedule(); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.o.log.warn(`cloudflared exited (${code})`);
      if (this.wanted) { this.set({ state: 'error', detail: `The public address stopped (code ${code}); restarting…`, url: undefined, webhookUrl: undefined, reachable: undefined, restarts: this.s.restarts + 1 }); this.schedule(); }
    });
  }
  private schedule(ms?: number) {
    if (!this.wanted) return;
    clearTimeout(this.timer);
    const d = ms ?? this.backoff; this.backoff = Math.min(this.backoff * 2, 60_000);
    this.timer = setTimeout(() => { this.timer = undefined; if (this.wanted && !this.proc) void this.start(); }, d);
    this.timer.unref?.();
  }
  stop() {
    this.wanted = false; clearTimeout(this.timer); clearTimeout(this.probeTimer); this.killNow();
    this.set({ state: 'off', detail: 'Tunnel is off.', url: undefined, webhookUrl: undefined, reachable: undefined });
  }
  private killNow() { const p = this.proc; this.proc = undefined; try { p?.kill(); } catch { /* gone */ } }

  /* ---------- measured reachability ---------- */
  /** New quick-tunnel names take a little while to resolve, so retry for ~2 min before calling it unreachable. */
  probe(retry = false, attempt = 0) {
    clearTimeout(this.probeTimer);
    const url = this.s.url; if (!url) return;
    const target = process.env.KICK_TUNNEL_PROBE_BASE ? `${process.env.KICK_TUNNEL_PROBE_BASE}/kick/webhook` : `${url}/kick/webhook`;
    fetch(target, { signal: AbortSignal.timeout(8000) })
      .then(async (r) => {
        const t = await r.text();
        if (r.ok && /Hubie Kick webhook is reachable/.test(t)) { if (this.s.url === url) this.set({ reachable: true, reachableAt: Date.now(), reachableError: undefined }); return; }
        throw new Error(`answered ${r.status}${r.ok ? ' but not from Hubie’s Kick listener (is the Kick agent running?)' : ''}`);
      })
      .catch((e) => {
        if (this.s.url !== url) return;
        if (retry && attempt < 12) { this.probeTimer = setTimeout(() => this.probe(true, attempt + 1), 10_000); this.probeTimer.unref?.(); return; }
        this.set({ reachable: false, reachableAt: Date.now(), reachableError: (e as Error).message });
      });
  }
}
