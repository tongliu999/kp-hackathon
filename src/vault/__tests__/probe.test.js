// The box-vs-host comparison, driven by a synthetic oracle.
//
// The canned responses are the ones actually measured on Resy this week, so
// these tests assert that the tooling reaches the conclusion the humans had to
// reach the hard way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { classifyProbe } from "../capabilities.js";
import {
  buildPreflight, parseCurlHead, curlCommand, probeDomain, classifyRefreshRequests, hostTransport, sailboxTransport,
} from "../probe.js";
import { fakeTransport } from "./fakes.js";

// Measured: OPTIONS /4/auth/mobile — box 500 with no CORS headers, residential 204.
const BOX_BLOCKED = { status: 500, corsAllowOrigin: null, error: null };
const HOST_OK = { status: 204, corsAllowOrigin: "https://resy.com", error: null };
const BOX_OK = { status: 204, corsAllowOrigin: "https://resy.com", error: null };
const BOTH_BAD = { status: 404, corsAllowOrigin: null, error: null };

test("box blocked + host fine = residential-only, and the tunnel is required", () => {
  const verdict = classifyProbe({ box: BOX_BLOCKED, host: HOST_OK });
  assert.equal(verdict.verdict, "residential-only");
  assert.equal(verdict.needsTunnel, true);
});

test("a 5xx with no CORS header is flagged as browser-invisible", () => {
  const verdict = classifyProbe({ box: BOX_BLOCKED, host: HOST_OK });
  assert.equal(verdict.browserInvisible, true);
  assert.match(verdict.summary, /not a CORS misconfiguration/);
});

test("a blocked box that does send CORS headers is not browser-invisible", () => {
  const verdict = classifyProbe({
    box: { status: 403, corsAllowOrigin: "https://resy.com", error: null }, host: HOST_OK,
  });
  assert.equal(verdict.verdict, "residential-only");
  assert.equal(verdict.browserInvisible, false);
});

test("both ends succeeding means no tunnel is needed", () => {
  const verdict = classifyProbe({ box: BOX_OK, host: HOST_OK });
  assert.equal(verdict.verdict, "box-ok");
  assert.equal(verdict.needsTunnel, false);
});

// The distinction the whole command exists for.
test("both ends failing is a broken request, NOT egress blocking", () => {
  const verdict = classifyProbe({ box: BOTH_BAD, host: BOTH_BAD });
  assert.equal(verdict.verdict, "broken-request");
  assert.equal(verdict.needsTunnel, null);
  assert.match(verdict.summary, /not egress blocking/);
});

test("a network error on the box is a failure, not an unknown status treated as success", () => {
  const verdict = classifyProbe({ box: { status: null, corsAllowOrigin: null, error: "timeout" }, host: HOST_OK });
  assert.equal(verdict.verdict, "residential-only");
  assert.match(verdict.summary, /timeout/);
});

test("box succeeding where the host fails is inconclusive, never a pass", () => {
  const verdict = classifyProbe({ box: BOX_OK, host: { status: null, corsAllowOrigin: null, error: "offline" } });
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.needsTunnel, null);
});

test("both transports receive the IDENTICAL request", async () => {
  const box = fakeTransport("box", BOX_BLOCKED);
  const host = fakeTransport("host", HOST_OK);
  await probeDomain("resy.com", { box, host });
  assert.equal(box.sent.length, 1);
  assert.deepEqual(box.sent[0], host.sent[0]);
});

test("probe records the measured verdict as a capability patch", async () => {
  const patch = await probeDomain("resy.com", {
    box: fakeTransport("box", BOX_BLOCKED),
    host: fakeTransport("host", HOST_OK),
    now: new Date("2026-08-02T12:00:00Z"),
  });
  assert.equal(patch.verdict, "residential-only");
  assert.equal(patch.needsTunnel, true);
  assert.equal(patch.authUrl, "https://api.resy.com/4/auth/mobile");
  assert.equal(patch.probedAt, "2026-08-02T12:00:00.000Z");
  assert.deepEqual(patch.evidence.box, BOX_BLOCKED);
});

test("an unknown domain refuses to probe a guessed endpoint", async () => {
  await assert.rejects(
    () => probeDomain("brand-new-site.com", { box: fakeTransport("box", BOX_OK), host: fakeTransport("host", HOST_OK) }),
    /no auth endpoint known/
  );
});

test("an auth URL off the domain is refused", async () => {
  await assert.rejects(
    () => probeDomain("resy.com", {
      authUrl: "https://api.evil.test/4/auth/mobile",
      box: fakeTransport("box", BOX_OK), host: fakeTransport("host", HOST_OK),
    }),
    /only ever sent to the domain it belongs to/
  );
});

