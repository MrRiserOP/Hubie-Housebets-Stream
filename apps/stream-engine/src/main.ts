/** Stream engine process: OBS control + overlay self-healing. */
import path from 'node:path';
import { HubClient, makeLogger, env, envBool, DATA_DIR } from '../../../packages/shared/src/node.ts';
import { ObsController } from './obs.ts';

const log = makeLogger('stream-engine');
const hub = new HubClient('stream-engine', log).start();
// settings changed in the setup wizard → exit cleanly; the supervisor/PM2 restarts us with the new .env
hub.on((m) => { if (m.type === 'reload_config') { log.info(`reloading: ${m.reason}`); setTimeout(() => process.exit(0), 300); } });


if (env('STREAM_MODE') === 'streamable-cloud') {
  log.info('STREAM_MODE=streamable-cloud — local OBS controller off (encoding runs in Streamable cloud OBS)');
  setInterval(() => hub.heartbeat('obs', 'disabled', 'cloud mode'), 10_000);
} else if (!envBool('OBS_ENABLED')) {
  log.info('OBS_ENABLED=false — stream engine idle');
  setInterval(() => hub.heartbeat('obs', 'disabled', 'OBS_ENABLED=false'), 10_000);
} else {
  const token = env('CONTROL_TOKEN');
  const overlayUrl = `${env('PUBLIC_BASE_URL', 'http://127.0.0.1:8787')}/overlay${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const obs = new ObsController({
    url: env('OBS_WS_URL', 'ws://127.0.0.1:4455'), password: env('OBS_WS_PASSWORD'), scene: env('OBS_SCENE', 'Hubie Live'),
    overlayUrl, inputName: 'Hubie Overlay', stateFile: path.join(DATA_DIR, 'obs-state.json'),
    autostart: envBool('OBS_AUTOSTART_STREAM'), monitorAudio: envBool('OBS_MONITOR_AUDIO'),
    streamServer: env('OBS_STREAM_SERVER') || undefined, streamKey: env('OBS_STREAM_KEY') || undefined,
  }, log);
  let last = { s: 'down' as 'ok' | 'degraded' | 'down', d: 'starting' };
  obs.onStatus = (s, d) => { last = { s, d }; hub.heartbeat('obs', s, d); };
  setInterval(() => hub.heartbeat('obs', last.s, last.d), 10_000);
  obs.start();
  setInterval(async () => { if (obs.connected) hub.send({ type: 'obs_report', kind: 'readiness', readiness: await obs.readiness().catch(() => undefined) }); }, 8_000).unref();

  let avatarDownSince = 0;
  hub.on(async (m) => {
    try {
      if (m.type === 'obs_command') {
        if (m.command === 'start_stream') await obs.startStream();
        if (m.command === 'stop_stream') await obs.stopStream();
        if (m.command === 'setup_scene') await obs.setupScene();
        if (m.command === 'configure_output') await obs.configureOutput();
        if (m.command === 'performance_test') void obs.performanceTest(m.seconds ?? 30).catch((e) => hub.send({ type: 'obs_report', kind: 'error', error: (e as Error).message.slice(0, 240) }));
        // always follow a command with a fresh readiness report
        hub.send({ type: 'obs_report', kind: 'readiness', readiness: await obs.readiness() });
      }
      if (m.type === 'overlay_state') {
        const av = m.state.health.find((h) => h.name === 'avatar');
        if (av?.state === 'down') { avatarDownSince ||= Date.now(); if (Date.now() - avatarDownSince > 20_000) await obs.refreshOverlay(av.detail ?? 'avatar down'); }
        else avatarDownSince = 0;
      }
    } catch (e) {
      log.warn(`OBS command failed: ${(e as Error).message}`);
      if (m.type === 'obs_command') hub.send({ type: 'obs_report', kind: 'error', error: (e as Error).message.slice(0, 200) });
    }
  });
}
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
