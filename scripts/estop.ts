/**
 * Emergency stop from the shell, works even if the HTTP API is unreachable:
 *   npm run estop            → engage
 *   npm run estop -- off     → release
 * Writes/removes data/ESTOP (the controller polls it every second) and also calls the API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONTROLLER_PORT, env } from '../packages/shared/src/node.ts';

const off = process.argv.includes('off');
const file = path.join(DATA_DIR, 'ESTOP');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (off) { try { fs.unlinkSync(file); } catch { /* not engaged */ } } else fs.writeFileSync(file, `manual estop ${new Date().toISOString()}`);
try {
  const res = await fetch(`http://127.0.0.1:${CONTROLLER_PORT}/api/estop`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': env('CONTROL_TOKEN') },
    body: JSON.stringify({ on: !off, reason: 'cli' }),
  });
  console.log(`API: ${res.status} ${await res.text()}`);
} catch { console.log('API unreachable; ESTOP file written, controller will pick it up when running.'); }
console.log(off ? 'Emergency stop RELEASED' : 'Emergency stop ENGAGED');
