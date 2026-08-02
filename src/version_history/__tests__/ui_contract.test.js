import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../../ui/version-history/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../ui/version-history/app.js", import.meta.url), "utf8");
const server = await readFile(
  new URL("../../../scripts/version-history-server.mjs", import.meta.url),
  "utf8"
);

test("UI is a run console with prompt, graph, output, and inspector surfaces", () => {
  assert.match(html, /href="\/ui\/version-history\/styles\.css"/);
  assert.match(html, /src="\/ui\/version-history\/app\.js"/);
  assert.match(html, /aria-label="Prompt runs"/);
  assert.match(html, /aria-label="Selected prompt branch graph"/);
  assert.match(html, /aria-labelledby="inspector-title"/);
  assert.match(html, /Local runtime/);
  assert.match(html, /<title>Branch<\/title>/);
  assert.match(html, />Branch<\/span>/);
  assert.doesNotMatch(html, /Branchbook/);
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
  assert.match(app, /traceStep/);
  assert.match(app, /Raw trajectory JSON/);
  assert.match(app, /estimated model cost/);
  assert.match(app, /Sailbox infrastructure/);
  assert.match(app, /\/api\/history/);
  assert.match(app, /\/api\/runs/);
  assert.match(app, /data-task/);
});

test("fan-out prompts appear live in history before trajectories finish", () => {
  assert.match(server, /workflowStatus: run\.status/);
  assert.match(server, /id: `workflow:\$\{run\.id\}`/);
  assert.match(server, /expectedBranches: run\.plannedBranches/);
  assert.match(server, /plannedApproaches: run\.plan\?\.approaches/);
  assert.match(server, /PARENT_PLAN/);
  assert.match(server, /PARENT_LEARNED/);
  assert.match(server, /RUN_METRICS/);
  assert.match(server, /metrics\.json/);
  assert.match(server, /tree\.json/);
  assert.match(app, /upsertWorkflowHistory/);
  assert.match(app, /activeWorkflow\.workflowId/);
  assert.match(app, /parent choosing up to/);
  assert.match(app, /checkpoint selected/);
  assert.match(app, /distilling the full winning path/);
  assert.match(html, /id="max-branches"/);
  assert.match(html, /id="max-depth"/);
  assert.match(html, /Run adaptive/);
  assert.match(app, /branchForest/);
  assert.match(app, /liveTreeNodes/);
  assert.match(app, /parent_branch_id/);
  assert.match(app, /Learned runbook guidance/);
  assert.match(app, /Parent decisions/);
  assert.match(server, /TREE_ROUND/);
  assert.match(server, /--max-depth/);
  assert.match(server, /live checkpoint tree/);
});

test("console server uses a fixed task allowlist without a shell", () => {
  for (const task of ["fanout", "replay", "judge", "distill", "rehearse"]) {
    assert.ok(server.includes(`task === "${task}"`), task);
  }
  for (const task of ["validate", "demo-check", "tests"]) {
    assert.ok(!server.includes(`task === "${task}"`), task);
    assert.ok(!html.includes(`data-task="${task}"`), task);
  }
  assert.match(server, /shell: false/);
  assert.match(server, /already running/);
  assert.match(server, /kill\("SIGINT"\)/);
  assert.match(server, /\/api\/history/);
  assert.ok(server.includes("/^b\\d+\\.json$/"));
  assert.ok(server.includes('"runbook_voice.distiller"'));
});

test("console exposes completed agents and routes matching prompts to warm replay", () => {
  for (const id of [
    "show-agents", "agents-sidebar", "agent-list", "agents-workspace",
    "agent-detail", "agent-output",
  ]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /Completed agents/);
  assert.match(app, /USE WITHOUT RE-BRANCHING/);
  assert.match(app, /\/api\/agents/);
  assert.match(app, /agent_match/);
  assert.match(app, /Use completed agent/);
  assert.match(app, /startAgentReplay/);
  assert.match(app, /runMatchedAgent/);
  assert.match(app, /prefilledSlots/);
  assert.match(app, /inputSource/);
  assert.match(server, /\/api\/agents\/match/);
  assert.match(server, /completed_agents/);
  assert.match(server, /no branch search was launched/);
  assert.match(server, /input\.task === "fanout"/);
  assert.match(server, /listReplayRuns/);
  assert.match(server, /persistReplay/);
});

test("console records, transcribes, and routes microphone prompts through the shared runner", () => {
  assert.match(html, /id="microphone-button"/);
  assert.match(html, /id="voice-state"/);
  assert.match(app, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(app, /new MediaRecorder/);
  assert.match(app, /\/api\/voice\/status/);
  assert.match(app, /\/api\/voice\/config/);
  assert.match(app, /\/api\/voice\/transcribe/);
  assert.match(app, /window\.prompt/);
  assert.match(app, /startTask\("fanout", \{ inputSource: "voice" \}\)/);
  assert.match(server, /OPENAI_API_KEY/);
  assert.match(server, /\/v1\/audio\/transcriptions/);
  assert.match(server, /\/api\/voice\/config/);
  assert.match(server, /requestSource/);
  assert.match(server, /request\.json/);
});

test("console includes a no-terminal authentication workspace", () => {
  for (const id of [
    "show-auth", "auth-workspace", "provider-list", "auth-accounts",
    "grant-form", "auth-grants", "auth-audit",
  ]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const endpoint of [
    "/api/auth", "/api/auth/oauth/start", "/api/auth/grants",
    "/api/auth/rotate",
  ]) {
    assert.ok(server.includes(endpoint), endpoint);
  }
  assert.match(app, /Connect OAuth/);
  assert.match(html, /Create scoped grant/);
  assert.match(app, /window\.confirm/);
  assert.match(app, /Existing grants will stop immediately/);
});
