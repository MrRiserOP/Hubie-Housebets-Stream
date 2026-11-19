## End-to-end test (text brain + ElevenLabs voice, both local stand-ins)

Run at 2026-11-19T00:12:14.295Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | 1. Launch the application | controller + game-agent running; live-provider mode (LLM openai, voice elevenlabs→browser) (0.4s) |
| ✅ PASS | 2. Open the game (Playwright) | Limbo; JPEG screencast frames in overlay (1.3s) |
| ✅ PASS | 3+4. Start a Limbo round and detect the outcome | rounds=1, wins=1, losses=0; result chip shown on the event rail (17.6s) |
| ✅ PASS | 5. Generate commentary with OpenAI (Responses API) | 4 Responses calls (structured JSON); e.g. "Quick double. a 2x win and a 2.5x win. The game is speed-running my feelings." (3.9s) |
| ✅ PASS | 6. Generate speech with ElevenLabs (emotion-aware) and play it; no OpenAI speech call | 3 ElevenLabs calls (voice IKne3meq5aSn9XLyUdCD, model eleven_turbo_v2_5); 3 distinct emotion settings; played as real MP3 (audio→idle→audio); 0 OpenAI audio calls (0.1s) |
| ✅ PASS | 7. Mouth follows the actual audio | max open 0.80; 15 open / 6 closed samples from the WebAudio analyser (0.0s) |
| ✅ PASS | 8. Big win → animation combo, expression, graphics | combo big_win played; BIG WIN banner + confetti + zoom; reaction captions so far: LET'S GET COMFY. / BIG. WIN. ENERGY. (1.5s) |
| ✅ PASS | 9. 1080p overlay renders (OBS browser source page) | stage 1920×1080 with word-synced subtitles; screenshots in docs/screenshots. OBS itself not available here (1.2s) |
| ✅ PASS | 10a. Chat: reply by username with callout graphics | "Welcome in! e2e_viewer1, we're playing Housebets originals in demo mode. Play money only, all for fun." + @e2e_viewer lower-third (9.1s) |
| ⚪ NOT TESTED | 10b. Real Kick chat | No real Kick credentials / network here; the Kick wiring is covered by `npm run test:kick` against a stand-in. |
| ✅ PASS | Safety: prompt injection is filtered | filtered; key never spoken (4.0s) |
| ✅ PASS | Security: OpenAI key never reaches the browser | not in overlay state, JS bundle or logs; non-local API access rejected without token (1.4s) |
| ✅ PASS | Emergency stop halts speech and the game | rounds frozen at 3; BRB screen shown; released (6.1s) |
| ✅ PASS | No browser errors on the overlay | 0 page errors (0.0s) |
