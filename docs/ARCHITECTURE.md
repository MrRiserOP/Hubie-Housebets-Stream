# Architecture: agents and tools

## Process / agent diagram

```mermaid
flowchart LR
  subgraph Game["game-agent (process)"]
    GA[Round runner<br/>pause / resume / restart] --> AD{{GameAdapter}}
    AD --> LB[limbo-sim<br/>local Limbo page + crypto RNG engine]
    LB --> CH[(Chrome)]
    CH -- CDP screencast --> GA
  end

  subgraph Chat["kick-agent (process)"]
    TW[Kick signed webhooks<br/>chat.message.sent · livestream.status.updated] --> CA[rate-limited sender<br/>POST /public/v1/chat]
  end

  subgraph Ctl["controller (process)"]
    HUB((WebSocket hub<br/>+ HTTP))
    DIR[Show director<br/>segments · persistence]
    COM[Commentary director<br/>priorities · pacing · chat policy]
    SAFE[Safety<br/>inbound + outbound]
    LLM[Brain: Anthropic Claude (default) → OpenAI backup<br/>structured output · context · demo lines only if no AI works<br/>circuit breaker per provider]
    VAR[Repetition guard<br/>similarity · openers · fillers]
    TTS[Voice: ElevenLabs<br/>emotion-matched settings · cache · usage cap<br/>→ browser fallback]
    SETUP[Control Center API<br/>keys server-side · masked · Kick OAuth 2.1 + PKCE · OBS · CHECK EVERYTHING]
    SQ[Speech queue<br/>one voice · interrupt · ack]
    MEM[(SQLite memory<br/>show state · viewers · lines · rounds)]
    HL[Health registry<br/>heartbeats]
    ES[E-stop<br/>API · file · panel]
    HUB --> COM --> SAFE --> LLM --> VAR --> SAFE2[outbound safety] --> TTS --> SQ --> HUB
    HUB --- SETUP
    DIR --- COM
    COM --- MEM
    HUB --- HL
  end

  subgraph Stream["stream-engine (process)"]
    OBSC[OBS websocket v5<br/>scene setup · start/stop<br/>audio meters · refresh]
  end

  subgraph Browser["overlay page (OBS browser source)"]
    OV[React overlay 1920×1080]
    RIG[Hubie SVG rig<br/>animation director: expressions · combos · idle · springs]
    SP[Speech player<br/>WebAudio + analyser lip-sync]
    GFX[Graphics: captions · subtitles · banners<br/>callouts · title cards · ticker · particles]
    OV --- RIG --- SP
    OV --- GFX
  end

  GA -- game_event / game_frame --> HUB
  HUB -- play_round / pause --> GA
  TW -- chat_in --> HUB
  HUB -- chat_out --> CA
  HUB -- say / expression / state / frames --> OV
  SP -- speech_started / ended / heartbeat --> HUB
  HUB -- obs_command / state --> OBSC
  OBSC --> OBS[(OBS Studio)]
  OBS -- loads --> OV
```

Rendered PNG (same content): [architecture.png](architecture.png)

## Flow of one round (v2)

1. The **commentary director** sees Hubie is quiet, the segment allows gameplay and the round interval has passed. It sends `play_round`.
2. The **game agent** sets the round parameters (for example a Limbo target), presses the demo **Play** control, waits for the outcome (DOM data or detected text change), then sends `round_started` → `round_result` / `big_win` / `bonus_triggered`.
3. The director dedupes by round id, updates stats and streaks, and records events and memorable facts. It immediately sends a body-language **combo** (`big_win`, `surprise`, `bad_result`…) and effects (confetti, zoom). Then it builds a structured **Situation**:
   - routine rounds get a brief line, and two may be grouped into one;
   - interesting rounds get a full reaction;
   - big wins get priority 90, may interrupt, and start a *Celebration* segment.
4. The **speech queue**:
   - asks the **brain** for `{text, emotion, expression, combo, caption}` using the full context;
   - runs the **repetition guard** (regenerate, or drop if low priority);
   - runs **outbound safety** on the line and the caption;
   - asks the **voice** for audio with the line's emotion;
   - broadcasts `say`.
5. The **overlay**:
   - plays the audio through WebAudio; an `AnalyserNode` drives the jaw and mouth shape every frame;
   - plays the line's **combo** when the audio starts;
   - the animation director blends in the expression, idle life, talk gestures and blinks;
   - the graphics show word-synced subtitles, the reaction caption and the viewer callout.
