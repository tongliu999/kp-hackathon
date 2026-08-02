const runList = document.querySelector("#run-list");
const branchCanvas = document.querySelector("#branch-canvas");
const inspector = document.querySelector("#inspector");
const runOutput = document.querySelector("#run-output");
const runLabel = document.querySelector("#run-label");
const consoleState = document.querySelector("#console-state");
const stopButton = document.querySelector("#stop-run");
const outputDrawer = document.querySelector("#output-drawer");
const agentOutput = document.querySelector("#agent-output");
const agentRunLabel = document.querySelector("#agent-run-label");
const agentStopButton = document.querySelector("#agent-stop-run");
const microphoneButton = document.querySelector("#microphone-button");
const voiceState = document.querySelector("#voice-state");
const agentActiveRun = document.querySelector("#agent-active-run");

let histories = [];
let completedAgents = [];
let selectedRun = null;
let selectedBranch = null;
let selectedAgent = null;
let activeRunId = null;
let activeRunTask = null;
let pollTimer = null;
let lastFanoutPrompt = null;
let selectedAgentPrefill = {};
let selectedAgentRequest = "";
let mediaRecorder = null;
let microphoneStream = null;
let audioChunks = [];
let microphoneTimer = null;
let voiceConfigured = false;
let voiceSupported = false;

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

function usd(value) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function tokens(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat().format(value);
}

function branchStatus(branch, run) {
  if (run.winner === branch.branch_id) return "winner";
  const byId = new Map(run.branches.map((item) => [item.branch_id, item]));
  let cursor = byId.get(run.winner);
  while (cursor?.parent_branch_id) {
    if (cursor.parent_branch_id === branch.branch_id) return "promising";
    cursor = byId.get(cursor.parent_branch_id);
  }
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
  if (run.task === "replay") {
    return {
      id: `workflow:${run.id}`,
      workflowId: run.id,
      task: run.request,
      source: run.inputSource ?? "typed",
      path: `completed agent / ${run.agentId}`,
      createdAt: run.startedAt,
      winner: null,
      branches: [],
      runKind: "replay",
      agentId: run.agentId,
      workflowStatus: run.status,
      workflowPhase: run.parentPhase,
      replayResult: run.replayResult,
      output: run.output,
    };
  }
  return {
    id: `workflow:${run.id}`,
    workflowId: run.id,
    task: run.request,
    source: run.inputSource ?? "typed",
    path: "live checkpoint tree",
    createdAt: run.startedAt,
    winner: null,
    branches: [],
    workflowStatus: run.status,
    workflowPhase: run.parentPhase,
    expectedBranches: run.plannedBranches,
    plannedApproaches: run.plan?.approaches ?? [],
    branchLimit: run.branchLimit,
    maxDepth: run.maxDepth,
    learning: run.learning,
    metrics: run.metrics,
    treeRounds: run.treeRounds ?? [],
  };
}

function liveRunMeta(run) {
  if (run.expectedBranches) return `${run.expectedBranches} first-round approaches · ${run.workflowPhase ?? "running"}`;
  return `parent choosing up to ${run.branchLimit ?? 5} children × ${run.maxDepth ?? 3} levels`;
}

function upsertWorkflowHistory(run, { select = false } = {}) {
  if ((run.task !== "fanout" && run.task !== "replay") || !run.request) return;
  const liveRun = workflowHistory(run);
  const index = histories.findIndex((history) => history.id === liveRun.id);
  if (index === -1) histories.unshift(liveRun);
  else histories[index] = liveRun;
  document.querySelector("#run-count").textContent = String(histories.length);
  if (select || selectedRun?.id === liveRun.id) selectRun(liveRun);
  else renderRunList();
}

function renderAgentActiveRun(run) {
  if (!run || run.task !== "replay") {
    agentActiveRun.replaceChildren();
    agentActiveRun.className = "agent-active-run hidden";
    return;
  }
  agentActiveRun.className = `agent-active-run ${run.status}`;
  const heading = element("div", "active-run-heading");
  heading.append(
    element("span", "active-run-state", run.status === "succeeded" ? "Agent completed" : run.status === "running" ? "Agent running" : run.status),
    element("span", "run-source", run.inputSource ?? "typed")
  );
  const view = element("button", "", run.id ? "View run →" : "Starting…");
  view.type = "button";
  view.disabled = !run.id;
  view.addEventListener("click", () => {
    switchWorkspace("runs");
    const history = histories.find(
      (item) => item.workflowId === run.id || item.id === `workflow:${run.id}` || item.id === `replay:${run.id}`
    );
    if (history) selectRun(history);
  });
  agentActiveRun.replaceChildren(
    heading,
    element("strong", "", compact(run.request || run.label, 78)),
    element("p", "", `${run.agentId} · ${run.parentPhase ?? "starting saved runbook"}`),
    view
  );
}

