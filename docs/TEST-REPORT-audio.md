## Voice preview & audio test — real Chrome, default autoplay policy; ElevenLabs = local stand-in returning real MP3

Run at 2026-11-19T00:14:44.613Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | No ElevenLabs key: preview offers the browser voice, clearly labelled as a fallback | button reads "Preview browser voice (fallback — not ElevenLabs)"; player label: "Browser voice (fallback — not ElevenLabs)"; no OpenAI field or wording in the voice section (0.9s) |
| ✅ PASS | Bad key is rejected with a readable reason and NOT saved; good key is verified against the voice list | invalid key → "ElevenLabs rejected the API key…" and nothing saved; valid key → verified via GET /v1/voices (4 voices) and saved (0.3s) |
| ✅ PASS | Preview with ElevenLabs: request → valid MP3 → decoded → AUDIBLE playback, despite a 4 s generation delay | AudioContext running; 89696 bytes decoded; output level peak 0.63 (sound really went to the speakers); "Played real ElevenLabs speech (George, 11.1 s, level 0.63). If you heard it, the voice works." (15.6s) |
| ✅ PASS | Big-win preview is more expressive than normal (different ElevenLabs settings sent) | win: stability 0.27, style 0.65, speed 1.10 · sarcastic: stability 0.65, style 0.40, speed 0.96 (14.8s) |
| ✅ PASS | Stop button stops playback immediately | state playing → idle within 2 s of pressing Stop (0.5s) |
| ✅ PASS | Volume slider changes the real output level (0 % = silent, remembered) | level at 0 % = 0; 80 % remembered after reload (1.6s) |
| ✅ PASS | Audio test section: status + "Test voice" plays real configured-provider audio | ✓ Real ElevenLabs speech: 50408 bytes valid MP3, generated in 4138 ms, played 6.2 s at level 0.64. If you heard it, browser audio works. (11.2s) |
| ✅ PASS | Overlay / OBS: same pipeline plays the test line as audio and the mouth follows it | ✓ Overlay played the line as real audio (elevenlabs) and Hubie’s mouth followed the sound (peak 0.75, mouth open 76 % of the time). (9.9s) |
| ✅ PASS | Speech in the overlay never overlaps (queue) | 3 test lines requested back-to-back → played one after another (4 played so far, 0 overlaps) (25.6s) |
| ✅ PASS | No OpenAI voice anywhere: zero OpenAI audio requests, no OpenAI TTS settings in the API | Hubie made 5 ElevenLabs speech requests and 0 OpenAI audio requests (OpenAI key present for text only) (0.0s) |
| ✅ PASS | No browser errors | 0 page errors (0.0s) |
