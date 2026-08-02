const runList = document.querySelector("#run-list");
const branchCanvas = document.querySelector("#branch-canvas");
const inspector = document.querySelector("#inspector");
const runOutput = document.querySelector("#run-output");
const runLabel = document.querySelector("#run-label");
const consoleState = document.querySelector("#console-state");
const stopButton = document.querySelector("#stop-run");
const outputDrawer = document.querySelector("#output-drawer");

let histories = [];
let selectedRun = null;
let selectedBranch = null;
let activeRunId = null;
let pollTimer = null;
let lastFanoutPrompt = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function compact(text, length = 92) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

function elapsed(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function branchStatus(branch, run) {
  if (run.winner === branch.branch_id) return "winner";
  if (branch.error || !branch.success_signal) return "stopped";
  return "completed";
}

function runStatus(run) {
  if (run.workflowStatus) return run.workflowStatus;
  if (run.learning?.runbook_id) return "learned";
  if (run.winner) return "judged";
  if (run.branches.length && run.branches.every((branch) => branch.success_signal)) return "complete";
  return "mixed";
}

function workflowHistory(run) {
  return {
    id: `workflow:${run.id}`,
    workflowId: run.id,
    task: run.request,
    source: "live",
    path: "live fan-out",
    createdAt: run.startedAt,
    winner: null,
    branches: [],
    workflowStatus: run.status,
    workflowPhase: run.parentPhase,
    expectedBranches: run.plannedBranches,
    plannedApproaches: run.plan?.approaches ?? [],
    branchLimit: run.branchLimit,
    learning: run.learning,
  };
}

function liveRunMeta(run) {
  if (run.expectedBranches) return `${run.expectedBranches} approaches · ${run.workflowPhase ?? "running"}`;
  return `parent choosing up to ${run.branchLimit ?? 5}`;
}

function upsertWorkflowHistory(run, { select = false } = {}) {
  if (run.task !== "fanout" || !run.request) return;
  const liveRun = workflowHistory(run);
  const index = histories.findIndex((history) => history.id === liveRun.id);
  if (index === -1) histories.unshift(liveRun);
  else histories[index] = liveRun;
  document.querySelector("#run-count").textContent = String(histories.length);
  if (select || selectedRun?.id === liveRun.id) selectRun(liveRun);
  else renderRunList();
}

function setConsoleState(status, label) {
  consoleState.className = `console-state ${status}`;
  consoleState.querySelector("span").textContent = label;
  const busy = status === "running" || status === "stopping";
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.disabled = busy;
  });
  stopButton.disabled = !busy;
}

function showOutput() {
  outputDrawer.classList.remove("collapsed");
}

async function loadHistory({ preferPrompt } = {}) {
  const response = await fetch("/api/history");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Could not load prompt history");
  histories = payload.runs;
  document.querySelector("#run-count").textContent = String(histories.length);
  renderRunList();

  const activeWorkflow = histories.find(
    (run) => run.workflowId && (run.workflowStatus === "running" || run.workflowStatus === "stopping")
  );
  if (activeWorkflow && !activeRunId) {
    activeRunId = activeWorkflow.workflowId;
    lastFanoutPrompt = activeWorkflow.task;
    runLabel.textContent = "Adaptive Sail fan-out + learn";
    setConsoleState(activeWorkflow.workflowStatus, activeWorkflow.workflowStatus === "stopping" ? "Stopping safely" : "Running");
    pollTimer = window.setTimeout(pollRun, 100);
  }

  const preferred = preferPrompt
    ? histories.find((run) => run.task === preferPrompt)
    : histories.find((run) => run.id === selectedRun?.id);
  if (preferred || (!selectedRun && histories[0])) selectRun(preferred ?? histories[0]);
  if (!histories.length) {
    branchCanvas.replaceChildren(element("div", "canvas-empty", "No saved prompt runs yet. Run your first prompt above."));
  }
}