function setConsoleState(status, label) {
  consoleState.className = `console-state ${status}`;
  consoleState.querySelector("span").textContent = label;
  const busy = status === "running" || status === "stopping";
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.disabled = busy;
  });
  document.querySelectorAll("[data-busy-control]").forEach((button) => {
    button.disabled = busy;
  });
  microphoneButton.disabled = busy || !voiceSupported;
  stopButton.disabled = !busy;
  agentStopButton.disabled = !busy;
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
    activeRunTask = activeWorkflow.runKind === "replay" ? "replay" : "fanout";
    lastFanoutPrompt = activeWorkflow.task;
    if (activeRunTask === "replay") {
      agentRunLabel.textContent = `Reuse completed agent · ${activeWorkflow.agentId}`;
      renderAgentActiveRun({
        id: activeWorkflow.workflowId,
        task: "replay",
        status: activeWorkflow.workflowStatus,
        request: activeWorkflow.task,
        agentId: activeWorkflow.agentId,
        inputSource: activeWorkflow.source,
        parentPhase: activeWorkflow.workflowPhase,
      });
    } else {
      runLabel.textContent = "Adaptive Sail tree + learn";
    }
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
    const branchMeta = run.runKind === "replay"
      ? `reused ${run.agentId}`
      : run.workflowStatus
        ? liveRunMeta(run)
        : `${run.branches.length} tree nodes`;
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
    element("span", "", run.runKind === "replay" ? `completed agent ${run.agentId}` : run.workflowStatus ? liveRunMeta(run) : `${run.branches.length} persisted tree nodes`),
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
  const approachCount = selectedRun.runKind === "replay"
    ? `warm replay · ${selectedRun.source} input`
    : selectedRun.workflowStatus
    ? (selectedRun.expectedBranches ? `${selectedRun.expectedBranches} parent-planned approaches` : `parent choosing up to ${selectedRun.branchLimit ?? 5} approaches`)
    : `${selectedRun.branches.length} nodes across ${treeDepth(selectedRun)} levels`;
  promptNode.append(element("small", "", approachCount));
  promptNode.addEventListener("click", () => {
    selectedBranch = null;
    renderBranchCanvas();
    renderRunSummary();
  });
  graph.append(promptNode);

  if (selectedRun.runKind === "replay") {
    const branches = element("div", "branch-forest");
    const agentNode = element("button", `branch-node ${selectedRun.workflowStatus === "succeeded" ? "winner" : "live-branch"}`);
    agentNode.type = "button";
    const heading = element("span", "branch-heading");
    heading.append(element("span", "branch-id", selectedRun.agentId), element("span", `branch-state ${selectedRun.workflowStatus}`, selectedRun.workflowStatus));
    const stepCount = selectedRun.replayResult?.steps?.length ?? 0;
    agentNode.append(heading, element("span", "branch-angle", "Completed agent warm replay — no Sailboxes or branch search."));
    const metrics = element("span", "branch-metrics");
    metrics.append(element("span", "", `${stepCount} steps`), element("span", "", selectedRun.source));
    agentNode.append(metrics);
    agentNode.addEventListener("click", renderRunSummary);
    branches.append(agentNode);
    graph.append(branches);
    branchCanvas.append(graph);
    return;
  }

  const branches = element("div", "branch-forest");
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
    } else {
      const liveRun = { ...selectedRun, branches: liveTreeNodes(selectedRun) };
      branches.replaceChildren(...branchForest(liveRun, null));
    }
  }
  if (selectedRun.branches.length) {
    branches.replaceChildren(...branchForest(selectedRun, null));
  }
  graph.append(branches);
  branchCanvas.append(graph);
}

function branchForest(run, parentId) {
  return run.branches
    .filter((branch) => (branch.parent_branch_id ?? null) === parentId)
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.branch_id.localeCompare(b.branch_id, undefined, { numeric: true }))
    .map((branch) => {
      const item = element("div", "branch-tree-item");
      item.append(branchButton(branch, run));
      const children = branchForest(run, branch.branch_id);
      if (children.length) {
        const forest = element("div", "branch-forest");
        forest.append(...children);
        item.append(forest);
      }
      return item;
    });
}

function branchButton(branch, run) {
    if (branch.live) return liveBranchButton(branch);
    const status = branchStatus(branch, run);
    const button = element("button", `branch-node ${status}`);
    button.type = "button";
    button.classList.toggle("selected", selectedBranch?.branch_id === branch.branch_id);
    button.dataset.branchId = branch.branch_id;
    button.setAttribute("aria-label", `Inspect ${branch.branch_id} trace`);
    const heading = element("span", "branch-heading");
    heading.append(element("span", "branch-id", branch.branch_id));
    heading.append(element("span", `branch-state ${status}`, `${status} · d${branch.depth ?? 0}`));
    button.append(heading);
    button.append(element("span", "branch-angle", compact(branch.angle, 96)));
    const metrics = element("span", "branch-metrics");
    metrics.append(element("span", "", `${branch.steps.length} steps`));
    metrics.append(element("span", "", elapsed(branch.wall_ms)));
    if (Number.isFinite(branch.metrics?.estimated_cost_usd)) {
      metrics.append(element("span", "", `${usd(branch.metrics.estimated_cost_usd)} model`));
    }
    metrics.append(element("span", "", `${branch.steps.filter((step) => step.outcome === "error").length} errors`));
    button.append(metrics);
    button.addEventListener("click", () => selectBranch(branch));
    return button;
}

