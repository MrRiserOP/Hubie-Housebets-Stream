/**
 * PM2 process file. Each component is its own process so a crash restarts only
 * that component. Exponential backoff + max_restarts prevent restart storms.
 *   pm2 start config/ecosystem.config.cjs      (or: npm run start:pm2)
 *   pm2 logs | pm2 status | pm2 restart game-agent
 * Optional managed OBS stack (headless VPS): set OBS_MANAGED=true in .env.
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');

// read .env just to decide which processes to run (the apps load .env themselves)
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch { /* no .env yet */ }
const on = (k) => ['1', 'true', 'yes', 'on'].includes(String(env[k] || '').toLowerCase());

const node = (name, entry, extra = {}) => ({
  name,
  cwd: ROOT,
  script: path.join(ROOT, entry),
  interpreter: 'node',
  interpreter_args: '--no-warnings --import tsx',
  autorestart: true,
  exp_backoff_restart_delay: 1000, // 1s, 1.5s, 2.25s … capped by PM2 at 15s
  max_restarts: 50,
  min_uptime: '20s',
  kill_timeout: 5000,
  max_memory_restart: '700M',
  out_file: path.join(ROOT, 'logs', `${name}.pm2.out.log`),
  error_file: path.join(ROOT, 'logs', `${name}.pm2.err.log`),
  merge_logs: true,
  time: true,
  env: { HUBIE_SUPERVISED: '1', NODE_ENV: 'production' },
  ...extra,
});

const apps = [
  node('controller', 'apps/controller/src/main.ts'),
  node('game-agent', 'apps/game-agent/src/main.ts', { max_memory_restart: '1500M' }),
  node('kick-agent', 'apps/kick-agent/src/main.ts'),
  node('stream-engine', 'apps/stream-engine/src/main.ts'),
];

if (on('OBS_MANAGED')) {
  apps.unshift({
    name: 'obs-stack', cwd: ROOT, script: path.join(ROOT, 'scripts/vps/run-obs.sh'), interpreter: 'bash',
    autorestart: true, exp_backoff_restart_delay: 2000, max_restarts: 30, min_uptime: '30s', kill_timeout: 10000,
    out_file: path.join(ROOT, 'logs', 'obs.pm2.out.log'), error_file: path.join(ROOT, 'logs', 'obs.pm2.err.log'), time: true,
  });
}

module.exports = { apps };
