// Brings up (or re-attaches to) the booking Sailbox's browser stack:
//
//   Xvfb :1  ->  chromium  ->  x11vnc  ->  websockify   (human logs in here)
//                    |
//                    +-------->  cdp-proxy  (Playwright drives the SAME browser)
//
// The whole point is that ONE chromium process, with ONE on-disk profile,
// serves both the human's login and the automation. Playwright attaches over
// CDP rather than launching its own browser: chromium locks its user-data-dir,
// so a second instance pointed at the same profile fights the first.
//
// IDEMPOTENT BY DESIGN. This script is re-run to get a fresh VNC URL, and an
// earlier version pkill'd chromium on every run -- which would destroy the
// human login it exists to protect. Anything already running is now left
// alone; only missing pieces are started.

import { Sailbox } from "@sailresearch/sdk";

const BOX_NAME = process.env.BOOKING_BOX_NAME ?? "booking";
const PROFILE_DIR = "/root/booking/profile";
const CDP_PORT = 9222;
const CDP_PROXY_PORT = 9223;
const VNC_PORT = 6080;

/**
 * Route the browser's traffic somewhere other than Sail's egress.
 *
 * Resy refuses its auth endpoints from datacenter IPs -- measured, identical
 * request, only the source differing:
 *
 *     OPTIONS /4/auth/mobile    direct 000/500      via tunnel 204
 *     OPTIONS /3/auth/refresh   direct 500          via tunnel 204
 *
 * A session cannot even be imported without this, because activating it means
 * exchanging a refresh token at /3/auth/refresh. Raise the tunnel with:
 *
 *     ssh -N -R 1080 booking.sail
 *
 * (OpenSSH remote dynamic forwarding: gives the box a SOCKS5 proxy on
 * 127.0.0.1:1080 whose traffic leaves from the machine running the ssh client.)
 * Then BOOKING_PROXY=socks5://127.0.0.1:1080 with --restart-browser.
 */
const PROXY = process.env.BOOKING_PROXY ?? "";

/**
 * Chromium is normally left alone, because restarting it would destroy the
 * login this script exists to protect. Restarting is safe ONLY because the
 * profile is on disk -- cookies survive, provided the process is asked to stop
 * rather than killed outright.
 */
const RESTART_BROWSER = process.argv.includes("--restart-browser");

/**
 * Only this IP may reach the CDP tunnel.
 *
 * CDP is unauthenticated and allows arbitrary script execution, file reads via
 * file:// and cookie theft in a browser that holds a real login and a saved
 * card. A public listener on it would be a credential-exfiltration endpoint,
 * so the tunnel is TCP + allowlist rather than a public HTTP listener like the
 * VNC one.
 */
async function callerIp() {
  if (process.env.CDP_ALLOW_IP) return process.env.CDP_ALLOW_IP;
  const response = await fetch("https://ifconfig.me/ip");
  if (!response.ok) throw new Error(`could not determine caller IP: HTTP ${response.status}`);
  return (await response.text()).trim();
}

const boxes = await Sailbox.list({ limit: 100 });
const box = boxes.find((b) => (b.name ?? "") === BOX_NAME && b.status !== "terminated");
if (!box) throw new Error(`No live Sailbox named "${BOX_NAME}" found.`);
if (box.status !== "running") {
  console.log(`box is ${box.status}, resuming...`);
  await box.resume();
}
console.log(`box: ${box.sailboxId} (app ${box.appName})`);

await box.fs.write("/root/booking/cdp-proxy.js", await import("node:fs").then((fs) => fs.readFileSync(new URL("./cdp-proxy.js", import.meta.url), "utf8")));

// Landing on the login page rather than about:blank, and NEVER on
// https://www.opentable.com/ -- Akamai serves that exact path a 403 from this
// box's egress. Deep links (/s?term=, /my/profile) are served normally. That
// 403 on the homepage is what earlier reads mistook for a site-wide IP ban.
const START_URL = process.env.BOOKING_START_URL ?? "https://www.opentable.com/my/profile";

const script = `#!/bin/bash
set -u
mkdir -p ${PROFILE_DIR}

running() { pgrep -f -- "$1" > /dev/null 2>&1; }

if ! running "Xvfb :1"; then
  rm -f /tmp/.X1-lock
  nohup Xvfb :1 -screen 0 1440x900x24 > /tmp/xvfb.log 2>&1 &
  sleep 2
  echo "started Xvfb"
else
  echo "Xvfb already running"
fi

${
  RESTART_BROWSER
    ? `# SIGTERM, not SIGKILL: chromium flushes its cookie store on a clean exit,
