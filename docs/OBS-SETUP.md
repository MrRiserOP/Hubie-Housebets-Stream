# OBS + Kick streaming (Control Center → 6)

**OBS Studio** (free) is Hubie's encoder: it sends Hubie's picture and voice to Kick. Hubie drives OBS through OBS's built-in remote control (WebSocket): it creates the scene and overlay, routes Hubie's voice into the stream, sets 1080p60 to Kick's published requirements, puts in your Kick stream URL + key, and starts/stops the stream.

**Why OBS?** Streaming for hours from a plain browser is not reliable (audio capture, reconnects). OBS is free, recovers from dropped connections and lets you check everything first.

**The OBS WebSocket password, the Kick app secret and the Kick stream key are three different things** — see [KICK-SETUP.md](KICK-SETUP.md).

## On your own computer

1. Install OBS from <https://obsproject.com/download> and open it.
2. In OBS: **Tools → WebSocket Server Settings** → tick **Enable WebSocket server** → **Show Connect Info** → copy the **Server Password**.
3. In Hubie section **6** enter `ws://127.0.0.1:4455` and the password, then **Save & connect**. Status becomes *Connected (OBS 3x)*.
4. In section **5** paste your Kick **Stream URL** and **Stream Key** (Kick Creator Dashboard → Settings → Stream URL & Key). They are stored on the server and pushed into OBS as a custom RTMP(S) service. Never show the key on stream.
5. Back in section 6: **Set up the Hubie scene automatically** (scene "Hubie Live", the overlay as a 1920×1080 browser source at 60 fps with OBS-controlled audio), then **Apply 1080p60 settings** and **Run 30-second local performance test** (see below).
6. Press **Test voice on stream overlay / OBS** in section 7; the OBS audio meter line should show sound.

## 1080p60 — what Hubie sets, and what counts as "verified"

Kick's published limits: **H.264 only · CBR only · max 8,000 kbps · max 1920×1080 · max 60 fps · keyframe every 2 s · stereo audio up to 48 kHz**; for 1080p60 use **6,000–8,000 kbps** and an upload speed of at least twice the bitrate. Kick's encoder guidance: x264 *veryfast / profile main / tune zerolatency*, or NVENC *P6 Slower · Ultra Low Latency · single pass · profile main*.

**Apply 1080p60 settings** (stream must be stopped) writes, through OBS's remote control: canvas 1920×1080, output 1920×1080, **60 fps**; Simple output mode, encoder **x264**, **6,000 kbps CBR**, preset veryfast, custom options `keyint=120 profile=main tune=zerolatency` (120 frames = 2 s at 60 fps), audio **48 kHz stereo 160 kbps**, and the overlay browser source at 60 fps. It then **reads every value back from OBS** and shows a ✓/✗ table; a ✗ row names the wrong value and what Kick wants.

Three levels of evidence — the page says which one you have:

| Level | What it proves | How |
|---|---|---|
| **Settings read back** | OBS holds the 1080p60 / Kick-compliant settings | automatic after *Apply* |
| **Local performance test** | this PC can render 60 fps and encode 1080p60 without skipping frames (nothing is broadcast; a 30-second recording is saved in OBS's recording folder, the path is shown) | button *Run 30-second local performance test* |
| **Verified on a live stream** | OBS itself measured ≥ 58 fps, bitrate ≤ 8,000 kbps, no skipped frames and low congestion over **one full minute of real streaming** with all settings still correct | automatic, shown only after it really happened |

Until the last row is shown, Hubie says "**not verified on a live stream yet**" — it never claims 1080p60 works from settings alone.

**If it stutters:** lower the bitrate by 1,000 kbps (Kick's advice); if the page reports encoder-skipped frames, your CPU cannot run x264 at 1080p60 — switch to a hardware encoder in OBS (Settings → Output → Advanced): **NVIDIA NVENC** (preset P6 Slower, tuning Ultra Low Latency, multipass single pass, profile main) or AMD hardware H.264 with the same keyframe (2 s) and CBR, then keep Hubie's other settings. Hubie cannot set NVENC's tuning remotely, so that one is a manual change in OBS.

## Going live (always manual)

Kick has **no private test stream**: whatever you send to your key is public. So Hubie never starts by itself:

1. Section **10** checklist must be green (or you accept the warnings).
2. Press **▶ Start Kick stream (public)** in section 5 and confirm. The API refuses to start without that confirmation.
3. Hubie shows **LIVE** only after **Kick reports the channel as live**. If OBS is sending but Kick says offline, the page says exactly that.

## If OBS or Hubie crashes

Hubie reconnects to OBS with backoff, re-creates the scene idempotently and, **only if the crash was within the last 10 minutes while live**, restarts the stream. An old "was live" flag never starts a stream.

## On a server (VPS)

`INSTALL-HUBIE.sh` installs OBS for you (virtual screen + virtual sound card, already connected). You only do steps 4–6. See [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md).
