import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../../ui/version-history/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../ui/version-history/app.js", import.meta.url), "utf8");

test("UI has semantic tree and inspector surfaces", () => {
  assert.match(html, /href="\/ui\/version-history\/styles\.css"/);
  assert.match(html, /src="\/ui\/version-history\/app\.js"/);
  assert.match(html, /aria-label="Version tree"/);
  assert.match(html, /aria-labelledby="inspector-title"/);
  assert.match(html, /Live trace synced/);
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
});
