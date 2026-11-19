/**
 * Game agent process. Plays the SIMULATED Limbo game (entertainment only) when the controller asks
 * (play_round), so commentary never backs up; streams game frames for the overlay; recovers from
 * browser crashes with bounded backoff. Never connects to Housebets or any real-money site.
 */
import { HubClient, makeLogger, env, envBool, envNum, Backoff, sleep, CONTROLLER_PORT, DATA_DIR as SHARED_DATA_DIR } from '../../../packages/shared/src/node.ts';
import type { GameEvent } from '../../../packages/shared/src/protocol.ts';
import { SimulatedAdapter } from '../../../packages/game-adapters/src/simulated.ts';
import { PlaywrightAdapter } from '../../../packages/game-adapters/src/playwrightAdapter.ts';
import { DRIVERS } from '../../../packages/game-adapters/src/drivers.ts';
import { LimboSimAdapter } from '../../../packages/game-adapters/src/limboSim.ts';
import { LoginWallError, type AdapterContext, type GameAdapter } from '../../../packages/game-adapters/src/types.ts';
import type { CDPSession } from 'playwright';

const log = makeLogger('game-agent');
const hub = new HubClient('game-agent', log).start();

const ctx: AdapterContext = {
  log: (l, m) => log[l](m),
  executablePath: env('BROWSER_EXECUTABLE_PATH') || undefined,
  headless: envBool('GAME_HEADLESS', true),
  baseUrl: env('GAME_LOCAL_BASE_URL', `http://127.0.0.1:${CONTROLLER_PORT}`),
};
const FPS = Math.max(1, Math.min(15, envNum('GAME_FRAME_FPS', 8)));
const ALLOW_SIM_FALLBACK = envBool('GAME_FALLBACK_TO_SIM', true);

void SHARED_DATA_DIR;
// default: Hubie's simulated Limbo. 'local-demo' / 'simulated' remain for development only.
let adapterName = env('GAME_ADAPTER', 'limbo-sim');
let roundsPlayed = 0;
let lastError: string | undefined;
let adapter: GameAdapter | null = null;
let paused = true; // the controller sends 'resume' once the show is started
let playing = false;
let wantRound = false;
let lastRoundAt = Date.now();
let consecutiveFailures = 0;
let browserState: 'ok' | 'degraded' | 'down' = 'down';
/** Report browser state changes immediately (not just on the 5 s heartbeat). */
function setBrowser(s: typeof browserState, detail?: string) {
  if (s === browserState) return;
  browserState = s;
  hub.heartbeat('game-browser', s, detail ?? (adapter ? adapter.game : 'not started'));
}
let cdp: CDPSession | null = null;
const restartBackoff = new Backoff(2000, 60_000, 8);

function makeAdapter(name: string): GameAdapter {
  if (name === 'simulated' || name === 'local-sim') return new SimulatedAdapter();
  if (name === 'limbo-sim') {
    const h = new LimboSimAdapter();
    h.onCrash = (reason) => { log.error(`browser crash: ${reason}`); setBrowser('down'); scheduleRestart(reason); };
    return h;
  }
  const d = DRIVERS[name];
  if (!d) throw new Error(`unknown GAME_ADAPTER "${name}" (options: simulated, ${Object.keys(DRIVERS).join(', ')})`);
  const a = new PlaywrightAdapter(d());
  a.onCrash = (reason) => { log.error(`browser crash: ${reason}`); setBrowser('down'); scheduleRestart(reason); };
  return a;
}

function emit(kind: GameEvent['kind'], extra: Partial<GameEvent> = {}) {
  if (!adapter) return;
  hub.send({ type: 'game_event', event: { kind, game: adapter.game, adapter: adapter.name, simulated: adapter.simulated, source: sourceOf(), at: Date.now(), ...extra } });
}
function sourceOf(): 'limbo-sim' | 'local-sim' { return adapter instanceof LimboSimAdapter ? 'limbo-sim' : 'local-sim'; }
function sendStatus() {
  const h = adapter instanceof LimboSimAdapter ? adapter : undefined;
  hub.send({ type: 'game_status', status: {
    source: adapter ? sourceOf() : 'none', game: adapter?.game ?? 'not started',
    paused, rounds: roundsPlayed, lastRoundAt, error: lastError,
    limbo: h ? { roundNumber: h.engine.roundNumber, balance: h.engine.balance, history: h.engine.history.slice(-12), winShare: h.engine.winShare(), settings: h.settings } : undefined,
  } });
}

let restarting = false;
async function scheduleRestart(reason: string) {
  if (restarting) return;
  restarting = true;
  try {
    while (true) {
      const delay = restartBackoff.next();
      if (delay === null) {
        log.error(`browser restart attempts exhausted (${reason}); cooling down 2 min`);
        hub.send({ type: 'log', level: 'error', msg: `game browser failed repeatedly: ${reason}`, from: 'game-agent' });
        if (ALLOW_SIM_FALLBACK && adapterName !== 'simulated') { await switchTo('simulated', 'browser kept failing'); return; }
        await sleep(120_000);
        restartBackoff.reset();
        continue;
      }
      log.warn(`restarting game (${reason}) in ${delay}ms [attempt ${restartBackoff.attempts}]`);
      await sleep(delay);
      if (await launch()) { restartBackoff.reset(); return; }
    }
  } finally { restarting = false; }
}

async function switchTo(name: string, why: string) {
  log.warn(`switching adapter ${adapterName} → ${name}: ${why}`);
  hub.send({ type: 'log', level: 'warn', msg: `game adapter switched to ${name}: ${why}`, from: 'game-agent' });
  adapterName = name;
  await launch();
}

