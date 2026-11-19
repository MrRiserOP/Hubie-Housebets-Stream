## Connect Kick Chat wizard test (STAND-IN Kick + STAND-IN cloudflared — not the real services)

Run at 2026-11-19T00:15:42.911Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | Before anything is tested the wizard never says Connected | connected=false; steps: app:done account:todo tunnel:working webhook:todo subs:todo send:todo receive:todo; health=unknown (0.0s) |
| ✅ PASS | Cloudflared auto-starts, the address is read, and the tunnel is verified reachable | address https://fake-mwmstl1t-9qhs.trycloudflare.com/kick/webhook · Cloudflare tunnel is up and answers from the internet. (10.1s) |
| ✅ PASS | Login that lacks the "receive chat events" permission is detected and named | "Signed in as HubieBot, but Kick did not grant: receive chat events." → fix: "Press Reconnect and leave every permission ticked on Kick’s page." (0.0s) |
| ✅ PASS | Reconnecting with every permission turns the step green | Signed in as HubieBot. Permissions granted: read your account, read channel + live status, send chat messages, receive c (0.0s) |
| ✅ PASS | Kick refusing the chat subscription (webhooks not enabled) is surfaced, not hidden | error shown: "Kick refused the chat subscription: chat.message.sent — webhooks are not enabled for this …" → after enabling: "Kick lists the chat subscription for hubietest (checked 0 s ago)." (1.3s) |
| ✅ PASS | Test Kick Chat posts a real message through the API, but is NOT "connected" until Kick delivers one back | "Hubie chat test ✔ 05:15:21 — type "hi Hubie" here…" delivered (Test message delivered 0 s ago.); still connected=false because nothing has arrived from Kick yet (0.3s) |
| ✅ PASS | Hubie's own echoed message is not treated as viewer chat | echo of Hubie's own message (same account id) ignored (1.5s) |
| ✅ PASS | Typing "hi Hubie" arrives as a signed webhook, Hubie answers in chat, and ONLY THEN Kick is Connected | reply: "Welcome in, ViewerAnna! Grab a branch, get comfy." · all steps done,done,done,done,done,done,done · connected=true (0.5s) |
| ✅ PASS | Channel owner typing "hi Hubie" from the SAME account Hubie posts as still gets an answer | owner message accepted; reply "Hey HubieBot, first time here? You picked a great time. Probably. We'l" (6.0s) |
| ✅ PASS | Webhook step only counts for the address Kick used: a tunnel restart changes it and un-confirms it | restart → new address https://fake-mwmsu2ng-wlhg.trycloudflare.com/kic… → "The address CHANGED because the tunnel restarted — paste the…" → after a delivery on the new address: connected=true (9.1s) |
| ✅ PASS | Token expiry: an expired access token is refreshed silently | access token (1 s lifetime) was renewed with the refresh token before sending (1.3s) |
| ✅ PASS | A revoked login is reported as "Reconnect", not silently dead | "Kick login for the broadcaster account expired and could not be renewed — press Reconnect." (1.5s) |
| ✅ PASS | No secrets in the wizard/status responses or logs | client secret and tokens absent from /api/kick, /api/kick/wizard, /api/health and both logs (0.0s) |
| ✅ PASS | Control Center → section 4 shows the wizard, one address to copy, the status panel and Test Kick Chat | wizard rendered; address shown once for copy; no false "Connected" while login is revoked (1.0s) |

> Real Kick and a real Cloudflare tunnel were **not** reachable from the build machine. Rows above ran against `tests/fakes/fakeKick.ts` and `tests/fakes/fake-cloudflared`. A real account still needs the manual check in docs/KICK-SETUP.md.
