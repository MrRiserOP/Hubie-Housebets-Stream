## Kick wiring test (STAND-IN Kick server — not real Kick)

Run at 2026-11-19T00:15:08.879Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | Kick agent resolves the channel and reports live status from the API | health=degraded "#hubietest · no chat account connected · offline"; platformLive=false (0.3s) |
| ✅ PASS | OAuth 2.1 + PKCE login through the Control Center endpoints | connected as HubieBot; state single-use; no token/secret in API response (0.0s) |
| ✅ PASS | Event subscriptions created (chat.message.sent + livestream.status.updated) | chat.message.sent, livestream.status.updated (0.0s) |
| ✅ PASS | Chat IN: signed webhook is read, Hubie replies in Kick chat | "Good question, ViewerAnna. I'm going to think about it at sloth speed and get back to you." (reply addressed @ViewerAnna by username; sent with a user token, not the client secret) (10.8s) |
| ✅ PASS | Webhook security: bad signature / unsigned / stale timestamp → 401, duplicates ignored | 3 forged requests rejected (401) and counted; duplicate message id processed once (0.8s) |
| ✅ PASS | Moderation: link/abuse message is ignored and deleted on Kick | Kick DELETE /chat/mod-1795047301012 was called (0.3s) |
| ✅ PASS | Chat OUT is rate limited (min gap) and survives a transient 500 | 1 message(s) delivered after an injected 500 (retried once) (1.8s) |
| ✅ PASS | Live status comes only from Kick (never assumed) | Kick says live → state.platformLive=true; Kick says offline → false (0.5s) |
| ✅ PASS | Title and category update through the official PATCH /channels | title → "Hubie plays Limbo", category → Slots & Casino (0.3s) |
| ✅ PASS | Kick API outage → degraded, then recovers by itself | API unreachable → health degraded with the reason; API back → ok without a restart (0.5s) |
| ✅ PASS | Webhook listener survives a kick-agent crash/restart (and chat resumes) | agent killed → health down → restarted → token file reused (no re-login) → chat in/out works (4.5s) |
| ✅ PASS | Secrets: no token/secret in logs or API | client secret and access tokens absent from controller + kick-agent logs; token file is 0600 (0.0s) |

> Real Kick was **not** reachable from the build machine. Every row above ran against `tests/fakes/fakeKick.ts`, which mimics the documented endpoints. A real Kick channel still needs the 2-minute check in docs/KICK-SETUP.md.
