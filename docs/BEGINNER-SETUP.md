# Hubie — beginner setup (no coding)

You only need to do these steps once. Everything is set in the **Hubie Control Center**, a web page Hubie opens for you. You never edit code or files.

**You'll need:**
- a computer (Windows, Mac or Linux) or a rented server (see [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md));
- an **Anthropic API key** for Hubie's brain ([ANTHROPIC-SETUP.md](ANTHROPIC-SETUP.md));
- an **ElevenLabs API key** for Hubie's voice ([ELEVENLABS-SETUP.md](ELEVENLABS-SETUP.md));
- a Kick account (with two-factor login on) and a Kick developer app ([KICK-SETUP.md](KICK-SETUP.md));
- OBS Studio, which is free ([OBS-SETUP.md](OBS-SETUP.md)).

---

## 1. Start Hubie

**On Windows:**
1. Unzip the `hubie-streamer` folder somewhere, for example `Documents`.
2. Double-click **`START-HUBIE.bat`**.
   - If Node.js is missing, a download page opens. Install the "LTS" version, then double-click `START-HUBIE.bat` again.
   - The first start takes a few minutes while it downloads its parts.
3. Your browser opens the **Hubie Control Center** at `http://127.0.0.1:8787/setup`.
4. Keep the black window open; closing it stops Hubie.

**On Mac or Linux:** open a terminal in the folder and run `./start-hubie.sh`.

**On a server (VPS):** run `bash hubie-streamer/INSTALL-HUBIE.sh`. See [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md).

## 2. Work through the Control Center, top to bottom

| Section | What you do | Guide |
|---|---|---|
| **1 — AI brain** | Paste your Anthropic key → **Save & test**. Claude writes the lines; ElevenLabs (section 2) speaks them. | [ANTHROPIC-SETUP](ANTHROPIC-SETUP.md) |
| **2 — Voice** | Paste your ElevenLabs key → **Save & test**, press **▶** on a voice card, **Select**, **Use this voice**. Use **■ Stop** and the volume slider as needed. | [ELEVENLABS-SETUP](ELEVENLABS-SETUP.md) |
| **3 — Limbo game** | Optional: change the win weights, targets, bet and the delay between rounds, then **Save settings**. Pause/resume the game here. | below |
| **4 — Kick chat** | Follow the numbered steps: channel, Kick app, webhook address, login, test message. | [KICK-SETUP](KICK-SETUP.md) |
| **5 — Kick stream** | Paste Stream URL + Key, set title and category. Going public is the last step and needs a confirmation. | [KICK-SETUP](KICK-SETUP.md) |
| **6 — OBS** | Connect OBS, **Set up the Hubie scene automatically**, **1080p**. | [OBS-SETUP](OBS-SETUP.md) |
| **7 — Audio test** | **Test voice** here and on the overlay/OBS; shows provider, volume and any error. | [TROUBLESHOOTING](TROUBLESHOOTING.md) |
| **8 — Avatar** | Try expressions and animations; set title, size, layout. The 18+ and responsible-gambling notices always stay on. | — |
| **9 — System health** | Every component with its state and last problem. | — |
| **10 — Checklist** | **CHECK EVERYTHING**, then **▶ START HUBIE**. | [TROUBLESHOOTING](TROUBLESHOOTING.md) |

### The game (section 3)

- Hubie plays **Limbo**, his own local game page. A random engine picks the result of each round; the page animates it; Hubie's commentary is checked against the real numbers.
- The balance is play money only. There is no login, deposit or real casino anywhere.
- The distribution is **win-heavy by design** (settings file `config/limbo-sim.json`, editable in section 3). The measured distribution is in `docs/TEST-REPORT-limbo-distribution.md`.
- Round delay, bet, auto-target, pause/resume are all in section 3. The round counter survives restarts.

## 3. During the stream

- **■ EMERGENCY STOP** is at the bottom left of the Control Center. It silences Hubie straight away and pauses the game; the overlay shows "short break".
- The **Operator panel** link opens extra controls: next segment, test events, and test chat.
- To stop: in **H — Go live**, press **STOP HUBIE & stream**. You can also close the black window on Windows, or run `hubie stop` on a server.

## Security, in plain words

- Keys and tokens are stored **only** in the `.env` file on the machine running Hubie, which only its owner can read.
- After you save a key, the page shows only `sk-ant-••••••••`. Keys never appear in the browser, in logs or in screenshots.
- From another computer, the Control Center needs the secret link with `?token=…`. Keep that link private.
