# Entertainment upgrade — what changed and how to use it

Everything below is managed from the **Control Center** (`/`), sections 12–16. Nothing needs source-code edits.

## Control Center map

| # | Section | What you control |
|---|---|---|
| 12 | Personality | Humour, sarcasm, friendly roasting, commentary amount (quiet / balanced / chatty), how often he answers chat, repetition guard, **hat policy**, conversation memory length. Shows the recent conversation, the last humour style used and how many hat lines were blocked. |
| 13 | Voice keys & music | ElevenLabs key manager (add, test, enable/disable, reorder, remove), failover history, errors, usage; local-fallback choice; background-music on/off, volumes, ducking, mood, per-track switches. |
| 14 | Avatar animation | Intensity, idle life, talking gestures, big reactions, listening/thinking cues; a live "Hubie is: …" state badge; preview buttons for each reaction. |
| 15 | Streaming / ON AIR | Confirmed-live status, total live time, current session, session history, disconnect log. |
| 16 | Monitoring | Controller memory/CPU/event-loop lag (1 h history), speech queue, voice engine and usage, AI errors, music and avatar state, component health. |

## Personality

* The hat is **only a visual**. By default he mentions it only when a viewer does (`Only when a viewer mentions it`). It is enforced three ways: the prompt, a per-line "hat allowed" flag, and a post-generation check that regenerates a line that mentions it anyway.
* Nine humour styles (situational, sarcasm, quick comeback, playful roast, storytelling, unexpected, self-deprecating, internet-humour, plain/straight) are rotated with recency penalties, so he does not lean on one. Not every line is a joke.
* Short-term conversation memory (default 24 turns) understands tone (question / joking / teasing / compliment / criticism / thanks / greeting), follow-ups and recurring viewers, and never answers the same message twice. Repetition is checked against recent lines (strict mode by default).
* Game commentary comes only from structured game events; the model is told never to invent wins, payouts or multipliers, and a fact-checker fixes lines whose numbers disagree with the event.

## ElevenLabs key management

* Priority order = top to bottom. The first healthy enabled key is used.
* Failover happens automatically on: out of credits / quota (including ElevenLabs' 401 `quota_exceeded`), rate limits (exponential cool-down up to 5 min), invalid or unauthorised keys, and outages (short retry, then the voice service backs off and falls back; an outage is not blamed on a key).
* Exhausted keys are re-checked after their reset time (or 1 h); invalid keys are not retried; rate-limited keys wait out their cool-down. A key that is down is never hit again on every line.
* **Shared allowance:** two keys on the same ElevenLabs account share one quota. Hubie flags this (same limit + reset time + a non-zero used count from the subscription endpoint, or two back-to-back quota errors) and marks both exhausted together, so it moves straight to a key on a different account. Adding more keys from the *same* account does not add credits.
* If every key fails, Hubie uses the free local voice you picked (browser voice or eSpeak). It never silently switches to another paid provider. With the fallback set to *Stay silent*, he keeps streaming without speech.
* Keys are stored in `data/elevenlabs-keys.json` (mode 0600) and only a masked hint (`sk_…abcd`) is ever sent to the browser, shown or logged.
* "Used / limit" per key needs the `user_read` permission on that key; without it the dashboard shows Hubie's own character count instead. Credit figures are estimates.

## Background music

* Five original loops (funky, electronic, chill, hype, ambient), synthesised by `scripts/make-music.py` — no third-party material, CC0. **I have not listened to them** (no audio device here); judge them by ear and drop your own licensed `.mp3/.ogg/.wav/.m4a` files into `data/music/` if you prefer.
* Two decks cross-fade (4 s) so there is never a hard cut or two tracks at full level; the next track is chosen from a shuffled bag with no immediate repeat; mood follows the show segment (or pick one).
* Ducking: the music drops to your chosen level the moment Hubie starts talking and eases back afterwards. Voice and music have separate volumes.
* A track that fails to load is reported, parked for 10 minutes and skipped; if every track fails it retries every minute rather than hammering. A stalled deck is detected by a 1 Hz watchdog.
* Only the overlay page that actually plays sound (the OBS/cloud browser source) runs the music player.

## "150+ HOURS ON AIR" badge and the live counter

* The overlay always shows **`150+ HOURS ON AIR`** as Hubie's established history across earlier streams. It is not a session timer, is not reset by disconnects or restarts, and does not wait for any stream to reach 150 hours. You can turn it on/off or change the wording in Control Center section 15. This is a figure you stated: Hubie does not measure it and cannot verify it.
* Next to it, a separate **status chip** reads `LIVE` only while the stream is confirmed live (Kick API, or OBS streaming when Kick isn't connected); otherwise `OFFLINE` (or `STARTING SOON` before the show starts). Hubie never shows LIVE unless it really is.
* Hubie also keeps a measured live-time counter (section 15): it adds capped steps only from fresh confirmed-live checks, persists across restarts, and never counts time the app was down. It is for monitoring and is independent of the badge.

## Reliability

* Speech queue capped at 10 with expiry; recent-line and conversation caches are bounded; a repeated or already-answered chat message is skipped; one API failure never stops the show (fallback chains, circuit breakers, retry/backoff).
* The Monitoring section samples memory, CPU and event-loop lag every 5 s for an hour so a slow leak is visible.
* See `docs/TEST-RESULTS.md` for what was actually run and for how long. **A 7-day run has not been performed.**

## Known limits

* ElevenLabs, Kick, Streamable and OBS are unreachable from the build machine; those parts were tested against stand-ins only.
* The Anthropic account behind the key in `.env` currently reports *credit balance too low*, so the live personality sample could not be generated; without credit Hubie falls back to built-in demo lines. Add credit before streaming.
