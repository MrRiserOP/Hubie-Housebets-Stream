import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TunnelManager, cloudflaredAsset } from '../../apps/controller/src/tunnel.ts';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-tun-'));
const wait = async (fn: () => boolean, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
const FAKE = `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('fake'); process.exit(0); }\nconsole.error('https://dl-test-' + Date.now().toString(36) + '.trycloudflare.com');\nsetInterval(()=>{},1<<30);\n`;
const onlyNode = () => { const d = tmp(); fs.symlinkSync(process.execPath, path.join(d, 'node')); return d; };
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('cloudflared download mapping', () => {
  it('uses the official asset names', () => {
    expect(cloudflaredAsset('win32', 'x64')?.file).toBe('cloudflared-windows-amd64.exe');
    expect(cloudflaredAsset('linux', 'arm64')?.file).toBe('cloudflared-linux-arm64');
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ file: 'cloudflared-darwin-arm64.tgz', tgz: true });
    expect(cloudflaredAsset('freebsd', 'x64')).toBeNull();
  });
});

describe('TunnelManager', () => {
  it('downloads cloudflared when it is missing, starts it and reads the address', async () => {
    const srv = http.createServer((q, s) => { s.writeHead(200).end(FAKE); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    process.env.CLOUDFLARED_DOWNLOAD_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
    delete process.env.CLOUDFLARED_PATH;
    const dir = tmp();
    const m = new TunnelManager({ dataDir: dir, port: () => 1, log, onChange: () => {} });
    // 'cloudflared' on PATH may exist on a dev machine; force the download path by pointing PATH nowhere
    process.env.PATH = onlyNode();
    await m.start();
    await wait(() => m.status().state === 'running');
    expect(m.status().webhookUrl).toMatch(/^https:\/\/dl-test-.*\.trycloudflare\.com\/kick\/webhook$/);
    expect(fs.existsSync(path.join(dir, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'))).toBe(true);
    m.stop(); srv.close();
  }, 30000);

  it('reports a clear error (no crash) when the download fails', async () => {
    const srv = http.createServer((q, s) => { s.writeHead(404).end('no'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    process.env.CLOUDFLARED_DOWNLOAD_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
    delete process.env.CLOUDFLARED_PATH; process.env.PATH = onlyNode();
    const m = new TunnelManager({ dataDir: tmp(), port: () => 1, log, onChange: () => {} });
    await m.start();
    expect(m.status().state).toBe('error');
    expect(m.status().detail).toMatch(/download returned 404/);
    m.stop(); srv.close();
  });

  it('restarts after the process dies and flags the address change', async () => {
    const dir = tmp(); const bin = path.join(dir, 'cf'); fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    process.env.CLOUDFLARED_PATH = bin;
    const seen: string[] = []; const changes: Array<string | undefined> = [];
    const m = new TunnelManager({ dataDir: dir, port: () => 1, log, onChange: (s) => { if (s.webhookUrl && !seen.includes(s.webhookUrl)) { seen.push(s.webhookUrl); changes.push(s.changedFrom); } } });
    await m.start(); await wait(() => seen.length === 1);
    process.kill(Number((await import('node:child_process')).execSync(`pgrep -f ${bin} | head -1`).toString().trim()), 'SIGKILL');
    await wait(() => seen.length === 2, 20000);
    expect(seen[1]).not.toBe(seen[0]);
    expect(changes[1]).toBe(seen[0].replace('/kick/webhook', ''));
    expect(m.status().restarts).toBeGreaterThanOrEqual(1);
    m.stop();
  }, 40000);
});