function liveTreeNodes(run) {
  const nodes = (run.plannedApproaches ?? []).map((angle, index) => ({
    branch_id: `b${index}`,
    parent_branch_id: null,
    depth: 0,
    angle,
    live: true,
    liveState: "running",
  }));
  let nextId = nodes.length;
  for (const round of run.treeRounds ?? []) {
    nodes.filter((node) => node.depth === round.depth).forEach((node) => {
      node.liveState = node.branch_id === round.winner ? "promising" : "stopped";
    });
    for (const angle of round.next_approaches ?? []) {
      nodes.push({
        branch_id: `b${nextId++}`,
        parent_branch_id: round.winner,
        depth: round.depth + 1,
        angle,
        live: true,
        liveState: "running",
      });
    }
    if (round.complete) {
      const winner = nodes.find((node) => node.branch_id === round.winner);
      if (winner) winner.liveState = "winner";
    }
  }
  return nodes;
}

function liveBranchButton(branch) {
  const node = element("div", `branch-node live-branch ${branch.liveState}`);
  const heading = element("span", "branch-heading");
  heading.append(element("span", "branch-id", branch.branch_id));
  heading.append(element("span", `branch-state ${branch.liveState}`, `${branch.liveState} · d${branch.depth}`));
  node.append(heading, element("span", "branch-angle", compact(branch.angle, 96)));
  if (branch.liveState === "running") {
    const progress = element("span", "live-progress");
    progress.append(element("i"), element("i"), element("i"));
    node.append(progress);
  } else {
    node.append(element("span", "live-progress", branch.liveState === "promising" ? "checkpoint selected" : "round complete"));
  }
  return node;
}

