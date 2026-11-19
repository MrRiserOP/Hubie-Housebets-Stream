# OpenAI key — OPTIONAL text-only backup brain

Hubie's brain is **Anthropic Claude** and its voice is **ElevenLabs**. OpenAI is no longer used for voice at all (there is no OpenAI speech call, setting or fallback in Hubie).

If you want a second text brain in case Anthropic is unavailable:

1. Create a key at <https://platform.openai.com/api-keys> (it starts with `sk-`).
2. Control Center → **1 — AI brain** → **OpenAI API key (optional backup)** → **Save & test**.

Hubie uses it only to write lines when Anthropic fails; the model is `OPENAI_MODEL` in `.env`.
