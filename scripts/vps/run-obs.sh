#!/usr/bin/env bash
# Headless OBS for a VPS: virtual display (Xvfb) + virtual audio sink (PulseAudio) + OBS
# with obs-websocket enabled. Managed by PM2 when OBS_MANAGED=true (see ecosystem file).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; [ -f .env ] && . ./.env; set +a

DISPLAY_NUM="${OBS_DISPLAY:-:99}"
export DISPLAY="$DISPLAY_NUM"
PASS="${OBS_WS_PASSWORD:-}"
PORT="$(echo "${OBS_WS_URL:-ws://127.0.0.1:4455}" | sed -E 's#.*:([0-9]+).*#\1#')"

# 1) virtual display
if ! pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null; then
  Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp &
  sleep 1
fi

# 2) virtual audio so the browser source has somewhere to render audio
pulseaudio --check 2>/dev/null || pulseaudio --start --exit-idle-time=-1
pactl list short sinks | grep -q hubie_sink || pactl load-module module-null-sink sink_name=hubie_sink >/dev/null
pactl set-default-sink hubie_sink

# 3) obs-websocket config (OBS 28+ built-in)
CFG="$HOME/.config/obs-studio/plugin_config/obs-websocket"
mkdir -p "$CFG"
cat > "$CFG/config.json" <<EOF
{ "alerts_enabled": false, "auth_required": $([ -n "$PASS" ] && echo true || echo false),
  "first_load": false, "server_enabled": true, "server_password": "$PASS", "server_port": $PORT }
EOF

# 4) OBS. --minimize-to-tray keeps it quiet; the stream-engine creates scenes via websocket.
exec obs --disable-shutdown-check --minimize-to-tray --multi