function treeDepth(run) {
  if (!run.branches.length) return 0;
  return Math.max(...run.branches.map((branch) => branch.depth ?? 0)) + 1;
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
  if (selectedRun.runKind === "replay") {
    const warm = element("section", "learned-run-summary");
    warm.append(element("strong", "", `Reused ${selectedRun.agentId}`));
    warm.append(element("p", "", `This ${selectedRun.source} prompt matched a completed agent. Branch launched zero Sailboxes and ran the saved runbook directly in safe stub mode.`));
    inspector.append(warm);
    const steps = element("section", "inspector-section");
    steps.append(element("h3", "", "Saved runbook execution"));
    for (const step of selectedRun.replayResult?.steps ?? []) {
      steps.append(detailRow(step.action, `${step.status}${step.error ? ` · ${step.error}` : ""}\n${JSON.stringify(step.output ?? step.arguments ?? {}, null, 2)}`, true));
    }
    if (!(selectedRun.replayResult?.steps?.length)) {
      steps.append(detailRow("Status", selectedRun.workflowPhase ?? selectedRun.workflowStatus));
    }
    inspector.append(steps);
    return;
  }
  if (selectedRun.workflowStatus) {
    const live = element("section", "live-run-summary");
    live.append(element("strong", "", selectedRun.workflowPhase ?? "Parent workflow in progress"));
    live.append(element("p", "", selectedRun.expectedBranches
      ? `The parent chose ${selectedRun.expectedBranches} distinct first-round approaches. It can checkpoint the best complete environment and fork improved continuations for up to ${selectedRun.maxDepth ?? 3} levels before distilling the full winning path.`
      : `The parent is deciding how many distinct approaches this task needs, up to ${selectedRun.branchLimit ?? 5} children per level and ${selectedRun.maxDepth ?? 3} levels.`));
    inspector.append(live);
    return;
  }
  if (selectedRun.learning?.runbook_id) {
    const learned = element("section", "learned-run-summary");
    learned.append(element("strong", "", `Parent learned ${selectedRun.learning.runbook_name ?? selectedRun.learning.runbook_id}`));
    learned.append(element("p", "", `${selectedRun.learning.reason} The validated runbook was saved as ${selectedRun.learning.runbook_id} in ${selectedRun.learning.store_path}.`));
    inspector.append(learned);
    const guidance = selectedRun.learning.guidance;
    if (guidance?.do?.length || guidance?.avoid?.length) {
      const guide = element("section", "inspector-section runbook-guidance");
      guide.append(element("h3", "", "Learned runbook guidance"));
      if (guidance.do?.length) guide.append(detailRow("Do", guidance.do.map((item) => `• ${item}`).join("\n"), true));
      if (guidance.avoid?.length) guide.append(detailRow("Avoid", guidance.avoid.map((item) => `• ${item}`).join("\n"), true));
      inspector.append(guide);
    }
  }
  if (selectedRun.tree?.rounds?.length) {
    const decisions = element("section", "inspector-section");
    decisions.append(element("h3", "", "Parent decisions"));
    for (const round of selectedRun.tree.rounds) {
      decisions.append(detailRow(
        `Depth ${round.depth} · ${round.winner}`,
        `${round.complete ? "Complete" : "Checkpointed for refinement"}: ${round.reason}`
      ));
    }
    inspector.append(decisions);
  }
  const grid = element("div", "run-metric-grid");
  const totalSteps = selectedRun.branches.reduce((sum, branch) => sum + branch.steps.length, 0);
  const successes = selectedRun.branches.filter((branch) => branch.success_signal).length;
  const runMetrics = selectedRun.metrics;
  const totalTokens = runMetrics
    ? (runMetrics.branch_inference?.input_tokens ?? 0) + (runMetrics.branch_inference?.output_tokens ?? 0)
      + (runMetrics.parent_inference?.input_tokens ?? 0) + (runMetrics.parent_inference?.output_tokens ?? 0)
    : null;
  const displayCost = runMetrics?.total_cost_usd ?? runMetrics?.known_cost_usd;
  const cards = [["Tree nodes", selectedRun.branches.length], ["Tree depth", treeDepth(selectedRun)], ["Total steps", totalSteps], ["Success signals", `${successes}/${selectedRun.branches.length}`], ["Winner", selectedRun.winner ?? "—"]];
  if (runMetrics) cards.push([runMetrics.total_cost_usd == null ? "Known spend" : "Total spend", usd(displayCost)], ["Model tokens", tokens(totalTokens)]);
  for (const [label, value] of cards) {
    const card = element("div", "run-metric");
    card.append(element("span", "", label), element("strong", "", String(value)));
    grid.append(card);
  }
  inspector.append(grid);
  if (runMetrics) {
    const economics = element("section", "inspector-section economics-summary");
    economics.append(element("h3", "", "Money spent"));
    economics.append(detailRow("Branch inference", usd(runMetrics.branch_inference?.estimated_cost_usd)));
    economics.append(detailRow("Parent planning + judging", usd(runMetrics.parent_inference?.estimated_cost_usd)));
    economics.append(detailRow("Sailbox infrastructure", usd(runMetrics.sailboxes?.total_cost_usd)));
    economics.append(detailRow(
      runMetrics.total_cost_usd == null ? "Known subtotal" : "Run total",
      `${usd(displayCost)} · ${runMetrics.cost_status}`
    ));
    economics.append(element("p", "cost-note", runMetrics.total_cost_usd == null
      ? "This is partial because at least one billing component was unavailable."
      : "Token charges use Sail’s published price card; Sailbox spend comes from the usage API. Active usage may still be estimated."));
    inspector.append(economics);
  }
  const section = element("section", "inspector-section");
  section.append(element("h3", "", "Branch approaches"));
  selectedRun.branches.forEach((branch) => {
    const row = element("button", "approach-row");
    row.type = "button";
    row.append(element("b", "", `${branch.branch_id} · d${branch.depth ?? 0}`), element("p", "", branch.angle));
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
  stats.append(element("span", "", `depth ${branch.depth ?? 0}`));
  if (branch.parent_branch_id) stats.append(element("span", "", `from ${branch.parent_branch_id}`));
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
  const parentDecision = selectedRun.tree?.rounds?.find((round) => round.winner === branch.branch_id);
  if (parentDecision) {
    inspector.append(auditSection(
      "Parent decision",
      `${parentDecision.complete ? "Selected as the complete path" : "Selected for checkpoint refinement"}. ${parentDecision.reason}`,
      "safe"
    ));
  }
  const modelMetrics = branch.metrics;
  const money = modelMetrics
    ? `${usd(modelMetrics.estimated_cost_usd)} estimated model cost · ${tokens(modelMetrics.input_tokens)} input + ${tokens(modelMetrics.output_tokens)} output tokens across ${modelMetrics.model_calls} calls. Sailbox infrastructure is reported at the run level.`
    : "This older trajectory predates structured spend metrics.";
  inspector.append(auditSection("Money spent", money, modelMetrics?.estimated_cost_usd != null ? "safe" : "warning"));
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
    const replaying = activeRunTask === "replay" || run.task === "replay";
    const output = replaying ? agentOutput : runOutput;
    if (replaying) agentRunLabel.textContent = run.label;
    else runLabel.textContent = run.label;
    output.textContent = run.output;
    output.scrollTop = output.scrollHeight;
    upsertWorkflowHistory(run);
    if (replaying) renderAgentActiveRun(run);
    if (run.status === "running" || run.status === "stopping") {
      setConsoleState(run.status, run.status === "stopping" ? "Stopping safely" : "Running");
      pollTimer = window.setTimeout(pollRun, 700);
    } else {
      setConsoleState(run.status, run.status === "succeeded" ? "Completed" : run.status);
      activeRunId = null;
      activeRunTask = null;
      pollTimer = null;
      await loadHistory({ preferPrompt: replaying ? run.request : lastFanoutPrompt });
      lastFanoutPrompt = null;
    }
  } catch (error) {
    const output = activeRunTask === "replay" ? agentOutput : runOutput;
    output.textContent += `\n[console] ${error.message}\n`;
    setConsoleState("failed", "Connection error");
    activeRunId = null;
  }
}

async function startTask(task, { inputSource = "typed" } = {}) {
  showOutput();
  setConsoleState("running", "Starting");
  runOutput.textContent = "Starting…";
  try {
    const body = { task };
    if (task === "fanout") {
      body.request = document.querySelector("#fanout-request").value.trim();
      body.inputSource = inputSource;
      body.maxBranches = Number(document.querySelector("#max-branches").value);
      body.maxDepth = Number(document.querySelector("#max-depth").value);
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
    if (run.kind === "agent_match") {
      if (!completedAgents.some((agent) => agent.id === run.agent.id)) completedAgents.push(run.agent);
      selectAgent(completedAgents.find((agent) => agent.id === run.agent.id) ?? run.agent, {
        matchMessage: run.message,
        prefilledSlots: run.slots ?? {},
        request: run.request,
      });
      switchWorkspace("agents");
      const missing = run.missingSlots ?? [];
      agentOutput.textContent = missing.length
        ? `[warm path] ${run.message}\nFill the missing inputs (${missing.join(", ")}), then choose Use completed agent.`
        : `[warm path] ${run.message}\nAll inputs were recovered from the ${run.inputSource} prompt.`;
      setConsoleState("succeeded", missing.length ? "Agent needs inputs" : "Saved agent matched");
      lastFanoutPrompt = null;
      if (!missing.length) await runMatchedAgent(run.inputSource);
      return;
    }
    activeRunId = run.id;
    activeRunTask = task;
    runLabel.textContent = run.label;
    runOutput.textContent = run.output;
    upsertWorkflowHistory(run, { select: task === "fanout" });
    await pollRun();
  } catch (error) {
    runOutput.textContent = `[console] ${error.message}`;
    setConsoleState("failed", "Could not start");
    activeRunId = null;
    activeRunTask = null;
  }
}

function resetMicrophoneUi(label = voiceConfigured ? "READY" : "SET UP") {
  microphoneButton.classList.remove("recording", "transcribing");
  microphoneButton.querySelector("strong").textContent = "Speak";
  microphoneButton.setAttribute("aria-label", "Start microphone recording");
  microphoneButton.disabled = !voiceSupported || Boolean(activeRunId);
  voiceState.textContent = label;
}

function releaseMicrophone() {
  window.clearTimeout(microphoneTimer);
  microphoneTimer = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
}

async function loadVoiceStatus() {
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  voiceSupported = supported;
  if (!supported) {
    voiceConfigured = false;
    resetMicrophoneUi("UNSUPPORTED");
    microphoneButton.title = "This browser does not support microphone recording.";
    return;
  }
  try {
    const response = await fetch("/api/voice/status");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not check voice status");
    voiceConfigured = payload.configured === true;
    resetMicrophoneUi();
    microphoneButton.title = voiceConfigured
      ? `Transcribes locally through the Branch server using ${payload.model}`
      : "Click to connect an OpenAI transcription key to this local server process.";
  } catch (error) {
    voiceConfigured = false;
    resetMicrophoneUi("VOICE OFFLINE");
    microphoneButton.title = error.message;
  }
}

async function configureVoice() {
  const apiKey = window.prompt(
    "Paste an OpenAI API key for microphone transcription. It stays in this local Branch server process and is never written to the repository."
  )?.trim();
  if (!apiKey) return false;
  const response = await fetch("/api/voice/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Error handling below supplies a stable fallback. */ }
  if (!response.ok) throw new Error(payload.error ?? "Could not configure voice transcription");
  voiceConfigured = true;
  resetMicrophoneUi("READY");
  return true;
}

async function submitRecording() {
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const recording = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];
  releaseMicrophone();
  microphoneButton.classList.remove("recording");
  microphoneButton.classList.add("transcribing");
  microphoneButton.querySelector("strong").textContent = "Listen";
  microphoneButton.disabled = true;
  voiceState.textContent = "TRANSCRIBING";
  try {
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: recording,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not transcribe recording");
    document.querySelector("#fanout-request").value = payload.transcript;
    voiceState.textContent = "ROUTING";
    await startTask("fanout", { inputSource: "voice" });
  } catch (error) {
    runOutput.textContent = `[voice] ${error.message}`;
    showOutput();
    setConsoleState("failed", "Voice failed");
  } finally {
    mediaRecorder = null;
    resetMicrophoneUi();
  }
}

async function toggleMicrophone() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  if (activeRunId) return;
  try {
    if (!voiceConfigured && !(await configureVoice())) return;
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "";
    mediaRecorder = preferredType
      ? new MediaRecorder(microphoneStream, { mimeType: preferredType })
      : new MediaRecorder(microphoneStream);
    audioChunks = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) audioChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", submitRecording, { once: true });
    mediaRecorder.start();
    microphoneButton.classList.add("recording");
    microphoneButton.querySelector("strong").textContent = "Stop";
    microphoneButton.setAttribute("aria-label", "Stop microphone recording and run prompt");
    voiceState.textContent = "RECORDING";
    microphoneTimer = window.setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, 15_000);
  } catch (error) {
    releaseMicrophone();
    runOutput.textContent = `[voice] ${error.message}`;
    showOutput();
    setConsoleState("failed", "Microphone blocked");
    resetMicrophoneUi("TRY AGAIN");
  }
}

