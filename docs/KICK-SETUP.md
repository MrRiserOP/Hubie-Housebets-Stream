# Kick setup — step by step (Control Center sections 4 and 5)

Hubie uses **only Kick's official, documented API** ([docs.kick.com](https://docs.kick.com) · [KickDevDocs on GitHub](https://github.com/KickEngineering/KickDevDocs)). Nothing unofficial (no scraped chat sockets, no password logins).

## Three different sets of credentials — never mix them

| What | Used for | Where you get it | Where you paste it in Hubie |
|---|---|---|---|
| **Kick app Client ID + Client Secret**, then a login on Kick's own page | Chat in/out, title/category, live status, moderation | kick.com → Settings → **Developer** → create an app | Section **4** wizard, step 1, then **Connect Kick account** |
| **Kick Stream URL + Stream Key** | Video: OBS → Kick | kick.com → **Creator Dashboard → Settings → Stream URL & Key** | Section **5**, step 1 |
| **OBS WebSocket address + password** | Hubie controls OBS (scene, start/stop) | OBS → Tools → WebSocket Server Settings | Section **6** |

The Client Secret and the Stream Key are **write-only**: after you save them the page only says "saved ✓". They are stored in the server's `.env` (owner-only file) and never go to the browser, logs or GitHub.

## Section 4 — "Connect Kick Chat" (the wizard)

Everything is a button; no terminal commands. The page lists the steps, ticks each one only when it is **measured**, and shows the single address you must paste into Kick.

**What you do (about 5 minutes):**

1. **Create the Kick app.** On kick.com: Settings → **Developer** → *Create app* (Kick requires two-factor login). Name it "Hubie". Paste the **Redirect URL** shown in step 1 of the wizard, tick every permission offered, save. Copy the **Client ID** and **Client Secret** into the wizard with your channel name and press **Save and turn Kick on**.
2. **Press "Connect Kick account"** (log in to kick.com as the channel owner first). Kick's own page opens; approve. Hubie finishes by itself, lists which permissions Kick granted, and says exactly which one is missing if you un-ticked any (it then tells you to press **Reconnect**).
3. **Public address.** Hubie starts Cloudflare's free quick tunnel for you (it downloads the official `cloudflared` the first time; no account needed) and verifies the address answers from the internet.
4. **Paste the ONE address** shown in step 4 into your Kick app: kick.com/settings/developer → your app → **Enable Webhooks** → paste into *Webhook URL* → Save.
5. **Press "Test Kick Chat".** Hubie posts a test message in your chat, then **type `hi Hubie`** in your Kick chat. Hubie always answers when its name is in a message.

**"Connected" appears only when all three have been measured:** Kick accepted a message Hubie posted · Kick delivered a real, signature-checked message to your current address · Hubie replied to it. A saved login, a running tunnel or a toggle is never shown as Connected. The status panel lists account, permissions, receiving, sending, address, last message received/sent, and any error in plain words. **Reconnect** and **Re-check subscription** fix most problems.

**Know this about the free tunnel:** its address changes whenever it restarts (for example after you restart your PC). Hubie notices, turns the "paste the address" step back to not-confirmed and shows the new address; paste it into the Kick app again and press Test Kick Chat. For a permanent address use the VPS installer (it sets a stable `https://<ip>.sslip.io/kick/webhook`) or a Cloudflare named tunnel plus the "fixed address" box under *More*.

**Things Hubie handles for you:** the Kick login is renewed automatically (a revoked login shows "press Reconnect"); Kick sometimes answers "OK" but refuses the chat subscription — that is shown as an error, not hidden; Kick drops subscriptions after a day of failed deliveries, so Hubie re-checks every 30 minutes; if you post as the channel owner, your own "hi Hubie" is still answered while Hubie's own messages are ignored.

What Hubie does with chat: reads it, answers questions and greetings **by username**, ignores or deletes spam, links and abuse, never repeats secrets, never encourages deposits or promises winnings, and posts at most one message every few seconds.

### Manual check (needs your real Kick account — cannot be done from the build machine)

Wizard steps 5–7 turning green on your real channel is the test: ✓ Hubie can post · ✓ Kick delivered "hi Hubie" · ✓ Hubie replied. Until then the page says "Not connected until the test passes".

## Section 5 — Kick stream

1. Paste **Stream URL** (starts with `rtmps://`) and **Stream Key** from your Kick Creator Dashboard. Hubie pushes them into OBS as a *custom* streaming service.
2. Set **title** and **category** (type to search, e.g. *Slots & Casino*) and press **Update on Kick**.
3. **There is no private test stream on Kick.** Anything you send to your stream key goes live on your channel. So the last step is always a **manual confirmation**: press **▶ Start Kick stream**, then confirm. Hubie shows **LIVE only after Kick itself reports the channel as live**, never just because OBS is sending.

## What is verified

See [TEST-RESULTS.md](TEST-RESULTS.md). In short: the Kick code was tested against a **stand-in** for Kick (the real Kick cannot be reached from the build machine). A real account still needs the 5-minute check above (steps 4 and 6).
