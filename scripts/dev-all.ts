/**
 * Local supervisor (`npm start`): runs every process, restarts a crashed one
 * with bounded exponential backoff, and never restarts the healthy ones.
 * Production uses PM2 (config/ecosystem.config.cjs) with the same semantics.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ROOT, Backoff } from '../packages/shared/src/node.ts';

const procs: Array<{ name: string; entry: string; enabled: boolean }> = [
  { name: 'controller', entry: 'apps/controller/src/main.ts', enabled: true },
  { name: 'game-agent', entry: 'apps/game-agent/src/main.ts', enabled: true },
  // these idle when disabled, and restart themselves when the setup wizard changes their settings
  { name: 'kick-agent', entry: 'apps/kick-agent/src/main.ts', enabled: true },
  { name: 'stream-engine', entry: 'apps/stream-engine/src/main.ts', enabled: true },
];

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

function run(name: string, entry: string, backoff = new Backoff(1000, 30_000, 10)) {
  const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', path.join(ROOT, entry)], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HUBIE_SUPERVISED: '1' } });
  children.set(name, child);
  const startedAt = Date.now();
  child.on('exit', (code, sig) => {
    children.delete(name);
    if (shuttingDown) return;
    if (Date.now() - startedAt > 60_000 || code === 0) backoff.reset(); // ran fine, or a planned reload
    const d = code === 0 ? 500 : backoff.next();
    if (d === null) { console.error(`[supervisor] ${name} crashed too often; giving up`); return; }
    console.error(`[supervisor] ${name} exited (${code ?? sig}); restarting in ${d}ms`);
    setTimeout(() => run(name, entry, backoff), d);
  });
}

for (const p of procs) {
  if (!p.enabled) { console.log(`[supervisor] ${p.name} disabled`); continue; }
  run(p.name, p.entry);
  if (p.name === 'controller') await new Promise((r) => setTimeout(r, 800));
}

const stop = () => { shuttingDown = true; for (const c of children.values()) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
