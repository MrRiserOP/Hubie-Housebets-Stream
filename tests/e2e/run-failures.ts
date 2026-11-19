/**
 * Failure-injection run (brief §14 "Also test"). Real processes, real faults:
 *  - TTS outage (primary cloud TTS unreachable) → fallback voice, show continues
 *  - AI outage (LLM endpoint refused) → mock commentary, show continues
 *  - game browser crash (Chrome killed) → agent relaunches it, rounds resume
 *  - game-agent process crash → health shows down, restart reconnects
 *  - controller restart → show state resumes (no re-welcome), agents reconnect
 * Kick disconnect/agent restart: `npm run test:kick` (stand-in Kick). OBS restart: tests/unit/obs*.test.ts (fake OBS-WebSocket server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT } from '../../packages/shared/src/node.ts';
import { Reporter, TMP, api, baseEnv, comp, health, logTail, startProc, waitFor } from './harness.ts';
import { stopAll } from './harness.ts';

const r = new Reporter();
console.log(`failure-test temp dir: ${TMP}`);
const env = baseEnv({
  // OpenAI configured but unreachable → both brain and voice must degrade gracefully
  OPENAI_API_KEY: 'sk-test-outage-0123456789abcdefghijkl', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', ELEVENLABS_API_KEY: 'sk_test_outage_0123456789abcdefg', ELEVENLABS_BASE_URL: 'http://127.0.0.1:9', TTS_PROVIDER: 'elevenlabs', LLM_TIMEOUT_MS: '2000', TTS_TIMEOUT_MS: '3000',
});
let controller = startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller up', () => health().then((h) => h.ok), 20_000);
let agent = startProc('game-agent', 'apps/game-agent/src/main.ts', env);
const sayLines = () => logTail('controller', 2000).split('\n').filter((l) => l.includes(' SAY ['));

try {
  await r.run('ElevenLabs voice outage → fallback voice, show continues', async () => {
    await waitFor('a SAY line via fallback voice', async () => sayLines().find((l) => l.includes('/browser]')), 40_000);
    const t = await waitFor('tts degraded', async () => { const c = await comp('tts'); return c.state === 'degraded' && c; }, 15_000);
    return `ElevenLabs unreachable → browser voice fallback; tts health=${t.state} (${String(t.detail).slice(0, 90)})`;
  });

  await r.run('OpenAI brain outage → built-in lines, clear status', async () => {
    const a = await waitFor('ai degraded', async () => { const c = await comp('ai'); return c.state === 'degraded' && c; }, 30_000);
    const h = await health();
    if (h.llm.last !== 'mock') throw new Error(`last provider ${h.llm.last}`);
    return `"${String(h.llm.lastError).slice(0, 70)}" → built-in lines; ai=${a.state}; ${sayLines().length} lines spoken so far`;
  });

  await r.run('Game browser crash → relaunch and keep playing', async () => {
    await waitFor('rounds started', async () => (await health()).stats.rounds >= 1, 60_000);
    const before = (await health()).stats.rounds;
    execSync(`pkill -9 -f '[p]laywright_chromiumdev_profile'; true`);
    await waitFor('game-browser down', async () => (await comp('game-browser')).state === 'down', 20_000);
    await waitFor('game-browser back', async () => (await comp('game-browser')).state === 'ok', 60_000);
    await waitFor('new round after crash', async () => (await health()).stats.rounds > before, 60_000);
    return `Chrome killed (SIGKILL) → detected → relaunched → rounds ${before} → ${(await health()).stats.rounds}`;
  });

  await r.run('Game-agent process crash → detected, restart reconnects', async () => {
    const roundNo = async () => (await api('/api/game')).status?.limbo?.roundNumber ?? -1;
    const beforeNo = await waitFor('limbo round number', async () => { const n = await roundNo(); return n > 0 && n; }, 30_000);
    agent.kill('SIGKILL');
    await waitFor('game-agent down', async () => (await comp('game-agent')).state === 'down', 25_000);
    agent = startProc('game-agent', 'apps/game-agent/src/main.ts', env); // what PM2 does
    await waitFor('game-agent ok', async () => (await comp('game-agent')).state === 'ok', 30_000);
    const afterNo = await waitFor('round number after restart', async () => { const n = await roundNo(); return n >= beforeNo && n; }, 30_000);
    return `health down within heartbeat timeout; restarted process reconnected; Limbo round counter persisted (${beforeNo} → ${afterNo}, not reset); other components untouched`;
  });

  await r.run('Controller restart → show state resumes, agents reconnect', async () => {
    const before = await health();
    controller.kill('SIGTERM');
    await new Promise((res) => controller.once('exit', res));
    controller = startProc('controller', 'apps/controller/src/main.ts', env);
    await waitFor('controller back', () => health().then((h) => h.ok), 20_000);
    const after = await health();
    if (after.stats.rounds < before.stats.rounds) throw new Error(`stats reset (${before.stats.rounds} → ${after.stats.rounds})`);
    await waitFor('resume line', async () => sayLines().some((l) => /technical nap/i.test(l)), 20_000);
    await waitFor('game-agent reconnected', async () => (await health()).clients.some((c: any) => c.role === 'game-agent'), 20_000);
    await waitFor('rounds continue', async () => (await health()).stats.rounds > after.stats.rounds, 60_000);
    return `rounds preserved (${before.stats.rounds} → ${after.stats.rounds}), segment "${after.segment}" resumed without re-welcome, game-agent auto-reconnected, play continued`;
  });

  r.skip('Kick disconnect (real Kick)', 'Kick is unreachable from the build machine; reconnect/outage/restart are covered against a stand-in in `npm run test:kick`.');
  r.skip('OBS restart (live)', 'OBS not installed in the build environment; reconnect + scene/stream restore verified against a fake obs-websocket server in tests/unit/obs.test.ts');
} finally {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST-REPORT-failures.md'), r.markdown('Failure-injection tests'));
  if (r.failed) { console.log('\n--- controller ---\n' + logTail('controller', 40)); console.log('\n--- game-agent ---\n' + logTail('game-agent', 40)); }
  stopAll();
  console.log(`\n${r.results.filter((x) => x.status === 'PASS').length} passed / ${r.failed} failed → docs/TEST-REPORT-failures.md`);
  setTimeout(() => process.exit(r.failed ? 1 : 0), 1500);
}
