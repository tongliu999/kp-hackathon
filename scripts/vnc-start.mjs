import { Sailbox } from "@sailresearch/sdk";

const boxes = await Sailbox.list({ limit: 50 });
const box = boxes.find((b) => (b.name ?? "") === "booking");
if (!box) throw new Error('No Sailbox named "booking" found.');

const existing = await box.listeners();
const already = existing.find((l) => l.port === 6080);
if (already) {
  console.log("Already exposed:");
  console.log("VNC URL:  " + already.endpoint.url + "/vnc.html");
  process.exit(0);
}

const script = `#!/bin/bash
set -e
mkdir -p /root/booking/profile
rm -f /tmp/.X1-lock
pkill Xvfb 2>/dev/null || true
pkill chromium 2>/dev/null || true
pkill x11vnc 2>/dev/null || true
pkill websockify 2>/dev/null || true
sleep 1
nohup Xvfb :1 -screen 0 1440x900x24 > /tmp/xvfb.log 2>&1 &
sleep 2
DISPLAY=:1 nohup chromium --no-sandbox --disable-gpu --user-data-dir=/root/booking/profile --window-size=1440,900 --window-position=0,0 about:blank > /tmp/chromium.log 2>&1 &
sleep 3
mkdir -p /root/.vnc
VNC_PW=$(head -c 12 /dev/urandom | base64 | tr -dc "a-zA-Z0-9" | head -c 12)
echo "$VNC_PW" > /root/.vnc_password_plain
nohup x11vnc -display :1 -forever -shared -rfbport 5900 -passwd "$VNC_PW" > /tmp/x11vnc.log 2>&1 &
sleep 2
nohup websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/websockify.log 2>&1 &
sleep 2
echo done
`;

await box.fs.write("/root/booking/start_vnc.sh", script);
const run = await box.run("bash /root/booking/start_vnc.sh");
if (run.exitCode !== 0) {
  console.error("start_vnc.sh failed:", run.stdout, run.stderr);
  process.exit(1);
}

const pw = (await box.fs.read("/root/.vnc_password_plain")).toString().trim();

await box.expose(6080);
const listener = await box.waitForListener(6080, { timeout: 60000 });

console.log("VNC URL:  " + listener.endpoint.url + "/vnc.html?password=" + pw);
console.log("VNC pass: " + pw);
