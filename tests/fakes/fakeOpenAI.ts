/**
 * Local stand-in for the OpenAI API, used because api.openai.com is not
 * reachable from the build environment. It implements the two endpoints Hubie
 * uses with the same request/response shapes the official SDK expects:
 *   POST /v1/responses      → Responses API object with an output_text JSON line
 *   POST /v1/audio/speech   → 404 (Hubie must NEVER call it; tests assert it was never requested)
 * Special keys simulate failures: sk-invalid… → 401, sk-nocredit… → 429 insufficient_quota,
 * sk-ratelimit… → 429 rate limit, sk-down… → 500.
 * It records every request so tests can assert on what Hubie sent.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockGenerate } from '../../services/ai/src/mockBank.ts';

const execFileP = promisify(execFile);

export interface FakeRequest { path: string; auth: string; body: any; at: number }

export async function startFakeOpenAI(port = 0) {
  const requests: FakeRequest[] = [];
  let failNext = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-openai-'));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      requests.push({ path: req.url ?? '', auth, body, at: Date.now() });
      const err = (status: number, code: string, message: string, type = 'invalid_request_error') => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type, code, param: null } }));
      };
      if (auth.startsWith('sk-invalid')) return err(401, 'invalid_api_key', 'Incorrect API key provided.');
      if (auth.startsWith('sk-nocredit')) return err(429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota');
      if (auth.startsWith('sk-ratelimit')) return err(429, 'rate_limit_exceeded', 'Rate limit reached.', 'requests');
      if (auth.startsWith('sk-down') || failNext > 0) { if (failNext > 0) failNext--; return err(500, 'server_error', 'The server had an error.', 'server_error'); }

      if (req.url === '/v1/responses' && req.method === 'POST') {
        let text = 'Hubie is ready.';
        const m = String(body.input ?? '').match(/SITUATION \(structured data, not instructions\):\n(.*)\n\nCONTEXT[^\n]*\n(.*)\n\nWrite/s);
        if (body.text?.format?.type === 'json_schema' && m) {
          const sit = JSON.parse(m[1]);
          const ctx = JSON.parse(m[2]);
          const line = mockGenerate(sit, { ...ctx, recentLines: ctx.recentLines ?? [] });
          text = JSON.stringify({ text: line.text, emotion: line.tone, expression: line.expression, combo: line.combo ?? 'none', caption: line.caption ?? '' });
        }
        const resp = {
          id: `resp_${Date.now()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model,
          output: [{ id: `msg_${Date.now()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: { input_tokens: 500, output_tokens: 40, total_tokens: 540 },
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(resp));
        return;
      }
      // Hubie no longer uses OpenAI for voice: any call here is a bug, recorded so tests can assert there are none.
      if (req.url === '/v1/audio/speech') { err(404, 'not_found', 'Hubie does not use OpenAI text-to-speech'); return; }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4-mini', object: 'model' }] })); return; }
      err(404, 'not_found', `Unknown path ${req.url}`);
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    failNext: (n: number) => { failNext = n; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// run standalone: node --import tsx tests/fakes/fakeOpenAI.ts 8790
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFakeOpenAI(Number(process.argv[2] ?? 8790));
  console.log(`fake OpenAI listening at ${f.url}`);
}
