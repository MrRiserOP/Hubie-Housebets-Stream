# ElevenLabs key — Hubie's voice

Claude (Anthropic) writes Hubie's lines; **ElevenLabs** speaks them. It is the only voice provider. If it is unavailable Hubie falls back to the browser's built-in voice, and the page always labels that **"Browser voice (fallback — not ElevenLabs)"**.

## Get a key

1. Sign in at <https://elevenlabs.io/>.
2. Go to **Developers → API Keys** (<https://elevenlabs.io/app/settings/api-keys>) → **Create API key**. Enable **Text to Speech** and **Voices: read**. Copy it (starts with `sk_`).

## Put it in Hubie

1. Control Center → **2 — Voice** → paste the key → **Save & test**. Hubie checks it against your account and lists your voices. A wrong key is rejected and not saved.
2. Pick a voice: cards show the recommended ones (★) first — **Charlie** (default: energetic, warm, playful), Liam, Will, Chris, Jessica, George, Brian. Press **▶** on a card to hear it, **Select** to choose, or paste any voice ID under *advanced*.
3. Press **▶ Preview (normal)**, **▶ Big win** and **▶ Sarcastic loss** to hear how the same voice changes with emotion. Adjust *stability / style / similarity / speed* if you want.
4. Press **Use this voice**. Section **7** (Audio test) plays a line through the same path the stream uses and shows that OBS received it.

The same key and voice also work from `.env` (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, see `.env.example`); you never have to edit code.

## How Hubie uses it

- Each line is spoken with an emotion-matched delivery (excited, disappointed, sarcastic, warm…): the emotion adjusts stability, style and speed within safe limits, so Hubie is expressive but not always shouting.
- Model `eleven_turbo_v2_5` by default (fast); `eleven_flash_v2_5` and `eleven_multilingual_v2` are selectable.
- Generated audio is cached (same line + voice + settings = one request) and limited by `ELEVENLABS_MAX_CHARS_PER_HOUR` (default 100,000).
- The overlay plays the MP3 and moves Hubie's mouth from the **actual sound**; OBS captures the overlay's audio, so the stream carries the same voice you previewed.
- Errors are explained in plain words: invalid key, key missing a permission, out of credits (402), voice not found, rate limit.

## What was and was not verified

Verified automatically against a **stand-in** ElevenLabs server (request format, headers, error handling, caching, preview playback with a measured audio level, routing to the overlay/OBS path, no OpenAI audio calls anywhere). **Not verifiable without your key and speakers:** how the voices actually sound, and your account's quota. Do the 1-minute check above (steps 1–3) and listen.