document.querySelectorAll("[data-task]").forEach((button) => {
  button.addEventListener("click", () => startTask(button.dataset.task, { inputSource: "typed" }));
});
microphoneButton.addEventListener("click", toggleMicrophone);
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
agentStopButton.addEventListener("click", async () => {
  if (!activeRunId) return;
  agentStopButton.disabled = true;
  await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
  window.clearTimeout(pollTimer);
  await pollRun();
});

loadHistory().catch((error) => {
  branchCanvas.replaceChildren(element("div", "canvas-empty error", error.message));
});
loadVoiceStatus();

const runSidebar = document.querySelector("#run-sidebar");
const agentsSidebar = document.querySelector("#agents-sidebar");
const authSidebar = document.querySelector("#auth-sidebar");
const runsWorkspace = document.querySelector("#runs-workspace");
const agentsWorkspace = document.querySelector("#agents-workspace");
const authWorkspace = document.querySelector("#auth-workspace");
const authAccounts = document.querySelector("#auth-accounts");
const authGrants = document.querySelector("#auth-grants");
const authAudit = document.querySelector("#auth-audit");
const authMessage = document.querySelector("#auth-message");
let authentication = { providers: [], accounts: [], grants: [], audit: [] };

function switchWorkspace(name) {
  const auth = name === "auth";
  const agents = name === "agents";
  const runs = !auth && !agents;
  runSidebar.classList.toggle("hidden", !runs);
  runsWorkspace.classList.toggle("hidden", !runs);
  inspector.classList.toggle("hidden", !runs);
  agentsSidebar.classList.toggle("hidden", !agents);
  agentsWorkspace.classList.toggle("hidden", !agents);
  authSidebar.classList.toggle("hidden", !auth);
  authWorkspace.classList.toggle("hidden", !auth);
  document.querySelector("#show-runs").classList.toggle("active", runs);
  document.querySelector("#show-agents").classList.toggle("active", agents);
  document.querySelector("#show-auth").classList.toggle("active", auth);
  const url = new URL(window.location.href);
  if (!runs) url.searchParams.set("workspace", name);
  else url.searchParams.delete("workspace");
  window.history.replaceState({}, "", url);
  if (auth) loadAuth();
  if (agents) loadAgents();
}

