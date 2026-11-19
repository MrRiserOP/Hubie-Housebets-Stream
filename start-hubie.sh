#!/usr/bin/env bash
# ============================================================
#  start-hubie.sh — start Hubie on Linux (or macOS)
#    ./start-hubie.sh          run in this terminal (Ctrl+C to stop)
#    ./start-hubie.sh --pm2    run in the background with auto-restart (servers)
# ============================================================
set -uo pipefail
cd "$(dirname "$0")" || exit 1
PORT="$(grep -E '^CONTROLLER_PORT=' .env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
say()  { printf '  \033[1;33m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\n  \033[1;31m[!]\033[0m %s\n\n' "$*"; exit 1; }

echo
echo "  ========================================="
echo "    HUBIE  -  starting your AI streamer"
echo "  ========================================="
echo

# 1. Node.js 22.13+
if ! command -v node >/dev/null 2>&1 || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Hubie needs Node.js 22. I can install it for you now (needs your password)."
    read -r -p "  Install Node.js 22? [Y/n] " ans </dev/tty || ans=y
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs || fail "Installing Node.js failed. Install Node.js 22 from https://nodejs.org and run this again."
    else
      fail "Please install Node.js 22 or newer from https://nodejs.org and run this again."
    fi
  else
    fail "Please install Node.js 22 or newer from https://nodejs.org (or your package manager) and run this again."
  fi
fi
ok "Node.js $(node -v)"

# 2. dependencies (first run)
if [ ! -d node_modules ]; then
  say "Installing Hubie's components (first time only, a few minutes)..."
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund || npm install --no-audit --no-fund || fail "Installing components failed. Check the internet connection."
  else npm install --no-audit --no-fund || fail "Installing components failed. Check the internet connection."; fi
  # a browser for the game agent: bundled Chromium, else your installed Chrome/Edge is used automatically
  npx --yes playwright install chromium >/dev/null 2>&1 && ok "Game browser installed" || say "Could not download the game browser; Hubie will use your installed Google Chrome instead."
fi
ok "Components installed"

# 3. already running?
if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/setup" 2>/dev/null; then
  say "Hubie already seems to be running: http://127.0.0.1:${PORT}/setup"
  exit 0
fi

open_setup() {
  for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:${PORT}/setup" && break; sleep 1; done
  local url="http://127.0.0.1:${PORT}/setup"
  echo; ok "Hubie is running. Open: $url"; echo
  if [ -z "${HUBIE_NO_BROWSER:-}" ]; then
    (command -v xdg-open >/dev/null && xdg-open "$url" >/dev/null 2>&1) || (command -v open >/dev/null && open "$url") || true
  fi
}

# 4. start
if [ "${1:-}" = "--pm2" ]; then
  command -v pm2 >/dev/null 2>&1 || npm install -g pm2 >/dev/null 2>&1 || sudo npm install -g pm2 || fail "Could not install PM2."
  npm run build >/dev/null || fail "Building the overlay failed."
  pm2 start config/ecosystem.config.cjs >/dev/null && pm2 save >/dev/null
  open_setup
  say "Running in the background. Logs: pm2 logs   Stop: pm2 stop all"
else
  say "Starting Hubie. Keep this terminal open; press Ctrl+C to stop."
  open_setup &
  exec npm start
fi
