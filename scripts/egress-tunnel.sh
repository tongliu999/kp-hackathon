#!/bin/bash
# Keep the booking Sailbox's browser egress pointed at THIS machine.
#
# Resy refuses its auth endpoints from Sail's egress -- identical request, only
# the source IP differing:
#
#     OPTIONS /4/auth/mobile     Sailbox 500 (no CORS headers)   here 204
#     OPTIONS /3/auth/refresh    Sailbox 500                     here 204
#     OPTIONS /4/find            Sailbox 204                     here 204
#
# so the session cannot even refresh from inside the box. OpenSSH remote dynamic
# forwarding gives the box a SOCKS5 proxy on 127.0.0.1:1080 whose traffic leaves
# from here; chromium runs behind it via --proxy-server=socks5://127.0.0.1:1080.
#
#   ./scripts/egress-tunnel.sh          # foreground, reconnects on drop
#
# WHY THE LOOP. A bare `ssh -R` is a single point of failure for every
# authenticated action, and it does drop: observed live, "Connection closed by
# remote host / Broken pipe" after a period of use. When it is down the box's
# browser has no working egress AT ALL -- every page load fails, not just auth --
# because chromium is pointed at a proxy that is no longer there. Reconnecting
# automatically turns a dead demo into a few seconds of stall.
#
# Still a live dependency. Keep the stub path as the rehearsed fallback.
set -u

BOX="${BOOKING_BOX_SSH:-booking.sail}"
PORT="${BOOKING_PROXY_PORT:-1080}"
DELAY="${TUNNEL_RETRY_SECONDS:-5}"
MAX_DELAY="${TUNNEL_MAX_RETRY_SECONDS:-60}"

echo "egress tunnel -> ${BOX}, SOCKS5 on the box at 127.0.0.1:${PORT}"
echo "chromium must run with --proxy-server=socks5://127.0.0.1:${PORT}"

attempt=0
while true; do
  attempt=$((attempt + 1))
  echo "[$(date +%H:%M:%S)] connecting (attempt ${attempt})..."
  # ExitOnForwardFailure: fail loudly if the port is already bound in the box,
  # rather than sitting there having forwarded nothing.
  ssh -N \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -R "${PORT}" "${BOX}"
  code=$?
  echo "[$(date +%H:%M:%S)] tunnel exited (${code}); reconnecting in ${wait:-$DELAY}s"
  sleep "${wait:-$DELAY}"
  # Back off. A fixed short retry hammers the SSH ingress, which then resets
  # connections outright ("kex_exchange_identification: Connection reset by
  # peer") -- observed live, and it turns a recoverable drop into a hard outage.
  wait=$(( ${wait:-$DELAY} * 2 ))
  [ "$wait" -gt "$MAX_DELAY" ] && wait=$MAX_DELAY
done
