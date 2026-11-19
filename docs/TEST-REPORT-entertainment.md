## Entertainment upgrade E2E (STAND-IN ElevenLabs + Kick — not the real services)

Run at 2026-11-19T13:33:06.465Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | Keys: add 4 backups through the API; list is masked, ordered and each tested | 5 keys (primary + 4 backups); masked hints only: sk_…cdef sk_…abcd sk_…cdef sk_…cdef sk_…cdef (0.1s) |
| ✅ PASS | Failover: invalid primary → exhausted (401 quota) → shared-account → good key; speech still delivered | primary=invalid, backup1=exhausted; active "Backup 2"; 1 failover entries; engine elevenlabs (1.0s) |
| ✅ PASS | Exhausted/invalid keys are not retried on every line | after the first failure, the exhausted and invalid keys received 0 further synthesis requests over 4 more lines (0.4s) |
| ✅ PASS | Rate limit: key is put on cooldown and the next key serves the line | status=rate_limited (cooldown), line spoken by "Backup 2" (0.1s) |
| ✅ PASS | Shared account quota is detected (two keys, one allowance) | Backup 2 and Backup 3 are flagged as sharing one allowance (same limit, reset time and used count) (0.0s) |
| ✅ PASS | Shared allowance exhausted: both keys marked, next account takes over | both shared-account keys → exhausted together; Backup 4 active and speaking (0.1s) |
| ✅ PASS | Every key fails → free local voice fallback (no other paid provider), then silent mode keeps running | all keys disabled → engine "browser" (browser voice = free fallback; ok=false); with fallback set to "none": engine "browser", ok=false, controller still healthy, silent lines counted: 0 (0.0s) |
| ✅ PASS | Re-enabling keys + browser fallback restores ElevenLabs speech | engine back to elevenlabs on "Backup 4" (0.1s) |
| ✅ PASS | Control Center: sections 12–16 render, nothing leaks, no page errors | sections 12, 13, 14, 15, 16 rendered with live data; screenshots saved; zero page errors; no key text in page or HTML (5.6s) |
| ✅ PASS | Control Center 13: add a key in the UI, disable/enable, reorder, test | added via the form, field cleared, tested, disabled, re-enabled; only the masked hint is displayed (1.7s) |
| ✅ PASS | Control Center 12: personality changes are saved and applied | hat→never, commentary→quiet applied via the panel; reset restores defaults (hat only when a viewer mentions it) (1.7s) |
| ✅ PASS | Music: starts, skips the broken user track, keeps playing (no overlap) | state playing; 1 deck(s) audible (≤2 only during a crossfade) (0.0s) |
| ✅ PASS | Music: a broken track is reported, parked, and playback recovers on a good one | failures recorded=1, skipped=1, lastError=""; then recovered on "Funky Sloth" (crossfading) (0.0s) |
| ✅ PASS | Ducking: music level drops while Hubie speaks and returns afterwards | music level 0.22 → 0.1 while speaking → 0.4 after (ducked flag cleared) (4.8s) |
| ✅ PASS | Avatar: reports a live animation state and previews work | states observed: speaking:1, idle:1 (0.0s) |
| ✅ PASS | Overlay: OFFLINE badge while Kick says not live (counter paused) | "150+ HOURS ON AIR" shown while the status chip honestly reads "OFFLINE"; measured counter live=false (0.5s) |
| ✅ PASS | ON AIR: counts only after Kick confirms live; stops when it stops; no inflation | live: +30 s counted over ~60 s wall time; status chip "LIVE" while confirmed, history badge unchanged; after Kick went offline the total stayed at 30 s for 20 s (paused); disconnects logged: 1 (75.7s) |
| ✅ PASS | History badge: "150+ HOURS ON AIR" stays through a disconnect and is not a timer | exact text unchanged across live→offline and 3 s apart; contains no session timer (3.1s) |
| ✅ PASS | Uptime persists across a controller restart (and the counter does not restart from zero) | total before restart 30 s, after 30 s; sessions 1; not counted while the app was down (18.6s) |
| ✅ PASS | Secrets: no key text in logs, state, health, monitor or setup status | 7 API responses + controller log (4526 chars) + kick-agent log clean for all 7 keys; key file mode 0600 (0.0s) |
| ✅ PASS | Monitoring endpoint reports process load, queue and voice stats | rss 119 MB, cpu avg 1.7%, loop lag max 0 ms, queue 0/10 (6.0s) |
| ✅ PASS | No uncaught page errors on either page | control panel and overlay: 0 page errors (0.0s) |

> Real ElevenLabs and Kick were **not** reachable from the build machine; those rows ran against `tests/fakes`. Music playback was verified by the browser reporting state/levels, not by listening.
