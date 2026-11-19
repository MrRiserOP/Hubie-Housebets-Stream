#!/usr/bin/env bash
# ============================================================================
#  HUBIE — one-command install on an Ubuntu 22.04/24.04 server (VPS).
#
#  1. Copy the hubie-streamer folder (or the .tar.gz) to the server.
#  2. On the server, as root:   bash hubie-streamer/INSTALL-HUBIE.sh
#  3. Open the link it prints → Control Center → Check everything → Go live.
#
#  Installs Node.js, PM2, the game browser, OBS Studio (headless), sets a
#  firewall (SSH stays open), creates a secret access link, and starts Hubie
#  with auto-restart. It never buys anything and never goes live by itself.
#  Full beginner guide: docs/VPS-DEPLOYMENT.md
# ============================================================================
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec bash "$DIR/scripts/install-vps.sh" "$@"