async function launch(): Promise<boolean> {
  await stopScreencast();
  await adapter?.stop().catch(() => {});
  adapter = makeAdapter(adapterName);
  try {
    await adapter.start(ctx);
    setBrowser('ok');
    consecutiveFailures = 0;
    log.info(`game ready: ${adapter.game} (${adapter.name}, simulated=${adapter.simulated})`);
    lastError = undefined;
    emit('game_loaded');
    sendStatus();
    await startScreencast();
    return true;
  } catch (e) {
    setBrowser('down');
    const msg = (e as Error).message;
    log.error(`launch failed: ${msg}`);
    lastError = msg;
    emit('game_error', { message: msg });
    sendStatus();
    if (e instanceof LoginWallError || /no game URL configured/.test(msg)) {
      // policy stop: never try to get around it
      if (ALLOW_SIM_FALLBACK) { await switchTo('simulated', msg); return true; }
    }
    return false;
  }
}

/* ---------------- frames ---------------- */
async function startScreencast() {
  const page = adapter?.page;
  if (!page) return;
  try {
    cdp = await page.context().newCDPSession(page);
    let lastSent = 0;
    cdp.on('Page.screencastFrame', async (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const now = Date.now();
      if (now - lastSent < 1000 / FPS) return;
      lastSent = now;
      hub.send({ type: 'game_frame', mime: 'image/jpeg', data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  } catch (e) { log.warn(`screencast unavailable: ${(e as Error).message}`); }
}
async function stopScreencast() { try { await cdp?.send('Page.stopScreencast'); await cdp?.detach(); } catch { /* ignore */ } cdp = null; }

// non-browser adapters & idle refresh: push a frame every 2s
setInterval(() => {
  const f = adapter?.renderFrame?.();
  if (f) hub.send({ type: 'game_frame', mime: f.mime, data: f.data, w: 1216, h: 684 });
}, 2000).unref();

/* ---------------- rounds ---------------- */
async function playOne() {
  if (!adapter || playing || paused || browserState === 'down') return;
  playing = true;
  wantRound = false;
  try {
    emit('round_started');
    const r = await adapter.playRound();
    lastRoundAt = Date.now();
    roundsPlayed++;
    consecutiveFailures = 0;
    setBrowser('ok');
    const { bonus, ...round } = r;
    if (bonus) emit('bonus_triggered', { round, message: 'bonus feature' });
    const mult = round.outcome === 'win' ? round.multiplier ?? 0 : 0;
    emit(mult >= 10 ? 'big_win' : 'round_result', { round });
    const f = adapter.renderFrame?.();
    if (f) hub.send({ type: 'game_frame', mime: f.mime, data: f.data, w: 1216, h: 684 });
  } catch (e) {
    consecutiveFailures++;
    const msg = (e as Error).message;
    log.warn(`round failed (${consecutiveFailures}): ${msg}`);
    emit('game_error', { message: msg });
    setBrowser('degraded');
    if (consecutiveFailures >= 3) { setBrowser('down'); void scheduleRestart(`3 consecutive round failures: ${msg}`); }
  } finally { playing = false; }
}

// settings changed in the setup wizard → exit cleanly; the supervisor/PM2 restarts us with the new .env
hub.on((m) => { if (m.type === 'reload_config') { log.info(`reloading: ${m.reason}`); setTimeout(() => process.exit(0), 300); } });

hub.on((m) => {
  if (m.type !== 'game_command') return;
  switch (m.command) {
    case 'play_round': wantRound = true; void playOne(); break;
    case 'pause': paused = true; log.info('paused'); if (adapter instanceof LimboSimAdapter) void adapter.setPaused(true); sendStatus(); break;
    case 'resume': paused = false; log.info('resumed'); if (adapter instanceof LimboSimAdapter) void adapter.setPaused(false); sendStatus(); break;
    case 'reload_game_settings': if (adapter instanceof LimboSimAdapter) void adapter.reloadSettings().then(sendStatus); break;
    case 'restart_browser': void scheduleRestart('operator request'); break;
    case 'switch_game': if (m.game) void switchTo(m.game, 'operator request'); break;
  }
});

// autonomy fallback: if the controller hasn't asked for a round in 90 s (but is connected), play anyway
setInterval(() => {
  if (hub.connected && !paused && !playing && adapter && Date.now() - lastRoundAt > 90_000) { log.info('no round request for 90s; playing autonomously'); void playOne(); }
}, 5000).unref();

// heartbeats + liveness probe
setInterval(async () => {
  const ok = adapter ? await adapter.healthy().catch(() => false) : false;
  if (!ok && browserState === 'ok' && !restarting) { setBrowser('down'); void scheduleRestart('health probe failed'); }
  hub.heartbeat('game-agent', paused ? 'degraded' : 'ok', `${adapterName}${paused ? ' (paused)' : ''}`);
  hub.heartbeat('game-browser', browserState, adapter ? `${adapter.game}${sourceOf() === 'limbo-sim' ? ' (demo play)' : ' — LOCAL TEST GAME'}` : 'not started');
  sendStatus();
}, 5000).unref();

// report in quickly after (re)start instead of waiting for the first 5 s tick
setTimeout(() => {
  hub.heartbeat('game-agent', paused ? 'degraded' : 'ok', `${adapterName}${paused ? ' (paused)' : ''}`);
  hub.heartbeat('game-browser', browserState, adapter ? adapter.game : 'starting');
}, 1500);

process.on('SIGTERM', async () => { await adapter?.stop(); process.exit(0); });
process.on('SIGINT', async () => { await adapter?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

if (!(await launch())) void scheduleRestart('initial launch failed');
void wantRound;
