# Running Hubie's stream in Streamable's cloud

Goal: your PC only opens the Hubie Control Center in a browser. Nothing is rendered or encoded on it.

## What is supported, what is not (honest status)

| Need | Status |
|---|---|
| Cloud OBS that renders a web page and encodes 1080p60 on a GPU | **Documented by Streamable** (Remote OBS, NVIDIA T4-class servers, Browser Sources). |
| Streamable → Kick output | **Documented** (Destinations → Kick, "Login with Kick" or stream URL + key). |
| Hubie's overlay (avatar, subtitles, game frames, ElevenLabs voice) inside cloud OBS | **Built**: it is one web page used as a Browser Source. Voice plays in that page, so OBS captures it. |
| Streamable public API / OAuth / server list / server status / server control | **No public documentation found. Not implemented. Not claimed.** Send me the docs link or example requests and token scopes and I will add it. |
| OBS WebSocket / scene or source API for cloud OBS | **None documented.** `172.18.0.2:4456` is a Docker-internal address inside Streamable. Hubie never connects to it. |
| Server CPU/RAM/GPU model | Not available by API. Hubie reports what the browser inside cloud OBS sees (GPU string, fps). Read the rest in Remote OBS → View → Stats. |
| Start/stop the cloud stream from Hubie's button | **Not possible without an API.** You press Start in Streamable. (Streamable's chat commands `!startstream`/`!endstream` exist but only run from the connected broadcaster account; untested, not wired.) |

## Architecture

```
Your PC (browser only) ──► Hubie Control Center (private, on the server)
Hubie server (small CPU VPS): brain, game player, Kick chat, ElevenLabs
        │  public, read-only: https://<host>/overlay?cloud=1&otoken=…
        ▼
Streamable cloud OBS: Browser Source 1920×1080 @ 60 → GPU encode → Kick
```

The game agent runs on the Hubie server (headless browser, no GPU needed); its frames reach the overlay through the hub.

## Setup (once)

1. **Server:** `HUBIE_CLOUD=1 bash INSTALL-HUBIE.sh` on an Ubuntu VPS (see VPS-DEPLOYMENT.md). It sets cloud mode, does not install OBS, and exposes only the read-only overlay publicly. The Control Center and every `/api` call stay private (use the secret link it prints).
2. **Control Center → 11 Cloud (Streamable):** copy the overlay link.
3. **Streamable → Remote OBS:** add a **Browser Source**, paste the link, width **1920**, height **1080**, custom frame rate **60**. Keep it above any ingest layer. Do not mute it: OBS captures the voice from this source.
4. **Streamable → Destinations:** add Kick. Output H.264, CBR, ≤ 8,000 kbps (6,000 is a safe start), keyframe 2 s.
5. Press **Start Stream in Streamable**. Hubie's Kick status confirms whether Kick really shows you live.

The overlay link is view-only: it can only act as an overlay page and cannot control Hubie. If it leaks, press **New link** and update the Browser Source.

## Performance check (do this before a public stream)

Hubie reports, from inside cloud OBS: overlay fps, 95th-percentile frame time, browser size, and whether the browser renders on a GPU or in software. The Control Center shows a verdict.

Then, in Remote OBS, open **View → Stats** for 5 minutes and check: dropped frames 0 %, skipped/lagged frames 0 %, CPU low, bitrate steady. Hubie cannot read these. Do not call 1080p60 verified until they look right and Kick shows the stream at 1080p60.

## Manual tests (not possible from the build machine)

- Browser Source in real Remote OBS shows the avatar, game and subtitles.
- Voice is audible in the OBS meters and on Kick.
- Control Center verdict turns green; Stats dock clean for 5 minutes.
- Kick shows LIVE; PC CPU stays idle with only the browser tab open.

## Fallback

If Streamable's browser source runs in software or cannot hold 60 fps, run Hubie on a GPU/CPU VPS with OBS (default mode, OBS-SETUP.md) and send to Kick from there — also nothing on your PC.