# and the whole point of the on-disk profile is that the session outlives the
# process. -9 here would drop cookies written since the last flush.
if running "--user-data-dir=${PROFILE_DIR}"; then
  pkill -TERM -f -- "--user-data-dir=${PROFILE_DIR}" || true
  for i in $(seq 1 15); do
    running "--user-data-dir=${PROFILE_DIR}" || break
    sleep 1
  done
  pkill -KILL -f -- "--user-data-dir=${PROFILE_DIR}" 2>/dev/null || true
  sleep 1
  echo "stopped chromium (profile on disk retains the session)"
fi`
    : ""
}

# Matching on the profile path identifies OUR chromium specifically.
if ! running "--user-data-dir=${PROFILE_DIR}"; then
  DISPLAY=:1 setsid nohup chromium \\
    --no-sandbox --disable-gpu \\
    --remote-debugging-port=${CDP_PORT} \\
    --remote-debugging-address=127.0.0.1 \\
    --user-data-dir=${PROFILE_DIR} \\
    --window-size=1440,900 --window-position=0,0 \\
    --no-first-run --no-default-browser-check \\
    ${PROXY ? `--proxy-server=${PROXY} \\\n    ` : ""}"${START_URL}" > /tmp/chromium.log 2>&1 &
  sleep 5
  echo "started chromium${PROXY ? ` via proxy ${PROXY}` : ""}"
else
  echo "chromium already running (profile preserved, NOT restarted)"
fi

if ! running "cdp-proxy.js"; then
  setsid nohup node /root/booking/cdp-proxy.js > /tmp/cdp-proxy.log 2>&1 &
  sleep 1
  echo "started cdp-proxy"
else
  echo "cdp-proxy already running"
fi

if ! running "x11vnc"; then
  mkdir -p /root/.vnc
  if [ ! -f /root/.vnc_password_plain ]; then
    head -c 12 /dev/urandom | base64 | tr -dc "a-zA-Z0-9" | head -c 12 > /root/.vnc_password_plain
  fi
  VNC_PW=\$(cat /root/.vnc_password_plain)
  nohup x11vnc -display :1 -forever -shared -rfbport 5900 -passwd "\$VNC_PW" > /tmp/x11vnc.log 2>&1 &
  sleep 2
  echo "started x11vnc"
else
  echo "x11vnc already running"
fi

if ! running "websockify"; then
  nohup websockify --web=/usr/share/novnc ${VNC_PORT} localhost:5900 > /tmp/websockify.log 2>&1 &
  sleep 2
  echo "started websockify"
else
  echo "websockify already running"
fi

echo "--- health ---"
curl -sS --max-time 5 http://127.0.0.1:${CDP_PORT}/json/version | head -3 || echo "CDP NOT ANSWERING"
echo done
`;

await box.fs.write("/root/booking/start_vnc.sh", script);
const run = await box.run("bash /root/booking/start_vnc.sh", { timeout: 120000 });
console.log(run.stdout ?? "");
if (run.exitCode !== 0) {
  console.error("start_vnc.sh failed:", run.stderr);
  process.exit(1);
}

// x11vnc stores the password itself; this plaintext copy exists only so the
// URL below can carry it. It never leaves the box except in that URL.
const pw = (await box.fs.read("/root/.vnc_password_plain")).toString().trim();

const listeners = await box.listeners();
if (!listeners.some((l) => l.port === VNC_PORT)) await box.expose(VNC_PORT);
if (!listeners.some((l) => l.port === CDP_PROXY_PORT)) {
  const ip = await callerIp();
  await box.expose(CDP_PROXY_PORT, { protocol: "tcp", allowlist: [`${ip}/32`] });
  console.log(`CDP tunnel allowlisted to ${ip}/32`);
}

const vnc = await box.waitForListener(VNC_PORT, { timeoutSeconds: 60 });
const cdp = await box.waitForListener(CDP_PROXY_PORT, { timeoutSeconds: 60 });

console.log("\nVNC URL:  " + vnc.endpoint.url + "/vnc.html?password=" + pw);
console.log("VNC pass: " + pw);
console.log("CDP URL:  " + (cdp.endpoint.url ?? JSON.stringify(cdp.endpoint)));
console.log("\nProfile:  " + PROFILE_DIR + "  (box " + box.sailboxId + ")");
