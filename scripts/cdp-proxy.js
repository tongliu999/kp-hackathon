// Runs INSIDE the Sailbox. Fronts Chromium's DevTools port so Playwright can
// reach it from outside the box.
//
// Two things have to be rewritten, and both are why a plain TCP forward
// (socat, ssh -L) is not enough:
//
//  1. REQUEST Host header. Chrome refuses any DevTools request whose Host is
//     not "localhost" or a bare IP -- an anti-DNS-rebinding rule. Traffic
//     arriving through Sail ingress carries the ingress hostname, so Chrome
//     answers "Host header is specified and is not an IP address or localhost"
//     and the connection dies.
//
//  2. RESPONSE webSocketDebuggerUrl. /json/version advertises
//     ws://127.0.0.1:9222/... which is meaningless outside the box. It is
//     rewritten to the host the caller actually used.
//
// EVERY request head on a connection is rewritten, not just the first.
// Playwright sends "Connection: keep-alive" and reuses one TCP connection for
// both GET /json/version and the WebSocket upgrade that follows. A proxy that
// rewrites only the first head and then splices raw bytes lets the upgrade
// through with the original Host, and Chrome rejects it with a 500 -- after
// the version probe has already succeeded, which makes it look like a
// WebSocket problem rather than a header problem.
//
// Once a 101 is seen the connection carries WebSocket frames, not HTTP, so
// both directions switch to a byte-for-byte splice and stay there.
//
// Bound to 0.0.0.0 on purpose: it is reachable only through the Sail listener,
// which is exposed as TCP with an IP allowlist. Do NOT expose this port
// publicly -- CDP access is arbitrary code execution in a browser that holds a
// real login and a saved payment method.

const net = require("net");

const LISTEN_PORT = Number(process.env.CDP_PROXY_PORT || 9223);
const TARGET_PORT = Number(process.env.CDP_TARGET_PORT || 9222);
const TARGET_HOST = "127.0.0.1";
const HEAD_LIMIT = 64 * 1024;
const DEBUG = Boolean(process.env.CDP_PROXY_DEBUG);

const server = net.createServer((client) => {
  client.on("error", () => client.destroy());

  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  upstream.on("error", () => client.destroy());

  // Flipped to true by a 101 response, after which neither side is HTTP.
  let spliced = false;
  let publicHost = `${TARGET_HOST}:${TARGET_PORT}`;

  let reqBuf = Buffer.alloc(0);
  client.on("data", (chunk) => {
    if (spliced) return void upstream.write(chunk);

    reqBuf = Buffer.concat([reqBuf, chunk]);
    for (;;) {
      const end = reqBuf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (reqBuf.length > HEAD_LIMIT) client.destroy();
        return;
      }
      const head = reqBuf.slice(0, end).toString("utf8");
      reqBuf = reqBuf.slice(end + 4);

      // Remember the host the caller dialled so responses can advertise it.
      const hostMatch = head.match(/^Host:\s*(.+?)\s*$/im);
      if (hostMatch) publicHost = hostMatch[1];

      const out = head.replace(/^Host:.*$/im, `Host: ${TARGET_HOST}:${TARGET_PORT}`);
      if (DEBUG) console.log("REQ", JSON.stringify(head.split("\r\n")[0]), "host:", publicHost);
      upstream.write(out + "\r\n\r\n");
    }
  });

  let respBuf = Buffer.alloc(0);
  upstream.on("data", (chunk) => {
    if (spliced) return void client.write(chunk);

    respBuf = Buffer.concat([respBuf, chunk]);
    for (;;) {
      const end = respBuf.indexOf("\r\n\r\n");
      if (end === -1) {
        // Nothing parseable yet. Don't buffer without bound if this turns out
        // not to be HTTP at all.
        if (respBuf.length > HEAD_LIMIT * 8) {
          client.write(respBuf);
          respBuf = Buffer.alloc(0);
          spliced = true;
        }
        return;
      }

      const head = respBuf.slice(0, end).toString("utf8");

      // The upgrade succeeded: forward everything as-is from here on.
      if (/^HTTP\/1\.[01] 101 /.test(head)) {
        if (DEBUG) console.log("RESP 101 upgrade -> splice");
        client.write(respBuf);
        respBuf = Buffer.alloc(0);
        spliced = true;
        return;
      }

      const lengthMatch = head.match(/^Content-Length:\s*(\d+)\s*$/im);
      if (!lengthMatch) {
        // Chunked or bodyless. Pass through untouched rather than guess.
        client.write(respBuf);
        respBuf = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number(lengthMatch[1]);
      const total = end + 4 + bodyLength;
      if (respBuf.length < total) return; // body still arriving

      const body = respBuf.slice(end + 4, total).toString("utf8");
      const newBody = body
        .replace(new RegExp(`ws://${TARGET_HOST}:${TARGET_PORT}`, "g"), `ws://${publicHost}`)
        .replace(new RegExp(`http://${TARGET_HOST}:${TARGET_PORT}`, "g"), `http://${publicHost}`);
      const newHead = head.replace(
        /^Content-Length:.*$/im,
        `Content-Length: ${Buffer.byteLength(newBody, "utf8")}`
      );
      if (DEBUG) console.log("RESP", head.split("\r\n")[0], "body", bodyLength, "->", Buffer.byteLength(newBody));
      client.write(Buffer.from(`${newHead}\r\n\r\n${newBody}`, "utf8"));
      respBuf = respBuf.slice(total);
    }
  });

  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("close", close);
  upstream.on("close", close);
});

server.on("error", (err) => {
  console.error("cdp-proxy server error:", err.message);
  process.exit(1);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`cdp-proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
