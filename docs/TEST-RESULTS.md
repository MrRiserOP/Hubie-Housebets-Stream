# What was tested, and what was NOT

Network limits on the build machine: only `api.anthropic.com` is reachable. **ElevenLabs, Kick, Cloudflare and OBS could not be reached or run here.** Their tests use clearly-labelled stand-ins (`tests/fakes/`). A stand-in proves Hubie's code paths; it does **not** prove a real account, real voice, real tunnel or real stream works.

## Automated — passed (re-run with the commands shown)

| Area | Result | Command |
|---|---|---|
| Unit tests (shared spec, ElevenLabs client, Kick client, tunnel manager, OBS 1080p60 logic, safety, director…) | **all passing** | `npm test` |
| ElevenLabs wiring: request format, header, errors (invalid key / permissions / quota / voice not found / rate limit), cache, hourly cap, per-emotion settings, browser fallback labelling; preview playback with a measured audio level; same audio reaches the overlay/OBS path; **zero OpenAI audio calls** | 11/11 (stand-in server) | `npm run test:audio` |
| Kick wiring: OAuth 2.1 + PKCE, signed webhooks (forged/stale/duplicate rejected), chat in/out, moderation, live status, outage recovery, agent restart | 12/12 (stand-in Kick) | `npm run test:kick` |
| **Connect Kick Chat wizard**: Cloudflared auto-start and reachability check, missing-permission detection, refused subscription surfaced, "Connected" only after send + receive + reply, owner's own "hi Hubie" answered while Hubie's echo is ignored, tunnel restart changes the address and un-confirms it, expired token refreshed, revoked login → "Reconnect", no secrets in responses/logs, UI renders the one address to copy | 14/14 (stand-in Kick + stand-in cloudflared) | `npm run test:kick-wizard` |
| **OBS 1080p60**: spec vs Kick's limits; apply writes 1920×1080@60, x264 CBR 6000 kbps, keyframe 2 s, 48 kHz; every value read back; local performance test passes/fails with causes; "verified on a live stream" only after a real measurement window | passing (stand-in obs-websocket) | `npm test` |
| Overlay at 1920×1080 in Chrome: animation loop ≥ 60 fps with headroom (browser side only, software rendering) | passing | `npm run test:fps` |
| **Streamable cloud mode**: public overlay is view-only and token-gated; proxied clients are never treated as local; overlay token cannot use control/game-agent roles or e-stop; API closed to proxied callers; telemetry verdict (GPU/software, fps, size); cloud checklist never claims stream output works; token rotation; real overlay page reports itself | 11/11 (+2 NOT TESTED: Streamable API, real Remote OBS) | `npm run test:cloud` |
| Control Center, all 11 sections, clicked like a first-time user (real Anthropic call) | 13/13 | `npm run test:control-center` |
| Failure drills (voice outage, brain outage, Kick outage, e-stop…) | 5/5 | `npm run test:failures` |
| Whole show chain in a browser + 6-minute soak | see the two reports below | `npm run test:e2e`, `npm run test:soak -- 6` |

## Manual — needs YOU (not verifiable from the build machine)

| What | Why it can't be automated here | How |
|---|---|---|
| Real ElevenLabs voice: the key works, how the voices sound, preview audible on your speakers | ElevenLabs unreachable here; no speakers | Section 2: Save & test → ▶ on a voice |
| OBS captures that voice | OBS not installed here | Section 7 "Test on stream overlay / OBS" → OBS meter moves |
| Real Kick chat: Kick delivers to your address, Hubie answers | Kick unreachable here | Section 4 wizard → Test Kick Chat → type `hi Hubie` |
| Real Cloudflared start/recovery on your Windows PC | cloudflared not runnable against Cloudflare from here | Wizard step 3 shows a measured "answers from the internet" |
| **1080p60 on real OBS**: settings accepted, PC keeps up, Kick accepts the stream | no OBS, and Kick has no private test stream | Section 6: Apply → 30-second local test → go live; "verified on a live stream" appears after 1 real minute |

| **Streamable cloud**: Browser Source in real Remote OBS, voice captured, GPU encode, dropped frames/CPU (Stats dock), Kick output at 1080p60 | Streamable and Kick unreachable here; no Streamable API docs | docs/STREAMABLE-CLOUD.md → Performance check |

Reports: `TEST-REPORT-*.md` in this folder.

---

## Entertainment upgrade (2026-11-19) — results

| Suite | Result | Notes |
|---|---|---|
| Unit (vitest) | **200 / 200** | adds key ring (17), live clock (7), personality/hat/conversation (16), avatar states (15), hat-window (1) |
| `test:entertainment` (new, real Chrome + controller + kick-agent) | **22 / 22** (passed on 3 consecutive full runs after fixes) | key failover, no-retry of dead keys, rate-limit cool-down, shared-quota detection, all-keys-fail → local voice → silent, UI key management, sections 12–16, music start / broken-track recovery / ducking, avatar states, ON AIR status chip, history badge, uptime persistence across a SIGKILL restart, no key text in any API response or log |
| e2e, failures, audio (11), kick (12), kick-wizard (14), cloud, control-center (13), fps | all pass | audio suite needed one fix (see below); fps 85 fps avg in headless Chrome |
| Soak, stand-in brain, 8 min | 0 errors, RSS 141→128 MB, 2 of 50 lines mention the hat (both right after a viewer asked about it) | |
| Soak, **real Anthropic brain**, 6 min | 0 errors, 21 lines, 0 hat lines, 100 % unique, 0 near-duplicates, 1.2 s avg latency | stand-in ElevenLabs voice |

**Bugs found by these tests and fixed:** shared-quota detection grouped two unrelated fresh keys (0 used) and blocked a good backup; an invalid key was treated as a quota sibling; a single broken music file could stall playback for a minute (or forever when it was the only track in the mood) and was double-counted; a viewer's hat mention kept hat jokes allowed for minutes; a same-millisecond edge in the hat window; Control Center monitoring crashed on per-engine counters; the audio-preview level meter read stale samples from the previous playback (now ignored for the first 200 ms — this is my diagnosis, confirmed only by the test passing again).

**Longest continuous run in this work: 8 minutes** (stand-in brain), plus 6 minutes with the real brain. The 7-day target is **not proven**; the design bounds queues/caches and the Monitoring section shows memory trend, but no multi-day run was done. An attempted 15-minute run was cut short when the sandbox restarted.

**Not tested against the real services:** ElevenLabs, Kick, Streamable, OBS (stand-ins only). **Not auditioned:** the background music (no audio device); levels were measured, not listened to.
