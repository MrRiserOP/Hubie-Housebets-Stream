/** HTTP server (static overlay, TTS audio, JSON API) + WebSocket hub. */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { decode, encode, type ClientRole, type HubMessage } from '../../../packages/shared/src/protocol.ts';
import type { Logger } from '../../../packages/shared/src/node.ts';

export interface HubClient { ws: WebSocket; role: ClientRole; id: number; audio: boolean; ip: string }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export class Hub {
  clients = new Set<HubClient>();
  private nextId = 1;
  private handlers: Array<(c: HubClient, m: HubMessage) => void> = [];
  private connectHandlers: Array<(c: HubClient) => void> = [];
  private disconnectHandlers: Array<(c: HubClient) => void> = [];
  server: http.Server;
  apiHandlers = new Map<string, (req: http.IncomingMessage, body: any) => Promise<unknown> | unknown>();

  constructor(private opts: { port: number; staticDir: string; ttsDir: string; extraStatic: Record<string, string>; controlToken: () => string; overlayToken?: () => string; rootRedirect?: () => string; log: Logger }) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: this.server, path: '/hub', maxPayload: 4 * 1024 * 1024 });
    wss.on('connection', (ws, req) => {
      // Behind a reverse proxy every client looks like 127.0.0.1; the proxy adds X-Forwarded-For, so such clients are NOT local.
      const forwarded = !!req.headers['x-forwarded-for'];
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const otok = q.get('otoken') ?? '';
      const oexp = this.opts.overlayToken?.() ?? '';
      const full = this.isAuthorized(req.url ?? '', req.socket.remoteAddress ?? '', forwarded);
      const viewer = !!(oexp && otok && safeEqual(otok, oexp));
      if (!full && (forwarded || oexp) && !viewer) { ws.close(1008, 'unauthorized'); return; }
      const c: HubClient = { ws, role: 'overlay', id: this.nextId++, audio: false, ip: req.socket.remoteAddress ?? '' };
      this.clients.add(c);
      ws.on('message', (raw) => {
        const m = decode(raw.toString());
        if (!m) return;
        if (m.type === 'hello') {
          // an overlay-token client is a read-only viewer: it may only act as an overlay/avatar page
          if (!(c as any).authorized && m.role !== 'overlay' && m.role !== 'avatar') { ws.close(1008, 'role not allowed'); return; }
          c.role = m.role;
          // control-type messages from non-local clients require the token in the query string
          this.opts.log.info(`client #${c.id} hello as ${m.role} from ${c.ip}`);
          for (const h of this.connectHandlers) h(c);
          return;
        }
        if (m.type === 'client_info') { c.audio = m.audio; return; }
        for (const h of this.handlers) { try { h(c, m); } catch (e) { this.opts.log.error('hub handler error', e); } }
      });
      ws.on('close', () => { this.clients.delete(c); for (const h of this.disconnectHandlers) { try { h(c); } catch { /* ignore */ } } });
      ws.on('error', () => { /* close follows */ });
      (c as any).authorized = full;
      (c as any).viewerOnly = !full;
    });
  }

  isAuthorized(url: string, ip: string, forwarded = false): boolean {
    const tok = new URL(url, 'http://x').searchParams.get('token');
    const expected = this.opts.controlToken();
    if (expected && tok && safeEqual(tok, expected)) return true;
    return isLocal(ip) && !forwarded;
  }

  listen() {
    return new Promise<void>((resolve) => this.server.listen(this.opts.port, '0.0.0.0', () => resolve()));
  }

  on(fn: (c: HubClient, m: HubMessage) => void) { this.handlers.push(fn); }
  onConnect(fn: (c: HubClient) => void) { this.connectHandlers.push(fn); }
  onDisconnect(fn: (c: HubClient) => void) { this.disconnectHandlers.push(fn); }

  send(c: HubClient, m: HubMessage) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(encode(m));
  }

  broadcast(m: HubMessage, roles?: ClientRole[]) {
    const s = encode(m);
    for (const c of this.clients) {
      if (roles && !roles.includes(c.role)) continue;
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      // drop video frames for slow clients instead of buffering
      if (m.type === 'game_frame' && c.ws.bufferedAmount > 2_000_000) continue;
      c.ws.send(s);
    }
  }

  count(role: ClientRole) { let n = 0; for (const c of this.clients) if (c.role === role) n++; return n; }
  audioClients() { return [...this.clients].filter((c) => c.audio && (c.role === 'overlay' || c.role === 'avatar')); }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const h = this.apiHandlers.get(`${req.method} ${url.pathname}`);
        if (!h) return json(res, 404, { error: 'not found' });
        const needsAuth = true; // all API calls: this machine, or CONTROL_TOKEN
        if (needsAuth && !this.httpAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
        let body: any = {};
        if (req.method === 'POST') body = JSON.parse((await readBody(req)) || '{}');
        const out: any = await h(req, body);
        if (out && typeof out.__html === 'string') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(out.__html); return; }
        return json(res, 200, out);
      }
      if (url.pathname.startsWith('/tts/')) {
        const rel = url.pathname.slice(5).split('/').filter((p) => p && p !== '..' && !p.includes('\\'));
        if (rel.length > 2 || (rel.length === 2 && rel[0] !== 'cache')) { res.writeHead(404).end(); return; }
        return this.serveFile(res, path.join(this.opts.ttsDir, ...rel), true);
      }
      if (url.pathname === '/' && this.opts.rootRedirect) { res.writeHead(302, { location: this.opts.rootRedirect() + url.search }).end(); return; }
      for (const [prefix, dir] of Object.entries(this.opts.extraStatic)) {
        if (url.pathname.startsWith(prefix)) {
          const rel = path.normalize(url.pathname.slice(prefix.length)).replace(/^(\.\.[/\\])+/, '');
          return this.serveFile(res, path.join(dir, rel || 'index.html'));
        }
      }
      // SPA: /, /overlay, /avatar, /control → index.html
      const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(this.opts.staticDir, rel);
      if (rel !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) return this.serveFile(res, file);
      const index = path.join(this.opts.staticDir, 'index.html');
      if (fs.existsSync(index)) return this.serveFile(res, index);
      res.writeHead(503, { 'content-type': 'text/plain' }).end('Overlay not built. Run `npm run build`.');
    } catch (e) {
      this.opts.log.error('http error', e);
      json(res, 500, { error: 'internal error' });
    }
  }

  private httpAuthorized(req: http.IncomingMessage, url: URL) {
    const ip = req.socket.remoteAddress ?? '';
    const tok = (req.headers['x-control-token'] as string) || url.searchParams.get('token');
    const expected = this.opts.controlToken();
    if (expected && tok && safeEqual(tok, expected)) return true;
    // without a token only this machine may change things (setup, control, keys)
    return isLocal(ip) && !req.headers['x-forwarded-for'];
  }

  private serveFile(res: http.ServerResponse, file: string, noCache = false) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': noCache || file.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isLocal(ip: string) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 100_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
