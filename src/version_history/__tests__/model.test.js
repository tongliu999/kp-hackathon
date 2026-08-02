import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { indexVersionHistory, validateVersionHistory } from "../model.js";

const fixture = JSON.parse(
  await readFile(new URL("../../../demo/version-history.json", import.meta.url), "utf8")
);

test("demo version history validates and indexes the requested tree", () => {
  assert.equal(validateVersionHistory(fixture), fixture);
  const history = indexVersionHistory(fixture);
  assert.equal(history.root.name, "Founder v1");
  assert.deepEqual(history.children.get("founder-v1").map((node) => node.name), [
    "Healthcare",
    "Developers",
    "Marketing",
  ]);
  assert.equal(history.document.nodes.length, 10);
});

test("every node exposes all requested audit categories", () => {
  for (const node of fixture.nodes) {
    for (const field of ["attempts", "fileChanges", "emails", "conversations", "metrics", "lessons"]) {
      assert.ok(Array.isArray(node[field]), `${node.id}.${field}`);
    }
    assert.ok(node.moneySpent && Number.isFinite(node.moneySpent.amount));
  }
});

test("duplicate ids, missing parents, cycles, and negative spend fail closed", () => {
  const clone = () => structuredClone(fixture);
  const duplicate = clone();
  duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => validateVersionHistory(duplicate), /duplicate node id/);

  const orphan = clone();
  orphan.nodes[1].parentId = "missing";
  assert.throws(() => validateVersionHistory(orphan), /unknown parent/);

  const cycle = clone();
  cycle.nodes[0].parentId = cycle.nodes[1].id;
  assert.throws(() => validateVersionHistory(cycle), /exactly one root|cycle detected/);

  const spend = clone();
  spend.nodes[1].moneySpent.amount = -1;
  assert.throws(() => validateVersionHistory(spend), /must be non-negative/);
});