test("the preflight needs an Origin, because that is what the server keys on", () => {
  assert.throws(() => buildPreflight({ url: "https://api.resy.com/4/auth/mobile" }), /needs an Origin/);
});

test("curl head parsing reads the last status and its CORS header", () => {
  assert.deepEqual(
    parseCurlHead("HTTP/2 500\r\nserver: cloudflare\r\ncontent-length: 0\r\n"),
    { status: 500, corsAllowOrigin: null, error: null }
  );
  assert.deepEqual(
    parseCurlHead("HTTP/2 204\r\naccess-control-allow-origin: https://resy.com\r\n"),
    { status: 204, corsAllowOrigin: "https://resy.com", error: null }
  );
});

test("a redirect chain reports the final hop's headers, not the first", () => {
  const head = "HTTP/2 301\r\naccess-control-allow-origin: *\r\n\r\nHTTP/2 500\r\nserver: x\r\n";
  assert.deepEqual(parseCurlHead(head), { status: 500, corsAllowOrigin: null, error: null });
});

test("output with no status line is an error, not a silent zero", () => {
  assert.equal(parseCurlHead("curl: (28) Operation timed out").error, "no HTTP status in response");
});

test("the curl command quotes its arguments so a header cannot break out", () => {
  // Asserted by asking a real shell to parse it, not by substring. Correct
  // POSIX quoting of "…'; rm -rf /" is '…'\''; rm -rf /' -- which still
  // CONTAINS "; rm -rf /'" as text, so a substring check flags correct output
  // as broken while proving nothing about what the shell would execute.
  const payload = "https://resy.com'; touch /tmp/kp-vault-injection-canary; echo '";
  const command = curlCommand(buildPreflight({ url: "https://api.resy.com/x", origin: payload }));

  // Swap the binary for a printer; the argv the shell builds is the question.
  const printed = execFileSync("/bin/sh", ["-c", command.replace(/^curl /, 'printf "%s\\n" ')], {
    encoding: "utf8",
  });
  assert.ok(
    printed.split("\n").includes(`origin: ${payload}`),
    "the header must arrive as one literal argument, payload intact"
  );
  assert.ok(!existsSync("/tmp/kp-vault-injection-canary"), "no part of the payload may execute");
});

test("refresh detection names the endpoint that keeps a session alive", () => {
  const observed = classifyRefreshRequests(
    [
      "https://api.resy.com/3/auth/refresh",
      "https://api.resy.com/3/auth/refresh",
      "https://api.resy.com/4/find?day=2026-08-03",
      "https://cdn.other.test/auth/refresh",
    ],
    "resy.com"
  );
  assert.deepEqual(observed, [{ endpoint: "https://api.resy.com/3/auth/refresh", count: 2 }]);
});

test("the host transport reports a network failure instead of throwing", async () => {
  const transport = hostTransport({ exec: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.deepEqual(await transport.send(buildPreflight({ url: "https://api.resy.com/x", origin: "https://resy.com" })), {
    status: null, corsAllowOrigin: null, error: "getaddrinfo ENOTFOUND",
  });
});

// The invariant the whole diagnostic rests on. It was violated once: the host
// side used Node's fetch and the box side used curl, and against Resy's auth
// endpoint those two clients disagree 204 vs 500 on an identical request. A
// client difference that size reads as an egress difference.
test("host and box run the byte-identical command, differing only in where it runs", async () => {
  const commands = [];
  const record = async (command) => {
    commands.push(command);
    return { stdout: "HTTP/2 204\r\naccess-control-allow-origin: https://resy.com\r\n", stderr: "" };
  };
  const fakeBox = { async run(command) { return record(command); } };

  await probeDomain("resy.com", { host: hostTransport({ exec: record }), box: sailboxTransport(fakeBox) });

  const sends = commands.filter((c) => c !== "curl --version");
  assert.equal(sends.length, 2);
  assert.equal(sends[0], sends[1], "both sides must issue the same curl command");
});

test("a curl version mismatch between the two sides is recorded, not hidden", async () => {
  const respond = (version) => async (command) =>
    command === "curl --version"
      ? { stdout: `${version}\n(extra line)`, stderr: "" }
      : { stdout: "HTTP/2 204\r\n", stderr: "" };
  const fakeBox = { async run(command) { return respond("curl 7.68.0")(command); } };

  const patch = await probeDomain("resy.com", {
    host: hostTransport({ exec: respond("curl 8.7.1") }),
    box: sailboxTransport(fakeBox),
  });
  assert.deepEqual(patch.clients, { box: "curl 7.68.0", host: "curl 8.7.1", matched: false });
});
