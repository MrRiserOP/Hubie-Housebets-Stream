## Streamable cloud mode — automated tests (local stand-ins)

Run at 2026-11-19T00:18:22.436Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | Proxied WebSocket without any token is refused | closed (1008) (0.0s) |
| ✅ PASS | Proxied WebSocket with a wrong overlay token is refused | closed (1008) (0.0s) |
| ✅ PASS | Overlay token lets a proxied client act as an overlay only | overlay role accepted; control and game-agent roles refused (0.9s) |
| ✅ PASS | A view-only overlay cannot press emergency stop, send control actions or change anything | estop untouched; control messages ignored (0.9s) |
| ✅ PASS | Control token over a proxy still gives full control (the Control Center) | accepted (0.9s) |
| ✅ PASS | The API refuses requests that come through a proxy without the control token | no token → 401; overlay token → 401; control token → 200 (0.0s) |
| ✅ PASS | Cloud status builds the https overlay link (only for authorized callers) and keeps local OBS off | https://hubie.example.test/overlay?cloud=1&audio=1&otoken=… ; control token not present (0.0s) |
| ✅ PASS | Verdict reflects a live cloud overlay: ok → software rendering → low fps → wrong size | ok: "Overlay renders at 60 fps, p95 17 ms, 1920×1080, GPU: NVIDIA Tesla T4." \| software: "the browser is rendering in software (Google SwiftShader) — no GPU acceleration for browser sources" (0.0s) |
| ✅ PASS | Pre-stream checklist in cloud mode uses cloud checks, not local OBS | checks: ai, voice, game, overlay, lipsync, kick, cloud, cloud-go-live, security, safety — stream output honestly "Not configured" (20.0s) |
| ✅ PASS | Rotating the overlay link disconnects viewers and the old token stops working | viewer closed; old token refused; new link issued (0.0s) |
| ✅ PASS | The real overlay page (1920×1080) measures itself and reports to the controller | reported 1920×1080 at 19.6 fps (headless sandbox browser, software rendering — not a cloud GPU) (5.8s) |
| ⚪ NOT TESTED | Streamable API / OAuth / server status / OBS WebSocket | No public documentation found; nothing implemented, nothing claimed. |
| ⚪ NOT TESTED | Browser Source inside real Streamable Remote OBS; GPU encode; dropped frames; Kick output | Streamable and Kick are unreachable from this sandbox — manual test in docs/STREAMABLE-CLOUD.md. |

> A node WebSocket client with X-Forwarded-For stands in for Caddy and for cloud OBS. Nothing here talks to Streamable.
