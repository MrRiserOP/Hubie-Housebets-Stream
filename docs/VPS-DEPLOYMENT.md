# Run Hubie 24/7 on a server (VPS)

A VPS is a computer you rent in a data centre. Hubie runs there even when your own computer is off. **Hubie never buys or provisions anything for you**; you choose and pay for the server yourself.

## 1. Choose a server

- **Operating system:** **Ubuntu 24.04** (or 22.04).
- **Size:** at least **4 vCPU and 8 GB RAM**. Hubie, the game browser and OBS encoding 1080p all run on the server. 2 vCPU / 4 GB works only if you stream at 720p.
- **Location:** close to you or to your viewers.
- **Providers:** any well-known one, for example Hetzner, DigitalOcean, Vultr, OVH, Linode or AWS Lightsail. Pick "Ubuntu 24.04", add your SSH key or set a root password, and create the server.
- Write down the server's **IP address**, for example `203.0.113.10`.

## 2. Connect to it

- **Windows:**
  1. Open **PowerShell**.
  2. Type `ssh root@203.0.113.10`, using your IP.
  3. Answer `yes` to the fingerprint question, then enter the password.
- **Mac/Linux:** open **Terminal** and type the same command.

## 3. Copy Hubie to the server and install

On **your computer**, from the folder that contains `hubie-streamer.tar.gz`:

```
scp hubie-streamer.tar.gz root@203.0.113.10:
```

On the **server**:

```
tar xzf hubie-streamer.tar.gz
bash hubie-streamer/INSTALL-HUBIE.sh
```

The installer takes 5–10 minutes. It does the following:
- installs Node.js, PM2 (auto-restart), the game browser and OBS Studio (headless);
- turns on a firewall that keeps SSH open, so you cannot lock yourself out;
- creates a **secret access token**;
- asks for your Anthropic and ElevenLabs keys with your typing hidden. Press Enter to skip; you can add them later.

At the end it prints the following:

```
Open the CONTROL CENTER (keep this link secret — it controls Hubie):
  http://203.0.113.10:8787/setup?token=…
Safer (encrypted) way, recommended before typing any key:
  1. on YOUR computer run:  ssh -N -L 8787:127.0.0.1:8787 root@203.0.113.10
  2. then open:             http://127.0.0.1:8787/setup?token=…
```

**Use the safer way when you type keys.** The plain link travels unencrypted. The SSH tunnel encrypts everything.

> **Streamable cloud mode:** run the installer with `HUBIE_CLOUD=1` to skip OBS on this server and publish only the read-only overlay for Streamable's cloud OBS. See STREAMABLE-CLOUD.md.

## 4. Set up in the Control Center

Follow [BEGINNER-SETUP.md](BEGINNER-SETUP.md) step 2:
- **1:** AI keys. **2:** voice. **3:** Limbo settings. **4:** Kick chat (the installer already filled in the HTTPS webhook address). **5:** Kick stream URL + key. **6:** OBS is already connected on the server. **7–9:** audio, avatar, health. **10:** checklist, then **START HUBIE** and the manual confirmation to go public.

## 5. Everyday commands (on the server)

| Command | What it does |
|---|---|
| `hubie status` | Shows whether everything is running, with each component's health. |
| `hubie logs` | Live logs. Press Ctrl+C to leave. |
| `hubie link` | Shows your Control Center link again. |
| `hubie restart` | Restarts everything. |
| `hubie stop` / `hubie start` | Stops or starts Hubie. |
| `hubie estop` / `hubie resume` | Emergency stop, or resume. |
| `hubie set-key anthropic` / `hubie set-key elevenlabs` | Replaces a key, with your typing hidden. |
| `hubie update` | Updates from git, if you installed from a repository. |

Hubie starts again automatically after a crash or a server reboot.

## Security

- Every remote request needs the token. Only requests from the server itself (localhost) are trusted.
- Keys live only in `/home/hubie/hubie-streamer/.env`, which only its owner can read. They are never sent to a browser and never written to logs.
- Anyone with the Control Center link can control Hubie. To make a new token: delete the `CONTROL_TOKEN=` line in `.env`, then run `bash hubie-streamer/INSTALL-HUBIE.sh` again.
