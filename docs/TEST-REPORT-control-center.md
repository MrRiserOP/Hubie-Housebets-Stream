## Control Center end-to-end (real browser)

Run at 2026-11-19T00:17:17.209Z on linux 6.18.44-fc-v653, Node v22.23.4

| Result | Test | Detail |
|---|---|---|
| ✅ PASS | Opens at / with the 16 sections | 1 AI brain · 2 Voice · 3 Limbo game · 4 Kick chat · 5 Kick stream · 6 OBS · 7 Audio test · 8 Avatar & look · 9 System health · 10 Pre-stream checklist · 11 Cloud (Streamable) · 12 Personality · 13 Voice keys & music · 14 Avatar animation · 15 Streaming / ON AIR · 16 Monitoring (0.6s) |
| ✅ PASS | 1. Anthropic key: paste → saved + tested against the REAL API | real Claude call succeeded; key stored server-side only; absent from page, HTML and API status (1.2s) |
| ✅ PASS | 2. Voice: ElevenLabs key (stand-in), preview requests real speech, no OpenAI voice | preview hit the ElevenLabs speech endpoint, page shows the player; key not in page; zero OpenAI speech calls (2.0s) |
| ✅ PASS | 3. Limbo: settings save, invalid input rejected, game page is running | saved; invalid delay rejected: "round delay must be 2–120 s" (1.1s) |
| ✅ PASS | 4. Kick chat: channel + app credentials saved, OAuth login completes, secret never shown | connected as HubieBot; client secret not in page or API (31.4s) |
| ✅ PASS | 5. Kick stream: URL/key saved, stream-key stays server-side, title/category update | validated URL; key saved server-side, not shown; title/category updated through the stand-in API (1.6s) |
| ✅ PASS | 6. OBS: connect (stand-in OBS), auto-setup scene, push Kick URL + key, 1080p60 applied and read back | OBS received rtmp_custom + Kick URL + key, scene/source created, 1080p60 applied and read back; page says it is NOT yet verified on a live stream (stand-in OBS) (1.9s) |
| ✅ PASS | 7. Audio test: test voice runs, page names the provider | provider/status displayed; no silent fallback (2.7s) |
| ✅ PASS | 8. Avatar & animation test buttons respond | expression test sent (0.3s) |
| ✅ PASS | 9+10. Health and CHECK EVERYTHING with honest statuses | statuses shown with the allowed words only (2.6s) |
| ✅ PASS | Go-live needs explicit confirmation and Kick must confirm LIVE | unconfirmed start refused; OBS streaming ≠ live (not claimed); LIVE shown only after Kick reported it (0.8s) |
| ✅ PASS | E-stop works from the Control Center | engaged and released (0.1s) |
| ✅ PASS | No secrets in logs / no browser errors | none of the pasted secrets appear in the service logs; 0 page errors (0.0s) |

> REAL: Anthropic API. STAND-INS: OpenAI, Kick, OBS (unreachable/not installed on the build machine). See docs/TEST-RESULTS.md.