async function loadAgents() {
  const detail = document.querySelector("#agent-detail");
  try {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load completed agents");
    completedAgents = payload.agents ?? [];
    document.querySelector("#agent-count").textContent = String(completedAgents.length);
    renderAgentList();
    const current = completedAgents.find((agent) => agent.id === selectedAgent?.id);
    if (current || (!selectedAgent && completedAgents[0])) selectAgent(current ?? completedAgents[0]);
    if (!completedAgents.length) {
      detail.replaceChildren(element("div", "agent-empty", "No completed runbooks yet. Finish a successful branch search to create the first reusable agent."));
    }
  } catch (error) {
    detail.replaceChildren(element("div", "agent-empty error", error.message));
  }
}

function renderAgentList() {
  const list = document.querySelector("#agent-list");
  const query = document.querySelector("#agent-search").value.trim().toLowerCase();
  const visible = completedAgents.filter((agent) =>
    `${agent.name} ${agent.description ?? ""} ${agent.id}`.toLowerCase().includes(query)
  );
  list.replaceChildren();
  if (!visible.length) {
    list.append(element("p", "run-list-empty", query ? "No matching completed agents." : "No completed agents yet."));
    return;
  }
  for (const agent of visible) {
    const button = element("button", "run-list-item agent-list-item");
    button.type = "button";
    button.classList.toggle("selected", selectedAgent?.id === agent.id);
    const top = element("span", "run-list-top");
    top.append(element("span", "run-source", agent.source), element("span", "run-status learned", "ready"));
    const meta = element("span", "run-list-meta");
    meta.append(element("span", "", `${agent.step_count} steps`), element("span", "", `v${agent.version}`));
    button.append(top, element("strong", "", agent.name), meta);
    button.addEventListener("click", () => selectAgent(agent, { matchMessage: "", prefilledSlots: {}, request: "" }));
    list.append(button);
  }
}

