# Anthropic (Claude) key — Hubie's brain

Claude writes everything Hubie says: round commentary, chat replies by username, jokes and segment openers.

> **An Anthropic key does NOT give Hubie a voice.** Anthropic has no text-to-speech service. For the voice you also need an ElevenLabs key ([ELEVENLABS-SETUP.md](ELEVENLABS-SETUP.md)). With both keys saved, Claude thinks and OpenAI speaks.

## Get a key

1. Go to <https://console.anthropic.com/> and sign in or create an account.
2. Add credits: **Settings → Billing**. Hubie uses very little. In our tests one line cost a few hundred tokens with Claude Haiku.
3. Open **Settings → API Keys → Create Key**, name it "Hubie", and copy it. It starts with `sk-ant-`.

## Put it in Hubie

1. Open the Control Center, section **A — AI brain**.
2. Paste the key into **Anthropic API key**, then press **Save & test**.
   - ✅ "Saved and tested ✓ — Claude replied…" means you're done.
   - ❌ "Anthropic rejected the API key" means you copied it incompletely, or it was deleted. The key is **not** saved.
   - ❌ "no credits" means you need to add credits in Billing.
3. Optional settings:
   - **Claude model:** Haiku is the fastest, and recommended for live commentary.
   - **Provider:** Automatic is the default and uses Anthropic when its key is saved.
   - **If the main AI fails:** "Use the other AI" switches to OpenAI automatically.

On a server you can instead run `hubie set-key anthropic`; your typing is hidden.

## How Hubie uses it

- He calls Claude through the official SDK, with a fixed answer format, so every line arrives with an emotion, an expression and an animation.
- Each call has a 12-second timeout and one retry. After repeated failures he switches to OpenAI if that key is saved. He uses built-in lines only when **no** AI works.
- An hourly limit (`AI_MAX_CALLS_PER_HOUR`, default 900) prevents surprise bills.
- Every 10 minutes the log records calls, errors, tokens and average speed. It never logs keys or prompts.
- Prompts treat chat as untrusted data. Hubie never promises wins, never encourages deposits and never reveals his instructions.

**After the contest:** rotate the key at console.anthropic.com → API Keys, especially if you ever pasted it anywhere other than the Control Center.
