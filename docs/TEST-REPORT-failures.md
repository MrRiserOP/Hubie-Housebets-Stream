## Failure-injection tests

Run at 2026-11-19T00:13:20.855Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | ElevenLabs voice outage → fallback voice, show continues | ElevenLabs unreachable → browser voice fallback; tts health=degraded (using fallback voice: browser (Cannot reach api.elevenlabs.io from this computer (internet) (1.0s) |
| ✅ PASS | OpenAI brain outage → built-in lines, clear status | "Could not reach OpenAI. This computer/server may have no internet acce" → built-in lines; ai=degraded; 1 lines spoken so far (0.0s) |
| ✅ PASS | Game browser crash → relaunch and keep playing | Chrome killed (SIGKILL) → detected → relaunched → rounds 1 → 2 (51.5s) |
| ✅ PASS | Game-agent process crash → detected, restart reconnects | health down within heartbeat timeout; restarted process reconnected; Limbo round counter persisted (1 → 2, not reset); other components untouched (3.8s) |
| ✅ PASS | Controller restart → show state resumes, agents reconnect | rounds preserved (2 → 2), segment "gameplay" resumed without re-welcome, game-agent auto-reconnected, play continued (7.6s) |
| ⚪ NOT TESTED | Kick disconnect (real Kick) | Kick is unreachable from the build machine; reconnect/outage/restart are covered against a stand-in in `npm run test:kick`. |
| ⚪ NOT TESTED | OBS restart (live) | OBS not installed in the build environment; reconnect + scene/stream restore verified against a fake obs-websocket server in tests/unit/obs.test.ts |
