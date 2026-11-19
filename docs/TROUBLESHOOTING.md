# Troubleshooting

Start with **Control Center → 10 → CHECK EVERYTHING**. Each line tells you what is wrong and what to press. Below are the common cases.

## AI brain (1)

| You see | Fix |
|---|---|
| "Anthropic/ElevenLabs rejected the API key" | Copy the whole key again; it is long. Make sure it wasn't deleted in the provider's console. |
| "no credits" / "billing is not set up" | Add credits: console.anthropic.com → Billing, or platform.openai.com → Billing. |
| "Could not reach Anthropic/OpenAI" | The machine has no internet, or a firewall or proxy blocks `api.anthropic.com` / `api.openai.com`. |
| The "DEMO MODE" badge on the overlay | No AI key is saved. Hubie is using built-in lines. Add a key in A. |
| Lines feel slow | Use Claude **Haiku** (A → Claude model). |

## Voice (2)

| You see | Fix |
|---|---|
| "Browser voice (fallback — not ElevenLabs)" on the overlay | No ElevenLabs key, or ElevenLabs is failing (invalid key, out of credits, rate limit — the voice section says which). An Anthropic key gives no voice. Fix the key in section 2 and press **▶**. |
| No sound in a normal browser tab | Browsers block sound until you click. Click the overlay once. In OBS, sound is always allowed. |
| Lip-sync "Not tested" in G | Open the overlay, then press **Test speech** in B. |

## Limbo game (3)

| You see | Fix |
|---|---|
| Game panel black / "game display" down | Press **Restart game** in section 3. Hubie relaunches the game browser by himself within a minute. |
| Rounds stop | Check the **Pause** state in section 3 and the emergency stop. |
| Win share looks off | Section 3 shows the configured weights; `docs/TEST-REPORT-limbo-distribution.md` shows the measured result over 100,000 rounds. |

## Kick chat (4) and stream (5)

| You see | Fix |
|---|---|
| "Not configured — missing Client ID…" | Create the Kick app and save Client ID + Secret (4, step 2). |
| "Kick channel … was not found" | The channel name must match `kick.com/<name>`. |
| Login says "invalid client" / "redirect" | The **Redirect URL** in your Kick app must be exactly the one shown in step 2. |
| Can post but not read chat ("chat reading not set up") | Kick needs a public **HTTPS** webhook address in your Kick app and in step 5. On the VPS the installer creates it. |
| Chat messages stop after a day | Kick drops event subscriptions after failed deliveries. Press **Re-check subscriptions**; Hubie also does this every 30 min. |
| "rejected webhook: bad signature" count rises | Someone is posting fake events to your webhook address. They are all rejected; nothing to do. |
| Test message fails (403/401) | Reconnect the account (4, step 4) so the chat scope is granted. |
| OBS streaming but Hubie says "waiting for Kick" | Kick has not reported the channel live yet. Check the stream key and the Kick dashboard. |

## OBS (6)

| You see | Fix |
|---|---|
| "cannot reach OBS" | OBS isn't running, or its WebSocket server is off (Tools → WebSocket Server Settings). Check the password. |
| Voice not reaching OBS | Press **Set up OBS scene automatically** again; it re-applies "Control audio via OBS". Then press **Test speech**. |
| Private test fails | Wrong stream key, or not enough upload speed. 1080p30 needs about 6 Mbit/s up. |
| "Stop the stream before changing video settings" | OBS can't change resolution while live. Stop the stream first. |

## Server (VPS)

- `hubie status` shows every component's health.
- `hubie logs` shows live logs.
- Can't open the link?
  - Use the SSH-tunnel link from `hubie link`.
  - Check that your provider's own firewall also allows port 8787, or use only the tunnel.
- The installer stopped? Read the last lines of `/var/log/hubie-install.log`.

## Emergency

**■ EMERGENCY STOP** in the Control Center, or `hubie estop` on a server, silences Hubie and pauses the game immediately. Resume the same way.
