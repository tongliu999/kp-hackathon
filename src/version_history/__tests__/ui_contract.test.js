import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../../ui/version-history/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../ui/version-history/app.js", import.meta.url), "utf8");
const server = await readFile(
  new URL("../../../scripts/version-history-server.mjs", import.meta.url),
  "utf8"
);

test("UI has semantic tree and inspector surfaces", () => {
  assert.match(html, /href="\/ui\/version-history\/styles\.css"/);
  assert.match(html, /src="\/ui\/version-history\/app\.js"/);
  assert.match(html, /aria-label="Version tree"/);
  assert.match(html, /aria-labelledby="inspector-title"/);
  assert.match(html, /Live trace synced/);
  assert.match(html, /data-task="fanout"/);
  assert.match(html, /data-task="judge"/);
  assert.match(html, /id="run-output"/);
});

test("inspector renders every requested audit category", () => {
  for (const label of [
    "What the agent tried",
    "Files changed",
    "Emails sent",
    "Conversations",
    "Money spent",
    "Metrics achieved",
    "Lessons learned",
  ]) {
    assert.ok(app.includes(label), label);
  }
  assert.match(app, /aria-pressed/);
  assert.match(app, /scrollIntoView/);
  assert.match(app, /\/api\/runs/);
  assert.match(app, /data-task/);
});

test("console server uses a fixed task allowlist without a shell", () => {
  for (const task of ["fanout", "judge", "distill", "validate", "rehearse", "tests"]) {
    assert.ok(server.includes(`task === "${task}"`), task);
  }
  assert.match(server, /shell: false/);
  assert.match(server, /already running/);
  assert.match(server, /kill\("SIGINT"\)/);
});