6. The overlay acks `speech_ended`. If no ack arrives, a timeout of duration × 1.6 + 4 s releases the queue. Then the director requests the next round.

## Tools and interfaces

| Interface | Implementations | Fallback |
|---|---|---|
| `LLMProvider.generate(situation, ctx)` | `AnthropicLLM` (default when its key is set; forced tool call for structured output), `OpenAIResponsesLLM`, `MockLLM` (demo) | `ResilientLLM` tries each configured real provider in order (`LLM_PROVIDER=auto`: Anthropic → OpenAI); demo lines only when none works. Bad key or no credits → 10 min cooldown; transient errors → circuit after 3 failures. Errors are explained in plain words. |
| `TTSProvider.synth(req)` | `ElevenLabsTTS` (default when its key is set), `EspeakTTS` (opt-in), `BrowserTTS` | `VoiceService` chain `TTS_PROVIDER` → `TTS_FALLBACKS` (default `browser`), with a per-provider circuit breaker and disk cache |
| `GameAdapter` | `LimboSimAdapter` (default; Hubie's own Limbo page, engine decides, page animates, adapter reads back and rejects any mismatch) | — |
| Streaming platform | `kick-agent` (official Kick API: OAuth 2.1 + PKCE, REST, signed webhooks) | Another platform needs only to emit `chat_in` and consume `chat_out` |

## Configuration and secrets

- The Control Center writes `.env` on the server (atomic write, chmod 600). Only an allow-list of keys can be written, and newlines are stripped, so a value can't inject extra settings.
- Secrets are only ever returned **masked** (`sk-…abcd`).
- Changing settings hot-swaps the AI and voice providers in the controller. The game, chat and stream agents get `reload_config`, exit cleanly and are restarted by PM2 or the supervisor with the new settings.
- API access requires **this machine (localhost)** or the `CONTROL_TOKEN` (the VPS installer generates one and prints the private link). Forwarded/proxied requests are never treated as local.

## Safety layers

- **Inbound** (`checkInbound`): normalises Unicode (removes zero-width and bidi characters), then:
  - blocks slurs, abuse and links;
  - detects prompt injection and secret probing, and answers with a playful deflection without following it;
  - spots self-harm mentions and answers with a fixed, non-LLM support line;
  - a `SpamGuard` handles duplicate ids, repeated text and per-user floods.
- **Prompt isolation**: the persona and rules are the only system prompt. Chat goes into the user turn as quoted JSON and is labelled untrusted data.
- **Outbound** (`checkOutbound`): applies to every spoken line and every chat post. It blocks:
  - promises of winnings and deposit encouragement;
  - gambling pressure and misleading financial claims;
  - links, promo codes and referrals;
  - credential patterns and prompt disclosure.
- **Logs**: secrets are redacted.
- **No real-money surface**: the game is a local page with a play-money balance; Hubie never visits a real casino.
- **Emergency stop**: from the control panel, `POST /api/estop`, `npm run estop`, or the `data/ESTOP` file. It clears speech, pauses the game, drops queued chat and shows a "short break" screen.

## Recovery model

| Failure | Detection | Action |
|---|---|---|
| Process crash (any) | PM2 / local supervisor | Restart **that** process only, with exponential backoff and a cap on restarts |
| Game browser crash or hang | `disconnected` / `crash` events, a 5 s liveness probe, 3 consecutive round failures | Relaunch the browser with backoff (2 s → 60 s, 8 tries), then 2 min cooldown or labelled simulated fallback |
| Hub disconnect | WebSocket close | Every client reconnects with backoff. Messages are queued (frames dropped). |
| LLM outage | Errors or timeouts | Mock lines plus circuit breaker. Health: `ai=degraded` |
| TTS outage | Errors or timeouts | Next provider in the chain. Health: `tts=degraded` |
| Overlay dead | No heartbeat for 15 s | `avatar=down`. Stream engine refreshes the OBS browser source (at most once a minute). The speech queue keeps pacing on timeouts. |
| Kick | API unreachable, agent crash, bad/forged webhook, expired token | Health `degraded`/`down` with the reason; agent restarts by PM2; token refresh + one 401 retry; forged/stale/unsigned webhooks rejected (401) and counted; duplicate deliveries ignored |
| OBS restart | `ConnectionClosed` | Reconnect with backoff, re-create the scene/source idempotently, restart the stream if it should be live (`data/obs-state.json`) |
| Controller restart | — | Show state comes back from SQLite (segment, stats, timers). Hubie says a short "technical nap" line instead of re-welcoming. |
