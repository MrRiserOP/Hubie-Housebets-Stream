/** Browser hub client with auto-reconnect. One per page. */
import { decode, encode, type ClientRole, type HubMessage } from '../../../packages/shared/src/protocol.ts';

type Handler = (m: HubMessage) => void;

export class BrowserHub {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private retry = 0;
  connected = false;
  onStatus?: (connected: boolean) => void;

  constructor(private role: ClientRole, private audio: boolean) { this.connect(); }

  private connect() {
    const params = new URLSearchParams(location.search);
    const token = params.get('token') ?? '';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const hubUrl = params.get('hub') ?? `${proto}://${location.host}/hub`;
    const otoken = params.get('otoken') ?? '';
    const qs = [token && `token=${encodeURIComponent(token)}`, otoken && `otoken=${encodeURIComponent(otoken)}`].filter(Boolean).join('&');
    const ws = new WebSocket(`${hubUrl}${qs ? `?${qs}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.onStatus?.(true);
      ws.send(encode({ type: 'hello', role: this.role }));
      ws.send(encode({ type: 'client_info', audio: this.audio }));
    };
    ws.onmessage = (e) => { const m = decode(e.data); if (m) this.handlers.forEach((h) => h(m)); };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  on(h: Handler) { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  send(m: HubMessage) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(m)); }
}