function renderRunList() {
  const query = document.querySelector("#run-search").value.trim().toLowerCase();
  const visible = histories.filter((run) => run.task.toLowerCase().includes(query));
  runList.replaceChildren();
  if (!visible.length) {
    runList.append(element("p", "run-list-empty", query ? "No matching prompts." : "No prompt runs yet."));
    return;
  }
  for (const run of visible) {
    const button = element("button", "run-list-item");
    button.type = "button";
    button.classList.toggle("selected", selectedRun?.id === run.id);
    button.dataset.runId = run.id;
    const top = element("span", "run-list-top");
    top.append(element("span", `run-source ${run.source}`, run.source));
    top.append(element("span", `run-status ${runStatus(run)}`, runStatus(run)));
    button.append(top, element("strong", "", compact(run.task, 68)));
    const meta = element("span", "run-list-meta");
    const branchMeta = run.workflowStatus
      ? liveRunMeta(run)
      : `${run.branches.length} branches`;
    meta.append(element("span", "", branchMeta));
    meta.append(element("span", "", new Date(run.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
    button.append(meta);
    button.addEventListener("click", () => selectRun(run));
    runList.append(button);
  }
}

function selectRun(run) {
  selectedRun = run;
  selectedBranch = null;
  document.querySelector("#selected-prompt").textContent = run.task;
  const meta = document.querySelector("#selected-meta");
  meta.replaceChildren(
    element("span", `source-chip ${run.source}`, run.source),
    element("span", "", run.workflowStatus ? liveRunMeta(run) : `${run.branches.length} trajectories`),
    element("span", "", run.workflowStatus ?? (run.winner ? `winner ${run.winner}` : "not judged")),
    element("span", "", run.path)
  );
  renderRunList();
  renderBranchCanvas();
  renderRunSummary();
}

function renderBranchCanvas() {
  branchCanvas.replaceChildren();
  if (!selectedRun) return;
  const graph = element("div", "prompt-graph");
  const promptNode = element("button", "prompt-node selected");
  promptNode.type = "button";
  promptNode.append(element("span", "node-kicker", "PROMPT"));
  promptNode.append(element("strong", "", compact(selectedRun.task, 118)));
  const approachCount = selectedRun.workflowStatus
    ? (selectedRun.expectedBranches ? `${selectedRun.expectedBranches} parent-planned approaches` : `parent choosing up to ${selectedRun.branchLimit ?? 5} approaches`)
    : `${selectedRun.branches.length} independent approaches`;
  promptNode.append(element("small", "", approachCount));
  promptNode.addEventListener("click", () => {
    selectedBranch = null;
    renderBranchCanvas();
    renderRunSummary();
  });
  graph.append(promptNode);

  const branches = element("div", "branch-row");
  if (selectedRun.workflowStatus && !selectedRun.branches.length) {
    if (!selectedRun.expectedBranches) {
      const planner = element("div", "branch-node live-branch parent-planner-node");
      const heading = element("span", "branch-heading");
      heading.append(element("span", "branch-id", "parent"));
      heading.append(element("span", "branch-state running", "planning"));
      planner.append(heading);
      planner.append(element("span", "branch-angle", `Choosing 2–${selectedRun.branchLimit ?? 5} materially different approaches…`));
      const progress = element("span", "live-progress");
      progress.append(element("i"), element("i"), element("i"));
      planner.append(progress);
      branches.append(planner);
    }
    for (let index = 0; index < (selectedRun.expectedBranches ?? 0); index += 1) {
      const node = element("div", "branch-node live-branch");
      const heading = element("span", "branch-heading");
      heading.append(element("span", "branch-id", `b${index}`));
      heading.append(element("span", "branch-state running", selectedRun.workflowStatus));
      node.append(heading);
      const phaseCopy = selectedRun.workflowPhase === "judging and learning"
        ? "Trajectory complete; parent is judging and learning…"
        : "Distinct agent trajectory is running…";
      node.append(element("span", "branch-angle", selectedRun.plannedApproaches?.[index] ?? phaseCopy));
      const progress = element("span", "live-progress");
      progress.append(element("i"), element("i"), element("i"));
      node.append(progress);
      branches.append(node);
    }
  }
  selectedRun.branches.forEach((branch) => {
    const status = branchStatus(branch, selectedRun);
    const button = element("button", `branch-node ${status}`);
    button.type = "button";
    button.classList.toggle("selected", selectedBranch?.branch_id === branch.branch_id);
    button.dataset.branchId = branch.branch_id;
    button.setAttribute("aria-label", `Inspect ${branch.branch_id} trace`);
    const heading = element("span", "branch-heading");
    heading.append(element("span", "branch-id", branch.branch_id));
    heading.append(element("span", `branch-state ${status}`, status));
    button.append(heading);
    button.append(element("span", "branch-angle", compact(branch.angle, 96)));
    const metrics = element("span", "branch-metrics");
    metrics.append(element("span", "", `${branch.steps.length} steps`));
    metrics.append(element("span", "", elapsed(branch.wall_ms)));
    metrics.append(element("span", "", `${branch.steps.filter((step) => step.outcome === "error").length} errors`));
    button.append(metrics);
    button.addEventListener("click", () => selectBranch(branch));
    branches.append(button);
  });
  graph.append(branches);
  branchCanvas.append(graph);
}

function selectBranch(branch) {
  selectedBranch = branch;
  renderBranchCanvas();
  renderTraceInspector(branch);
}

function inspectorHeader(title, kicker, status) {
  const header = element("header", "trace-header");
  const top = element("div", "trace-header-top");
  top.append(element("span", "section-kicker", kicker));
  top.append(element("span", `trace-status ${status}`, status));
  header.append(top);
  const heading = element("h2", "", title);
  heading.id = "inspector-title";
  header.append(heading);
  return header;
}

function renderRunSummary() {
  inspector.replaceChildren();
  if (!selectedRun) return;
  const header = inspectorHeader("Prompt overview", "RUN SUMMARY", runStatus(selectedRun));
  header.append(element("p", "trace-summary", selectedRun.task));
  inspector.append(header);
  if (selectedRun.workflowStatus) {
    const live = element("section", "live-run-summary");
    live.append(element("strong", "", selectedRun.workflowPhase ?? "Parent workflow in progress"));
    live.append(element("p", "", selectedRun.expectedBranches
      ? `The parent chose ${selectedRun.expectedBranches} distinct approaches within your limit. After they finish, it will judge the complete trajectories, distill the winner, validate the runbook, and update its durable memory.`
      : `The parent is deciding how many distinct approaches this task needs, up to your limit of ${selectedRun.branchLimit ?? 5}.`));
    inspector.append(live);
    return;
  }
  if (selectedRun.learning?.runbook_id) {
    const learned = element("section", "learned-run-summary");
    learned.append(element("strong", "", `Parent learned ${selectedRun.learning.runbook_name ?? selectedRun.learning.runbook_id}`));
    learned.append(element("p", "", `${selectedRun.learning.reason} The validated runbook was saved as ${selectedRun.learning.runbook_id} in ${selectedRun.learning.store_path}.`));
    inspector.append(learned);
  }
  const grid = element("div", "run-metric-grid");
  const totalSteps = selectedRun.branches.reduce((sum, branch) => sum + branch.steps.length, 0);
  const successes = selectedRun.branches.filter((branch) => branch.success_signal).length;
  for (const [label, value] of [["Branches", selectedRun.branches.length], ["Total steps", totalSteps], ["Success signals", `${successes}/${selectedRun.branches.length}`], ["Winner", selectedRun.winner ?? "—"]]) {
    const card = element("div", "run-metric");
    card.append(element("span", "", label), element("strong", "", String(value)));
    grid.append(card);
  }
  inspector.append(grid);
  const section = element("section", "inspector-section");
  section.append(element("h3", "", "Branch approaches"));
  selectedRun.branches.forEach((branch) => {
    const row = element("button", "approach-row");
    row.type = "button";
    row.append(element("b", "", branch.branch_id), element("p", "", branch.angle));
    row.addEventListener("click", () => selectBranch(branch));
    section.append(row);
  });
  inspector.append(section);
  const invariant = element("section", "safety-note");
  invariant.append(element("strong", "", "Safety boundary"));
  invariant.append(element("p", "", "Branches can research and change isolated in-box state. Emails, charges, bookings, and other external side effects remain blocked until a single confirmed path executes."));
  inspector.append(invariant);
}

function traceStep(step) {
  const item = element("details", `trace-step outcome-${step.outcome ?? "unknown"}`);
  const summary = element("summary", "");
  const index = element("span", "step-index", String(step.i).padStart(2, "0"));
  const main = element("span", "step-main");
  main.append(element("strong", "", step.action ?? step.kind ?? "step"));
  main.append(element("small", "", compact(step.args?.command ?? step.observation_excerpt ?? step.note ?? "No detail", 95)));
  const meta = element("span", "step-meta");
  meta.append(element("span", "", `${step.t ?? 0}s`), element("span", `step-outcome ${step.outcome ?? ""}`, step.outcome ?? "—"));
  summary.append(index, main, meta);
  item.append(summary);
  const body = element("div", "step-body");
  if (step.kind) body.append(detailRow("Kind", step.kind));
  if (step.args && Object.keys(step.args).length) body.append(detailRow("Arguments", JSON.stringify(step.args, null, 2), true));
  if (step.observation_excerpt) body.append(detailRow("Observation", step.observation_excerpt, true));
  if (step.note) body.append(detailRow("Note", step.note));
  item.append(body);
  return item;
}

function detailRow(label, value, pre = false) {
  const row = element("div", "detail-row");
  row.append(element("span", "", label));
  row.append(element(pre ? "pre" : "p", "", value));
  return row;
}

function auditSection(title, value, tone = "") {
  const section = element("section", "inspector-section audit-summary");
  section.append(element("h3", "", title));
  section.append(element("p", tone, value));
  return section;
}

function renderTraceInspector(branch) {
  inspector.replaceChildren();
  const status = branchStatus(branch, selectedRun);
  const header = inspectorHeader(branch.branch_id, "TRAJECTORY", status);
  header.append(element("p", "trace-angle", branch.angle));
  const stats = element("div", "trace-stats");
  stats.append(element("span", "", `${branch.steps.length} steps`));
  stats.append(element("span", "", elapsed(branch.wall_ms)));
  stats.append(element("span", "", `${branch.steps.filter((step) => step.outcome === "abandoned").length} abandoned`));
  stats.append(element("span", "", `${branch.steps.filter((step) => step.outcome === "error").length} errors`));
  header.append(stats);
  inspector.append(header);

  const trace = element("section", "inspector-section trace-section");
  trace.append(element("h3", "", "What the agent tried"));
  const timeline = element("div", "trace-timeline");
  branch.steps.forEach((step) => timeline.append(traceStep(step)));
  trace.append(timeline);
  inspector.append(trace);

  inspector.append(auditSection("Files changed", "No structured file mutations were emitted by this trajectory."));
  inspector.append(auditSection("Emails sent", "None. Branches are read-only and cannot send external messages.", "safe"));
  inspector.append(auditSection("Conversations", "No external conversations were recorded."));
  inspector.append(auditSection("Money spent", "Not emitted by the current trajectory schema. Sail/model usage remains visible in provider billing."));
  inspector.append(auditSection("Metrics achieved", `${branch.steps.length} recorded steps · ${elapsed(branch.wall_ms)} wall time · success signal ${branch.success_signal ? "true" : "false"}.`, branch.success_signal ? "safe" : "warning"));
  inspector.append(auditSection("Lessons learned", branch.final_answer ?? branch.error ?? "No final answer was recorded."));

  const raw = element("details", "raw-trace");
  raw.append(element("summary", "", "Raw trajectory JSON"));
  raw.append(element("pre", "", JSON.stringify(branch, null, 2)));
  inspector.append(raw);
}

async function pollRun() {
  if (!activeRunId) return;
  try {
    const response = await fetch(`/api/runs/${activeRunId}`);
    const run = await response.json();
    if (!response.ok) throw new Error(run.error ?? "Could not read workflow status");
    runLabel.textContent = run.label;
    runOutput.textContent = run.output;
    runOutput.scrollTop = runOutput.scrollHeight;
    upsertWorkflowHistory(run);
    if (run.status === "running" || run.status === "stopping") {
      setConsoleState(run.status, run.status === "stopping" ? "Stopping safely" : "Running");
      pollTimer = window.setTimeout(pollRun, 700);
    } else {
      setConsoleState(run.status, run.status === "succeeded" ? "Completed" : run.status);
      activeRunId = null;
      pollTimer = null;
      await loadHistory({ preferPrompt: lastFanoutPrompt });
      lastFanoutPrompt = null;
    }
  } catch (error) {
    runOutput.textContent += `\n[console] ${error.message}\n`;
    setConsoleState("failed", "Connection error");
    activeRunId = null;
  }
}

async function startTask(task) {
  showOutput();
  setConsoleState("running", "Starting");
  runOutput.textContent = "Starting…";
  try {
    const body = { task };
    if (task === "fanout") {
      body.request = document.querySelector("#fanout-request").value.trim();
      body.maxBranches = Number(document.querySelector("#max-branches").value);
      lastFanoutPrompt = body.request;
    }
    if (task === "judge" || task === "distill") {
      if (!selectedRun) throw new Error("Select a prompt run first");
      body.runId = selectedRun.id;
    }
    if (task === "distill") {
      if (!selectedBranch) throw new Error("Select a branch node first");
      body.branchId = selectedBranch.branch_id;
    }
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error ?? "Could not start workflow");
    activeRunId = run.id;
    runLabel.textContent = run.label;
    runOutput.textContent = run.output;
    upsertWorkflowHistory(run, { select: task === "fanout" });
    await pollRun();
  } catch (error) {
    runOutput.textContent = `[console] ${error.message}`;
    setConsoleState("failed", "Could not start");
    activeRunId = null;
  }
}

document.querySelectorAll("[data-task]").forEach((button) => {
  button.addEventListener("click", () => startTask(button.dataset.task));
});
document.querySelector("#run-search").addEventListener("input", renderRunList);
document.querySelector("#refresh-history").addEventListener("click", () => loadHistory());
document.querySelector("#toggle-output").addEventListener("click", () => outputDrawer.classList.toggle("collapsed"));
stopButton.addEventListener("click", async () => {
  if (!activeRunId) return;
  stopButton.disabled = true;
  await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
  window.clearTimeout(pollTimer);
  await pollRun();
});

loadHistory().catch((error) => {
  branchCanvas.replaceChildren(element("div", "canvas-empty error", error.message));
});

const runSidebar = document.querySelector("#run-sidebar");
const authSidebar = document.querySelector("#auth-sidebar");
const runsWorkspace = document.querySelector("#runs-workspace");
const authWorkspace = document.querySelector("#auth-workspace");
const authAccounts = document.querySelector("#auth-accounts");
const authGrants = document.querySelector("#auth-grants");
const authAudit = document.querySelector("#auth-audit");
const authMessage = document.querySelector("#auth-message");
let authentication = { providers: [], accounts: [], grants: [], audit: [] };

function switchWorkspace(name) {
  const auth = name === "auth";
  runSidebar.classList.toggle("hidden", auth);
  runsWorkspace.classList.toggle("hidden", auth);
  inspector.classList.toggle("hidden", auth);
  authSidebar.classList.toggle("hidden", !auth);
  authWorkspace.classList.toggle("hidden", !auth);
  document.querySelector("#show-runs").classList.toggle("active", !auth);
  document.querySelector("#show-auth").classList.toggle("active", auth);
  const url = new URL(window.location.href);
  if (auth) url.searchParams.set("workspace", "auth");
  else url.searchParams.delete("workspace");
  window.history.replaceState({}, "", url);
  if (auth) loadAuth();
}

async function authRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options.headers,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Authentication request failed");
  return payload;
}

function setAuthMessage(message, tone = "") {
  authMessage.className = `auth-message ${tone}`;
  authMessage.textContent = message;
}

async function loadAuth() {
  try {
    authentication = await authRequest("/api/auth");
    renderAuth();
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

function renderProviders() {
  const list = document.querySelector("#provider-list");
  list.replaceChildren();
  document.querySelector("#provider-count").textContent = String(authentication.providers.length);
  for (const provider of authentication.providers) {
    const card = element("section", `provider-card ${provider.configured ? "configured" : ""}`);
    const heading = element("div", "provider-heading");
    heading.append(element("strong", "", provider.name));
    heading.append(element("span", provider.configured ? "provider-ready" : "provider-missing", provider.configured ? "ready" : "needs client ID"));
    card.append(heading, element("p", "", provider.defaultScopes.join(" · ")));
    const actions = element("div", "provider-actions");
    const browserButton = element("button", "", "Connect OAuth");
    browserButton.type = "button";
    browserButton.disabled = !provider.configured;
    browserButton.addEventListener("click", () => beginOAuth(provider.id, "authorization_code"));
    const deviceButton = element("button", "", "Device code");
    deviceButton.type = "button";
    deviceButton.disabled = !provider.configured;
    deviceButton.addEventListener("click", () => beginOAuth(provider.id, "device_code"));
    const writeButton = element("button", "", "Add write access");
    writeButton.type = "button";
    writeButton.disabled = !provider.configured;
    writeButton.addEventListener("click", () => {
      const scopeList = provider.writeScopes.join("\n");
      if (!window.confirm(`Request these additional ${provider.name} write scopes?\n\n${scopeList}\n\nThey still require a separate single-use agent grant.`)) return;
      beginOAuth(provider.id, "authorization_code", [...provider.defaultScopes, ...provider.writeScopes]);
    });
    actions.append(browserButton, deviceButton, writeButton);
    card.append(actions);
    list.append(card);
  }
}

async function beginOAuth(provider, flow, scopes = []) {
  setAuthMessage(`Starting ${provider} ${flow === "device_code" ? "device" : "browser"} authorization…`);
  try {
    const attempt = await authRequest("/api/auth/oauth/start", {
      method: "POST",
      body: JSON.stringify({ provider, flow, scopes }),
    });
    if (attempt.authorizationUrl) {
      const link = element("a", "auth-connect-link", `Continue to ${provider} authorization ↗`);
      link.href = attempt.authorizationUrl;
      link.target = "_blank";
      link.rel = "noopener";
      authMessage.replaceChildren(link, document.createTextNode(" — return here after approving access."));
    } else {
      const link = element("a", "auth-connect-link", attempt.verificationUri);
      link.href = attempt.verificationUri;
      link.target = "_blank";
      link.rel = "noopener";
      const poll = element("button", "inline-auth-button", "I approved it — check now");
      poll.type = "button";
      poll.addEventListener("click", () => pollDevice(attempt.id));
      authMessage.replaceChildren(
        document.createTextNode(`Enter code ${attempt.userCode} at `), link,
        document.createTextNode(" "), poll
      );
    }
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function pollDevice(attemptId) {
  try {
    const result = await authRequest(`/api/auth/oauth/${encodeURIComponent(attemptId)}/poll`, { method: "POST" });
    if (result.attempt?.status === "connected" || result.status === "connected") {
      setAuthMessage("Account connected. The agent can use only the grants you create.", "success");
      await loadAuth();
    } else {
      setAuthMessage("Authorization is still pending. Approve it in the provider window, then check again.");
    }
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

function accountCard(account) {
  const card = element("article", `account-card status-${account.status}`);
  const heading = element("div", "account-heading");
  const identity = element("div", "");
  identity.append(element("span", "provider-name", account.provider), element("strong", "", account.account));
  heading.append(identity, element("span", `account-status ${account.status}`, account.status));
  card.append(heading);
  const metadata = element("dl", "account-metadata");
  for (const [label, value] of [
    ["Handle", account.id], ["Type", account.type], ["Domains", account.domains.join(", ")],
    ["Scopes", account.scopes.join(", ") || "none"], ["Expires", account.expiresAt ? new Date(account.expiresAt).toLocaleString() : "provider-managed"],
  ]) {
    metadata.append(element("dt", "", label), element("dd", "", value));
  }
  card.append(metadata);
  const actions = element("div", "account-actions");
  for (const [label, action, danger] of [
    ["Test", () => accountAction(account, "check"), false],
    ["Refresh", () => accountAction(account, "refresh"), false],
    ["Rotate", () => rotateAccount(account.provider), false],
    ["Revoke", () => revokeAccount(account), true],
  ]) {
    const button = element("button", danger ? "danger" : "", label);
    button.type = "button";
    button.disabled = account.status === "revoked";
    button.addEventListener("click", action);
    actions.append(button);
  }
  card.append(actions);
  return card;
}

async function accountAction(account, action) {
  setAuthMessage(`${action === "check" ? "Testing" : "Refreshing"} ${account.provider}/${account.account}…`);
  try {
    const result = await authRequest(`/api/auth/accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST" });
    setAuthMessage(action === "check" ? `${account.provider} is healthy (${result.checks.length} checks).` : "Credential refreshed.", "success");
    await loadAuth();
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function rotateAccount(provider) {
  try {
    const selected = await authRequest("/api/auth/rotate", { method: "POST", body: JSON.stringify({ provider }) });
    setAuthMessage(`Rotation selected ${selected.account} (${selected.id}).`, "success");
    await loadAuth();
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function revokeAccount(account) {
  if (!window.confirm(`Revoke ${account.provider}/${account.account}? Existing grants will stop immediately.`)) return;
  try {
    await authRequest(`/api/auth/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    setAuthMessage(`${account.provider}/${account.account} revoked.`, "success");
    await loadAuth();
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

function renderAccounts() {
  authAccounts.replaceChildren();
  document.querySelector("#account-count").textContent = String(authentication.accounts.length);
  const active = authentication.accounts.filter((account) => account.status !== "revoked");
  document.querySelector("#auth-summary").textContent = `${active.length} connected · ${authentication.grants.filter((grant) => grant.status === "active").length} active grants`;
  if (!authentication.accounts.length) authAccounts.append(element("p", "auth-empty", "No accounts connected. Choose a configured provider to begin."));
  authentication.accounts.forEach((account) => authAccounts.append(accountCard(account)));
  const select = document.querySelector("#grant-account");
  const current = select.value;
  select.replaceChildren(new Option("Choose an account", ""));
  active.forEach((account) => select.append(new Option(`${account.provider} · ${account.account}`, account.id)));
  if (active.some((account) => account.id === current)) select.value = current;
}

function renderGrants() {
  authGrants.replaceChildren();
  const grants = authentication.grants.filter((grant) => grant.status !== "revoked");
  if (!grants.length) authGrants.append(element("p", "auth-empty", "No grants yet. Connected accounts remain unusable by agents until you create one."));
  for (const grant of grants) {
    const row = element("article", `grant-card status-${grant.status}`);
    const heading = element("div", "grant-heading");
    heading.append(element("strong", "", grant.actions.join(" + ")), element("span", "", grant.status));
    row.append(heading, element("p", "", `${grant.runId}${grant.branchId ? ` / ${grant.branchId}` : ""} · ${grant.domains.join(", ")}`));
    row.append(element("small", "", `${grant.id} · expires ${new Date(grant.expiresAt).toLocaleTimeString()}`));
    if (grant.status === "active") {
      const revoke = element("button", "", "Revoke grant");
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        await authRequest(`/api/auth/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST" });
        await loadAuth();
      });
      row.append(revoke);
    }
    authGrants.append(row);
  }
}

function renderAudit() {
  authAudit.replaceChildren();
  if (!authentication.audit.length) authAudit.append(element("p", "auth-empty", "No credential activity yet."));
  for (const event of authentication.audit) {
    const row = element("article", "audit-event");
    row.append(element("strong", "", event.type), element("time", "", new Date(event.at).toLocaleTimeString()));
    row.append(element("p", "", [event.provider, event.action, event.result].filter(Boolean).join(" · ") || "metadata only"));
    authAudit.append(row);
  }
}

function renderAuth() {
  renderProviders();
  renderAccounts();
  renderGrants();
  renderAudit();
}

document.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => switchWorkspace(button.dataset.workspace)));
document.querySelector("#refresh-auth").addEventListener("click", loadAuth);
document.querySelector("#grant-account").addEventListener("change", (event) => {
  const account = authentication.accounts.find((item) => item.id === event.target.value);
  if (!account) return;
  document.querySelector("#grant-domain").value = account.domains[0] ?? "";
  document.querySelector("#grant-scopes").value = account.scopes.join(" ");
});
document.querySelector("#grant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const actions = [...document.querySelectorAll('input[name="grant-action"]:checked')].map((input) => input.value);
  try {
    await authRequest("/api/auth/grants", {
      method: "POST",
      body: JSON.stringify({
        credentialId: document.querySelector("#grant-account").value,
        runId: document.querySelector("#grant-run").value.trim(),
        branchId: document.querySelector("#grant-branch").value.trim() || null,
        domains: [document.querySelector("#grant-domain").value.trim()],
        scopes: document.querySelector("#grant-scopes").value.trim().split(/\s+/).filter(Boolean),
        actions,
        confirmed: document.querySelector("#grant-confirm").checked,
      }),
    });
    setAuthMessage("Scoped grant created. It will expire automatically.", "success");
    await loadAuth();
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
});

const initialParams = new URLSearchParams(window.location.search);
if (initialParams.get("workspace") === "auth") switchWorkspace("auth");
if (initialParams.get("auth_error")) setAuthMessage(initialParams.get("auth_error"), "error");
if (initialParams.get("connected")) setAuthMessage("Account connected successfully.", "success");