function selectAgent(agent, { matchMessage = null, prefilledSlots = null, request = null } = {}) {
  selectedAgent = agent;
  if (prefilledSlots !== null) selectedAgentPrefill = { ...prefilledSlots };
  if (request !== null) selectedAgentRequest = request;
  renderAgentList();
  if (matchMessage !== null) document.querySelector("#agent-match-message").textContent = matchMessage;
  renderAgentDetail();
}

function agentInput(slot) {
  const label = element("label", "agent-slot");
  label.dataset.slot = slot.name;
  label.dataset.type = slot.type;
  const title = element("span", "", slot.name.replaceAll("_", " "));
  title.append(element("small", "", slot.required ? "required" : "optional"));
  let input;
  const hasPrefill = Object.hasOwn(selectedAgentPrefill, slot.name);
  const initialValue = hasPrefill ? selectedAgentPrefill[slot.name] : slot.default;
  if (slot.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = initialValue === true;
  } else if (slot.type === "object" || slot.type === "array") {
    input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = slot.type === "array" ? "[]" : "{}";
    if (initialValue !== undefined) input.value = JSON.stringify(initialValue, null, 2);
  } else {
    input = document.createElement("input");
    input.type = slot.type === "integer" || slot.type === "number" ? "number" : "text";
    if (slot.type === "number") input.step = "any";
    input.placeholder = slot.prompt ?? slot.description ?? slot.name;
    if (initialValue !== undefined) input.value = String(initialValue);
  }
  input.name = slot.name;
  input.required = slot.required && slot.type !== "boolean";
  label.append(title, input);
  return label;
}

function renderAgentDetail() {
  const detail = document.querySelector("#agent-detail");
  detail.replaceChildren();
  if (!selectedAgent) return;
  const runbook = selectedAgent.runbook;
  const overview = element("article", "agent-runbook-card");
  const header = element("header", "agent-card-heading");
  const title = element("div", "");
  title.append(element("span", "section-kicker", "COMPLETED AGENT"), element("h2", "", selectedAgent.name));
  header.append(title, element("span", "agent-ready-chip", "READY TO REUSE"));
  overview.append(header, element("p", "agent-description", selectedAgent.description ?? "Validated reusable runbook."));
  const facts = element("div", "agent-facts");
  for (const [label, value] of [["Agent ID", selectedAgent.id], ["Source", selectedAgent.source], ["Origin", selectedAgent.origin], ["Completed", new Date(selectedAgent.completed_at).toLocaleString()]]) {
    const fact = element("div", "");
    fact.append(element("span", "", label), element("strong", "", value));
    facts.append(fact);
  }
  overview.append(facts);

  const steps = element("section", "agent-runbook-section");
  steps.append(element("h3", "", "Completed runbook"));
  runbook.steps.forEach((step, index) => {
    const row = element("article", "agent-step");
    row.append(element("span", "agent-step-index", String(index + 1).padStart(2, "0")));
    const copy = element("div", "");
    copy.append(element("strong", "", step.action), element("p", "", step.description ?? step.id));
    row.append(copy, element("span", step.irreversible ? "agent-step-risk" : "agent-step-safe", step.irreversible ? "confirm" : "safe"));
    steps.append(row);
  });
  overview.append(steps);
  const guidance = runbook.guidance;
  if (guidance?.do?.length || guidance?.avoid?.length) {
    const guide = element("section", "agent-guidance");
    guide.append(element("h3", "", "Learned guidance"));
    const columns = element("div", "agent-guidance-grid");
    for (const [label, items, className] of [["Do", guidance?.do ?? [], "do"], ["Avoid", guidance?.avoid ?? [], "avoid"]]) {
      const column = element("div", className);
      column.append(element("strong", "", label));
      items.forEach((item) => column.append(element("p", "", `• ${item}`)));
      columns.append(column);
    }
    guide.append(columns);
    overview.append(guide);
  }

  const use = element("form", "agent-use-card");
  use.id = "agent-use-form";
  use.append(element("span", "section-kicker", "USE WITHOUT RE-BRANCHING"), element("h2", "", "Run saved agent"));
  use.append(element("p", "agent-description", "These values go directly through the validated runbook. The console uses safe stub execution; irreversible steps still require explicit confirmation."));
  const slots = element("div", "agent-slots");
  runbook.slots.forEach((slot) => slots.append(agentInput(slot)));
  if (!runbook.slots.length) slots.append(element("p", "agent-no-slots", "This agent has no runtime inputs."));
  use.append(slots);
  if (selectedAgent.has_irreversible_steps) {
    const confirm = element("label", "agent-confirm");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "agent-confirm";
    confirm.append(checkbox, element("span", "", "Confirm the runbook’s irreversible step in safe stub mode"));
    use.append(confirm);
  }
  const button = element("button", "agent-use-button", "Use completed agent →");
  button.type = "submit";
  button.dataset.busyControl = "true";
  use.append(button);
  use.addEventListener("submit", startAgentReplay);
  const raw = element("details", "agent-raw");
  raw.append(element("summary", "", "Runbook JSON"), element("pre", "", JSON.stringify(runbook, null, 2)));
  use.append(raw);
  detail.append(overview, use);
}

