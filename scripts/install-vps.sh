#!/usr/bin/env bash
# ============================================================================
#  Hubie — one-command installer for a fresh Ubuntu 22.04 / 24.04 server.
#
#  Paste ONE of these into the server's terminal (as root):
#    from GitHub:   curl -fsSL https://raw.githubusercontent.com/<OWNER>/<REPO>/main/scripts/install-vps.sh | bash -s -- https://github.com/<OWNER>/<REPO>.git
#    from a copy:   bash /path/to/hubie-streamer/scripts/install-vps.sh
#
#  It installs Node.js 22, PM2, the game browser and its system libraries,
#  creates a 'hubie' user, installs + builds Hubie, sets up the firewall,
#  starts Hubie with auto-restart, and prints your private setup link.
#  It never buys anything, never assumes credentials, and never goes live by itself.
#  OBS Studio is installed too (headless: virtual screen + virtual sound card) so the server can stream.
#  Options (env vars): HUBIE_NO_OBS=1  HUBIE_CLOUD=1 (Streamable cloud mode: no OBS on this server)  HUBIE_PORT=8787  HUBIE_NONINTERACTIVE=1  HUBIE_SKIP_FIREWALL=1
# ============================================================================
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO_URL="${1:-${HUBIE_REPO_URL:-}}"
PORT="${HUBIE_PORT:-8787}"
APP_USER=hubie
APP_DIR=/home/$APP_USER/hubie-streamer
LOG=/var/log/hubie-install.log
TTY=/dev/tty; [ -r /dev/tty ] && [ -z "${HUBIE_NONINTERACTIVE:-}" ] || TTY=""

c() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mInstallation stopped:\033[0m %s\nDetails: %s\n' "$*" "$LOG"; exit 1; }
run() { "$@" >>"$LOG" 2>&1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (put 'sudo ' in front, or log in as root)."
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = "ubuntu" ] || warn "This script is tested for Ubuntu; continuing on ${PRETTY_NAME:-unknown}."
: >"$LOG"

c "1/8  System packages"
run apt-get update -y || die "apt-get update failed (no internet?)"
run apt-get install -y curl ca-certificates git ufw openssl jq software-properties-common || die "could not install base packages"
ok "base packages"

c "2/8  Node.js 22 + PM2"
if ! command -v node >/dev/null || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x 2>>"$LOG" | bash - >>"$LOG" 2>&1 || die "could not add the Node.js repository"
  run apt-get install -y nodejs || die "could not install Node.js"
fi
ok "Node.js $(node -v)"
command -v pm2 >/dev/null || run npm install -g pm2@latest || die "could not install PM2"
# make node/npm/npx/pm2 visible to every user (some images install Node outside /usr/bin)
for b in node npm npx pm2; do p="$(command -v $b)"; case "$p" in /usr/bin/*|/usr/local/bin/*|"") ;; *) ln -sf "$p" /usr/local/bin/$b ;; esac; done
ok "PM2 $(pm2 -v 2>/dev/null | tail -1)"

c "3/8  App user and files"
id $APP_USER >/dev/null 2>&1 || run useradd -m -s /bin/bash $APP_USER
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
if [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then run sudo -u $APP_USER git -C "$APP_DIR" pull --ff-only || warn "git pull failed; keeping current files"
  else run sudo -u $APP_USER git clone --depth 1 "$REPO_URL" "$APP_DIR" || die "could not download $REPO_URL"; fi
elif [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/package.json" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  (cd "$SRC_DIR" && tar --exclude=node_modules --exclude=dist --exclude=data --exclude=logs --exclude=.env -cf - .) | (cd "$APP_DIR" && tar -xf -)
  chown -R $APP_USER:$APP_USER "$APP_DIR"
elif [ ! -f "$APP_DIR/package.json" ]; then
  die "no source: pass the GitHub URL as an argument, or run this script from inside the hubie-streamer folder"
fi
ok "files in $APP_DIR"

c "4/8  Installing Hubie (a few minutes)"
as_app() { sudo -u $APP_USER -H bash -lc "cd '$APP_DIR' && $*"; }
as_app "npm ci --no-audit --no-fund || npm install --no-audit --no-fund" >>"$LOG" 2>&1 || die "npm install failed"
run npx --yes playwright install-deps chromium || warn "some browser system libraries could not be installed"
if as_app "npx --yes playwright install chromium" >>"$LOG" 2>&1; then ok "game browser installed"
else
  warn "game browser download failed; installing Google Chrome instead"
  (curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && run apt-get install -y /tmp/chrome.deb) || warn "no browser installed — the game agent will use the simulated game"
fi
as_app "npm run build" >>"$LOG" 2>&1 || die "building the overlay failed"
ok "installed and built"

c "5/8  Configuration"
ENVF="$APP_DIR/.env"
[ -f "$ENVF" ] || cp "$APP_DIR/.env.example" "$ENVF"
setenv() { if grep -qE "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >>"$ENVF"; fi; }
IP="$(curl -fs4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
TOKEN="$(grep -E '^CONTROL_TOKEN=.+' "$ENVF" | cut -d= -f2)"; [ -n "$TOKEN" ] || TOKEN="$(openssl rand -hex 20)"
setenv CONTROL_TOKEN "$TOKEN"
setenv CONTROLLER_PORT "$PORT"
setenv PUBLIC_BASE_URL "http://127.0.0.1:$PORT"
setenv ALLOW_TEST_CHAT true
if [ -n "${HUBIE_CLOUD:-}" ]; then
  setenv STREAM_MODE streamable-cloud; setenv OBS_ENABLED false
  grep -qE '^OVERLAY_TOKEN=.+' "$ENVF" || setenv OVERLAY_TOKEN "$(openssl rand -hex 18)"
  ok "Streamable cloud mode: OBS is NOT installed here (Streamable's cloud OBS renders and encodes)"
elif [ -z "${HUBIE_NO_OBS:-}" ]; then
  if run add-apt-repository -y ppa:obsproject/obs-studio && run apt-get update -y && run apt-get install -y obs-studio xvfb pulseaudio pulseaudio-utils; then
    ok "OBS Studio installed (runs on a virtual screen)"
    setenv OBS_ENABLED true; setenv OBS_MANAGED true; setenv OBS_WS_URL ws://127.0.0.1:4455
    grep -qE '^OBS_WS_PASSWORD=.+' "$ENVF" || setenv OBS_WS_PASSWORD "$(openssl rand -hex 12)"
  else warn "OBS install failed — Hubie still runs; see docs/OBS-SETUP.md"; fi
fi
# Keys are typed here hidden, or later in the control center. They are stored only in .env (chmod 600).
ask_key() { # $1 label  $2 env name  $3 regex
  [ -n "$TTY" ] || return 0
  grep -qE "^$2=.+" "$ENVF" && return 0
  printf "    %s (Enter = skip, add later in the control center): " "$1"; IFS= read -rs KEY <"$TTY"; echo
  if [ -z "$KEY" ]; then return 0; fi
  if [[ "$KEY" =~ $3 ]]; then setenv "$2" "$KEY"; ok "$1 saved on the server (never shown again)"; else warn "that didn't look like a valid key — add it later in the control center"; fi
  unset KEY
}
if [ -n "$TTY" ]; then
  echo
  echo "    Hubie's brain: an Anthropic (Claude) key. Hubie's voice: an ElevenLabs key."
  echo "    Typing is hidden."
  ask_key "Anthropic API key (sk-ant-…)" ANTHROPIC_API_KEY '^sk-ant-[A-Za-z0-9_-]{20,}$'
  ask_key "ElevenLabs API key (sk_…)" ELEVENLABS_API_KEY '^sk_[A-Za-z0-9_-]{20,}$'
fi

# Kick sends chat messages to a public HTTPS address (signed webhooks). A free, stable one is built from the server IP with
# sslip.io, and Caddy gets its certificate automatically. ONLY /kick/webhook is exposed — never the Control Center.
if [ -z "${HUBIE_NO_HTTPS:-}" ] && [[ "$IP" =~ ^[0-9.]+$ ]]; then
  HOOKHOST="${IP//./-}.sslip.io"
  if command -v caddy >/dev/null 2>&1 || run apt-get install -y caddy || { run bash -c "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list && apt-get update -y && apt-get install -y caddy"; }; then
    cat >/etc/caddy/Caddyfile <<CADDY
$HOOKHOST {
	@hook path /kick/webhook
	handle @hook {
		reverse_proxy 127.0.0.1:8788
	}
	# Read-only overlay for Streamable's cloud OBS. /hub (WebSocket) refuses any client without OVERLAY_TOKEN or CONTROL_TOKEN,
	# and the control center, /setup, /control and every /api/* call stay unreachable from the internet.
	@overlay path /overlay /assets/* /assets-hubie/* /music/* /music-user/* /hub /tts/* /favicon.ico
	handle @overlay {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		respond "Hubie" 404
	}
}
CADDY
    run systemctl enable --now caddy; run systemctl reload caddy || run systemctl restart caddy
    setenv KICK_WEBHOOK_URL "https://$HOOKHOST/kick/webhook"
    setenv PUBLIC_HOST "$HOOKHOST"
    ok "Kick chat address: https://$HOOKHOST/kick/webhook  (paste it into your Kick app — see docs/KICK-SETUP.md)"
  else warn "could not set up the HTTPS address for Kick chat — see docs/KICK-SETUP.md (Hubie can still post to chat without it)"; fi
fi
chown $APP_USER:$APP_USER "$ENVF"; chmod 600 "$ENVF"
ok "settings in $ENVF (private, chmod 600)"

c "6/8  Firewall"
if [ -z "${HUBIE_SKIP_FIREWALL:-}" ]; then
  # ALWAYS allow SSH first (by port, in case the OpenSSH profile doesn't exist) so you can't be locked out
  if run ufw allow 22/tcp && run ufw allow "$PORT/tcp" && run ufw allow 80/tcp && run ufw allow 443/tcp; then
    run ufw allow OpenSSH || true
    run ufw --force enable && ok "firewall on: SSH (22) + Hubie ($PORT) + web (80/443, Kick chat only) allowed" || warn "firewall not enabled (ufw unavailable)"
  else warn "firewall not configured (ufw unavailable)"; fi
else warn "firewall skipped"; fi

c "7/8  Starting Hubie (auto-restart on failure and on reboot)"
as_app "pm2 delete all >/dev/null 2>&1; pm2 start config/ecosystem.config.cjs && pm2 save" >>"$LOG" 2>&1 || die "could not start Hubie"
run env PATH="$PATH" pm2 startup systemd -u $APP_USER --hp /home/$APP_USER || warn "boot auto-start not configured (no systemd?)"
install -m 755 "$APP_DIR/scripts/hubie" /usr/local/bin/hubie 2>/dev/null && ok "helper command installed: hubie"

c "8/8  Checking"
for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/setup" && break; sleep 1; done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/setup" && ok "Hubie is running" || die "Hubie did not start — see: hubie logs"

LINK="http://$IP:$PORT/setup?token=$TOKEN"
TUNNEL="ssh -N -L $PORT:127.0.0.1:$PORT root@$IP"
echo "$LINK" > /home/$APP_USER/hubie-setup-link.txt; chown $APP_USER:$APP_USER /home/$APP_USER/hubie-setup-link.txt; chmod 600 /home/$APP_USER/hubie-setup-link.txt
cat <<EOF

  ╔══════════════════════════════════════════════════════════════════════╗
     HUBIE IS INSTALLED 🎩

     Open the CONTROL CENTER (keep this link secret — it controls Hubie):

       $LINK

     Safer (encrypted) way, recommended before typing any key:
       1. on YOUR computer run:  $TUNNEL
       2. then open:             http://127.0.0.1:$PORT/setup?token=$TOKEN

     Link saved in /home/$APP_USER/hubie-setup-link.txt  ·  show it again: hubie link
     Next: Control Center → G "Check everything" → H "Go live".
     Commands:  hubie status | hubie logs | hubie restart | hubie stop | hubie set-key | hubie estop
  ╚══════════════════════════════════════════════════════════════════════╝
EOF