function readAgentSlots(form) {
  const values = {};
  for (const label of form.querySelectorAll(".agent-slot")) {
    const input = label.querySelector("input, textarea");
    const type = label.dataset.type;
    if (type === "boolean") values[label.dataset.slot] = input.checked;
    else if (!input.value.trim() && !input.required) continue;
    else if (type === "integer") values[label.dataset.slot] = Number.parseInt(input.value, 10);
    else if (type === "number") values[label.dataset.slot] = Number(input.value);
    else if (type === "object" || type === "array") values[label.dataset.slot] = JSON.parse(input.value);
    else values[label.dataset.slot] = input.value.trim();
  }
  return values;
}

function confirmationPrompt(agent, values) {
  const template = agent.runbook.steps.find((step) => step.irreversible)?.confirmation_prompt
    ?? `Run the irreversible step in ${agent.name}?`;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => String(values[name] ?? name));
}

async function runMatchedAgent(inputSource) {
  if (!selectedAgent) return;
  const form = document.querySelector("#agent-use-form");
  const values = readAgentSlots(form);
  let confirmed = false;
  if (selectedAgent.has_irreversible_steps) {
    confirmed = window.confirm(
      `${confirmationPrompt(selectedAgent, values)}\n\nBranch will run the saved agent in safe stub mode; no provider is contacted.`
    );
    if (!confirmed) {
      agentOutput.textContent += "\n[warm path] Confirmation declined. The matched agent is ready when you are.";
      setConsoleState("succeeded", "Waiting for confirmation");
      return;
    }
    const checkbox = document.querySelector("#agent-confirm");
    if (checkbox) checkbox.checked = true;
  }
  await startAgentReplay(null, { confirmedOverride: confirmed, inputSource });
}

async function startAgentReplay(event, { confirmedOverride = null, inputSource = "typed" } = {}) {
  event?.preventDefault();
  if (!selectedAgent) return;
  setConsoleState("running", "Reusing agent");
  agentOutput.textContent = "Starting saved runbook…";
  renderAgentActiveRun({
    id: null,
    task: "replay",
    status: "running",
    request: selectedAgentRequest || selectedAgent.name,
    agentId: selectedAgent.id,
    inputSource,
    parentPhase: "starting saved runbook",
  });
  try {
    const form = event?.currentTarget ?? document.querySelector("#agent-use-form");
    const body = {
      task: "replay",
      agentId: selectedAgent.id,
      slots: readAgentSlots(form),
      confirmed: confirmedOverride ?? document.querySelector("#agent-confirm")?.checked === true,
      request: selectedAgentRequest || selectedAgent.name,
      inputSource,
    };
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error ?? "Could not reuse completed agent");
    activeRunId = run.id;
    activeRunTask = "replay";
    agentRunLabel.textContent = run.label;
    agentOutput.textContent = run.output;
    upsertWorkflowHistory(run);
    renderAgentActiveRun(run);
    await pollRun();
  } catch (error) {
    agentOutput.textContent = `[warm path] ${error.message}`;
    setConsoleState("failed", "Replay failed");
    renderAgentActiveRun({
      id: null,
      task: "replay",
      status: "failed",
      request: selectedAgentRequest || selectedAgent.name,
      agentId: selectedAgent.id,
      inputSource,
      parentPhase: error.message,
    });
    activeRunId = null;
    activeRunTask = null;
  }
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
document.querySelector("#new-agent-button").addEventListener("click", () => {
  switchWorkspace("runs");
  const composer = document.querySelector("#fanout-request");
  composer.focus();
  composer.select();
});
document.querySelector("#refresh-auth").addEventListener("click", loadAuth);
document.querySelector("#refresh-agents").addEventListener("click", loadAgents);
document.querySelector("#agent-search").addEventListener("input", renderAgentList);
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
if (initialParams.get("workspace") === "agents") switchWorkspace("agents");
if (initialParams.get("auth_error")) setAuthMessage(initialParams.get("auth_error"), "error");
if (initialParams.get("connected")) setAuthMessage("Account connected successfully.", "success");
