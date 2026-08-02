import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createVaultAuthService } from "../src/auth/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.VERSION_HISTORY_PORT ?? 4173);
const runs = new Map();
const historyRegistry = new Map();
let authServicePromise = null;
const MAX_OUTPUT = 80_000;
const DEFAULT_BRANCH_LIMIT = 5;
const MIN_BRANCHES = 2;
const MAX_BRANCH_LIMIT = 8;
const DEFAULT_TREE_DEPTH = 3;
const MIN_TREE_DEPTH = 1;
const MAX_TREE_DEPTH = 4;
const AGENT_MARKER = "AGENTS_JSON ";
const AGENT_MATCH_MARKER = "AGENT_MATCH ";
const MAX_AUDIO_BYTES = 12_000_000;
let voiceApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const DEFAULT_REQUEST =
  "Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven.";
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

function resolveRequest(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const relative = pathname === "/" ? "ui/version-history/index.html" : pathname.slice(1);
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) throw new Error("request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

async function readBytes(request, limit = MAX_AUDIO_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("audio recording is too large");
    chunks.push(chunk);
  }
  if (!size) throw new Error("audio recording is empty");
  return Buffer.concat(chunks);
}

async function transcribeAudio(request) {
  const apiKey = voiceApiKey;
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured on the Branch server");
    error.statusCode = 503;
    throw error;
  }
  const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim();
  if (!contentType.startsWith("audio/")) throw new Error("recording must use an audio content type");
  const extension = new Map([
    ["audio/webm", "webm"], ["audio/ogg", "ogg"], ["audio/mp4", "m4a"],
    ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["audio/mpeg", "mp3"],
  ]).get(contentType) ?? "webm";
  const bytes = await readBytes(request);
  const form = new FormData();
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe");
  form.set("file", new Blob([bytes], { type: contentType }), `branch-recording.${extension}`);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`transcription failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    error.statusCode = 502;
    throw error;
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("transcription returned invalid JSON"); }
  const transcript = String(payload?.text ?? "").trim();
  if (!transcript) throw new Error("transcription returned no speech");
  return transcript;
}

function requestSource(value) {
  return value === "voice" ? "voice" : "typed";
}

function completedAgents(args, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-m", "runbook_voice.completed_agents", ...args], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `completed-agent catalog exited ${code}`));
        return;
      }
      const line = stdout.split("\n").find((entry) => entry.startsWith(marker));
      if (!line) {
        reject(new Error("completed-agent catalog returned no structured result"));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(marker.length)));
      } catch {
        reject(new Error("completed-agent catalog returned invalid JSON"));
      }
    });
  });
}

function authService() {
  authServicePromise ??= createVaultAuthService().catch((error) => {
    authServicePromise = null;
    throw error;
  });
  return authServicePromise;
}

async function readTrajectoryDirectory(directory, source) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const trajectoryFiles = entries
    .filter((entry) => entry.isFile() && /^b\d+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!trajectoryFiles.length) return null;

  const branches = [];
  for (const filename of trajectoryFiles) {
    try {
      const trajectory = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
      if (!trajectory.branch_id || !trajectory.task || !Array.isArray(trajectory.steps)) continue;
      branches.push(trajectory);
    } catch {
      // A partially-written file must not make the history API unusable.
    }
  }
  if (!branches.length) return null;

  let winner = null;
  let learning = null;
  let metrics = null;
  let tree = null;
  try {
    const payload = JSON.parse(await readFile(path.join(directory, "learning.json"), "utf8"));
    if (payload && typeof payload === "object" && typeof payload.winner === "string") {
      learning = payload;
      winner = payload.winner;
    }
  } catch {
    // Older and interrupted runs may not have reached the learning stage.
  }
  try {
    const payload = JSON.parse(await readFile(path.join(directory, "metrics.json"), "utf8"));
    if (payload && typeof payload === "object") metrics = payload;
  } catch {
    // Metrics were introduced after the first recorded trajectories.
  }
  try {
    const payload = JSON.parse(await readFile(path.join(directory, "tree.json"), "utf8"));
    if (payload && typeof payload === "object" && Array.isArray(payload.rounds)) tree = payload;
  } catch {
    // Flat and interrupted runs do not have a tree manifest.
  }
  try {
    const payload = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
    if (payload?.input_source === "voice" || payload?.input_source === "typed") {
      source = payload.input_source;
    }
  } catch {
    // Older runs predate typed/voice provenance.
  }
  try {
    const judgeLog = await readFile(path.join(directory, "judge.log"), "utf8");
    winner ??= judgeLog.match(/tally:\s*(b\d+)\s+x\d+/)?.[1] ?? null;
  } catch {
    // A run may not have been judged yet.
  }
  const relative = path.relative(root, directory);
  const info = await stat(directory);
  const id = Buffer.from(relative).toString("base64url");
  const record = {
    id,
    task: branches[0].task,
    source,
    path: relative,
    createdAt: info.mtime.toISOString(),
    winner,
    learning,
    metrics,
    tree,
    branches,
    directory,
  };
  historyRegistry.set(id, record);
  return record;
}

async function findTrajectoryRuns(directory, source, depth = 0) {
  if (depth > 4) return [];
  const found = [];
  const own = await readTrajectoryDirectory(directory, source);
  if (own) found.push(own);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "generated") continue;
    found.push(...(await findTrajectoryRuns(path.join(directory, entry.name), source, depth + 1)));
  }
  return found;
}

async function listReplayRuns() {
  const directory = path.join(root, "runs", "replays");
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]+\.json$/.test(entry.name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
      if (record?.runKind === "replay" && record.request && record.agentId) records.push(record);
    } catch {
      // A partially written replay must not make the history API unusable.
    }
  }
  return records;
}

function runtimeHistory(run) {
  if (run.task === "replay") {
    return {
      id: `workflow:${run.id}`,
      workflowId: run.id,
      task: run.request,
      source: run.inputSource,
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
    source: run.inputSource,
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
    treeRounds: run.treeRounds,
    metrics: run.metrics,
  };
}

async function listHistory() {
  historyRegistry.clear();
  const savedRecords = [
    ...(await findTrajectoryRuns(path.join(root, "runs"), "live")),
    ...(await findTrajectoryRuns(path.join(root, "demo", "cold-capture"), "recorded")),
    ...(await listReplayRuns()),
  ];
  const activeRecords = [...runs.values()]
    .filter(
      (run) =>
        (run.task === "fanout" || run.task === "replay") &&
        (run.status === "running" || run.status === "stopping")
    )
    .map(runtimeHistory);
  return [...activeRecords, ...savedRecords]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ directory: _directory, ...record }) => record);
}

function selectedHistory(input) {
  const record = historyRegistry.get(String(input?.runId ?? ""));
  if (!record) throw new Error("select a saved prompt run first");
  return record;
}

function taskCommand(task, input) {
  if (task === "fanout") {
    const request = String(input?.request ?? DEFAULT_REQUEST).trim();
    const inputSource = requestSource(input?.inputSource);
    if (!request || request.length > 1_000) throw new Error("request must be 1–1,000 characters");
    const branchLimit = Number(input?.maxBranches ?? DEFAULT_BRANCH_LIMIT);
    if (!Number.isInteger(branchLimit) || branchLimit < MIN_BRANCHES || branchLimit > MAX_BRANCH_LIMIT) {
      throw new Error(`maxBranches must be an integer between ${MIN_BRANCHES} and ${MAX_BRANCH_LIMIT}`);
    }
    const maxDepth = Number(input?.maxDepth ?? DEFAULT_TREE_DEPTH);
    if (!Number.isInteger(maxDepth) || maxDepth < MIN_TREE_DEPTH || maxDepth > MAX_TREE_DEPTH) {
      throw new Error(`maxDepth must be an integer between ${MIN_TREE_DEPTH} and ${MAX_TREE_DEPTH}`);
    }
    return {
      label: "Adaptive Sail tree + learn",
      request,
      inputSource,
      branchLimit,
      maxDepth,
      command: "python",
      args: [
        "-m",
        "runbook_voice.branch_search_demo",
        request,
        "--out",
        "runs",
        "--max-branches",
        String(branchLimit),
        "--max-depth",
        String(maxDepth),
        "--input-source",
        inputSource,
        "--runbook-store",
        "demo/runbook-store.json",
      ],
    };
  }
  if (task === "replay") {
    const agentId = String(input?.agentId ?? "");
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(agentId)) {
      throw new Error("select a valid completed agent first");
    }
    const slots = input?.slots;
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
      throw new Error("agent slots must be an object");
    }
    const slotsJson = JSON.stringify(slots);
    if (slotsJson.length > 12_000) throw new Error("agent slot values are too large");
    const request = String(input?.request ?? "Use completed agent").trim().slice(0, 1_000);
    const inputSource = requestSource(input?.inputSource);
    return {
      label: `Reuse completed agent · ${agentId}`,
      agentId,
      request,
      inputSource,
      command: "python",
      args: [
        "-m",
        "runbook_voice.completed_agents",
        "run",
        "--id",
        agentId,
        "--slots-json",
        slotsJson,
        ...(input?.confirmed === true ? ["--confirm"] : []),
      ],
    };
  }
  if (task === "judge") {
    const record = selectedHistory(input);
    return {
      label: "Judge selected prompt run",
      command: "python",
      args: ["-m", "runbook_voice.judge_check", "--runs", "1", "--fixtures", record.directory],
    };
  }
  if (task === "distill") {
    const record = selectedHistory(input);
    const branchId = String(input?.branchId ?? "");
    if (!/^b\d+$/.test(branchId)) throw new Error("select a branch to distill");
    const trajectory = path.join(record.directory, `${branchId}.json`);
    if (!record.branches.some((branch) => branch.branch_id === branchId)) {
      throw new Error(`branch ${branchId} is not part of the selected run`);
    }
    const safeRun = record.id.slice(0, 20);
    return {
      label: `Distill ${branchId} into a runbook`,
      command: "python",
      args: [
        "-m",
        "runbook_voice.distiller",
        trajectory,
        "-o",
        `runs/generated/${safeRun}-${branchId}.json`,
      ],
    };
  }
  if (task === "rehearse") {
    return { label: "Run 3 safe booking rehearsals", command: "node", args: ["scripts/rehearse.mjs"] };
  }
  throw new Error(`unknown task: ${task}`);
}

function publicRun(run) {
  return {
    id: run.id,
    task: run.task,
    label: run.label,
    status: run.status,
    output: run.output,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    request: run.request,
    branchLimit: run.branchLimit,
    maxDepth: run.maxDepth,
    agentId: run.agentId,
    inputSource: run.inputSource,
    plannedBranches: run.plannedBranches,
    plan: run.plan,
    parentPhase: run.parentPhase,
    learning: run.learning,
    metrics: run.metrics,
    treeRounds: run.treeRounds,
    replayResult: run.replayResult,
  };
}

function appendOutput(run, chunk) {
  run.output = `${run.output}${String(chunk)}`.slice(-MAX_OUTPUT);
  const planMatch = run.output.match(/PARENT_PLAN\s+(\{[^\n]+\})/);
  if (planMatch) {
    try {
      const plan = JSON.parse(planMatch[1]);
      if (Number.isInteger(plan.branch_count)) {
        run.plannedBranches = plan.branch_count;
        run.plan = plan;
      }
      run.parentPhase = "running branches";
    } catch {
      // The output may be observed between chunks; the next chunk retries parsing.
    }
  }
  const learnedMatch = run.output.match(/PARENT_LEARNED\s+(\{[^\n]+\})/);
  if (learnedMatch) {
    try {
      run.learning = JSON.parse(learnedMatch[1]);
      run.parentPhase = "runbook learned";
    } catch {
      // The next output chunk retries parsing.
    }
  } else if (run.output.includes("parent judging complete trajectories")) {
    run.parentPhase = "judging and learning";
  }
  run.treeRounds = [...run.output.matchAll(/TREE_ROUND\s+(\{[^\n]+\})/g)]
    .map((match) => {
      try { return JSON.parse(match[1]); } catch { return null; }
    })
    .filter(Boolean);
  if (run.treeRounds.length && !run.learning) {
    const latest = run.treeRounds.at(-1);
    run.parentPhase = latest.complete
      ? "complete path selected"
      : `refining depth ${latest.depth + 1}`;
  }
  const metricsMatch = run.output.match(/RUN_METRICS\s+(\{[^\n]+\})/);
  if (metricsMatch) {
    try {
      run.metrics = JSON.parse(metricsMatch[1]);
      run.parentPhase = "spend measured";
    } catch {
      // The next output chunk retries parsing.
    }
  }
  const replayMatch = run.output.match(/AGENT_REPLAY\s+(\{[^\n]+\})/);
  if (replayMatch) {
    try {
      run.replayResult = JSON.parse(replayMatch[1]);
      run.parentPhase = "saved runbook complete";
    } catch {
      // The next output chunk retries parsing.
    }
  }
}

function persistReplay(run) {
  try {
    const directory = path.join(root, "runs", "replays");
    mkdirSync(directory, { recursive: true });
    const record = {
      id: `replay:${run.id}`,
      task: run.request,
      source: run.inputSource,
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
    writeFileSync(path.join(directory, `${run.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    appendOutput(run, `[console] Could not save replay history: ${error.message}\n`);
  }
}

function startRun(task, input) {
  const active = [...runs.values()].find(
    (run) => run.status === "running" || run.status === "stopping"
  );
  if (active) {
    const error = new Error(`${active.label} is already running`);
    error.statusCode = 409;
    throw error;
  }
  const spec = taskCommand(task, input);
  mkdirSync(path.join(root, "runs", "generated"), { recursive: true });
  const run = {
    id: randomUUID(),
    task,
    request: spec.request ?? null,
    branchLimit: spec.branchLimit ?? null,
    maxDepth: spec.maxDepth ?? null,
    agentId: spec.agentId ?? null,
    inputSource: spec.inputSource ?? requestSource(input?.inputSource),
    plannedBranches: null,
    plan: null,
    parentPhase: task === "fanout" ? "planning approaches" : task === "replay" ? "running saved runbook" : null,
    learning: null,
    metrics: null,
    treeRounds: [],
    replayResult: null,
    label: spec.label,
    status: "running",
    output: `[console] Starting ${spec.label}…\n`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    child: null,
  };
  const child = spawn(spec.command, spec.args, {
    cwd: root,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    shell: false,
  });
  run.child = child;
  runs.set(run.id, run);
  child.stdout.on("data", (chunk) => appendOutput(run, chunk));
  child.stderr.on("data", (chunk) => appendOutput(run, chunk));
  child.on("error", (error) => {
    appendOutput(run, `\n[console] Could not start: ${error.message}\n`);
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (run.status === "stopping") run.status = "cancelled";
    else run.status = code === 0 ? "succeeded" : "failed";
    appendOutput(
      run,
      `\n[console] ${run.status.toUpperCase()}${signal ? ` (${signal})` : ""}${code === null ? "" : ` — exit ${code}`}\n`
    );
    if (run.task === "replay") persistReplay(run);
  });
  return run;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/voice/status") {
    json(response, 200, {
      configured: Boolean(voiceApiKey),
      model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
    });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/voice/config") {
    try {
      const input = await readJson(request);
      const apiKey = String(input?.apiKey ?? "").trim();
      if (!apiKey.startsWith("sk-") || apiKey.length < 20 || apiKey.length > 512) {
        throw new Error("enter a valid OpenAI API key");
      }
      voiceApiKey = apiKey;
      json(response, 200, { configured: true });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/voice/transcribe") {
    try {
      json(response, 200, { transcript: await transcribeAudio(request) });
    } catch (error) {
      json(response, error.statusCode ?? 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/agents") {
    try {
      json(response, 200, await completedAgents(["list"], AGENT_MARKER));
    } catch (error) {
      json(response, 500, { error: error.message });
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/agents/match") {
    try {
      const input = await readJson(request);
      const utterance = String(input?.request ?? "").trim();
      if (!utterance || utterance.length > 1_000) throw new Error("request must be 1–1,000 characters");
      json(response, 200, await completedAgents(["match", utterance], AGENT_MATCH_MARKER));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/auth") {
    try {
      json(response, 200, (await authService()).snapshot());
    } catch (error) {
      json(response, 503, { error: error.message });
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/oauth/start") {
    try {
      const input = await readJson(request);
      json(response, 201, await (await authService()).beginOAuth(input));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/auth/callback") {
    try {
      const url = new URL(request.url, "http://localhost");
      await (await authService()).finishOAuthByState({
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
      });
      response.writeHead(303, { Location: "/?workspace=auth&connected=1" }).end();
    } catch (error) {
      response.writeHead(303, { Location: `/?workspace=auth&auth_error=${encodeURIComponent(error.message)}` }).end();
    }
    return true;
  }
  const deviceMatch = pathname.match(/^\/api\/auth\/oauth\/([^/]+)\/poll$/);
  if (request.method === "POST" && deviceMatch) {
    try {
      json(response, 200, await (await authService()).pollDevice(deviceMatch[1]));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/auth/grants") {
    try {
      json(response, 201, await (await authService()).grant(await readJson(request)));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  const grantMatch = pathname.match(/^\/api\/auth\/grants\/([^/]+)\/revoke$/);
  if (request.method === "POST" && grantMatch) {
    try {
      const result = await (await authService()).revokeGrant(grantMatch[1]);
      json(response, result ? 200 : 404, result ?? { error: "grant not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  const accountMatch = pathname.match(/^\/api\/auth\/accounts\/([^/]+)(?:\/(check|refresh))?$/);
  if (accountMatch) {
    try {
      const service = await authService();
      if (request.method === "DELETE" && !accountMatch[2]) {
        const result = await service.revoke(accountMatch[1]);
        json(response, result ? 200 : 404, result ?? { error: "credential not found" });
        return true;
      }
      if (request.method === "POST" && accountMatch[2] === "check") {
        json(response, 200, await service.check(accountMatch[1]));
        return true;
      }
      if (request.method === "POST" && accountMatch[2] === "refresh") {
        json(response, 200, await service.refresh(accountMatch[1], true));
        return true;
      }
    } catch (error) {
      json(response, 400, { error: error.message });
      return true;
    }
  }
  if (request.method === "POST" && pathname === "/api/auth/rotate") {
    try {
      const input = await readJson(request);
      json(response, 200, await (await authService()).rotate(input.provider));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/history") {
    try {
      json(response, 200, { runs: await listHistory() });
    } catch (error) {
      json(response, 500, { error: error.message });
    }
    return true;
  }
  if (request.method === "POST" && pathname === "/api/runs") {
    try {
      const input = await readJson(request);
      if (input.task === "fanout") {
        const utterance = String(input?.request ?? DEFAULT_REQUEST).trim();
        const inputSource = requestSource(input?.inputSource);
        if (!utterance || utterance.length > 1_000) {
          throw new Error("request must be 1–1,000 characters");
        }
        const match = await completedAgents(["match", utterance], AGENT_MATCH_MARKER);
        if (match.matched) {
          json(response, 200, {
            kind: "agent_match",
            agent: match.agent,
            slots: match.slots ?? {},
            missingSlots: match.missing_slots ?? [],
            request: utterance,
            inputSource,
            message: `Reusing ${match.agent.name}; no branch search was launched.`,
          });
          return true;
        }
      }
      const run = startRun(input.task, input);
      json(response, 202, publicRun(run));
    } catch (error) {
      json(response, error.statusCode ?? 400, { error: error.message });
    }
    return true;
  }
  const match = pathname.match(/^\/api\/runs\/([0-9a-f-]+)(\/cancel)?$/);
  if (!match) return false;
  const run = runs.get(match[1]);
  if (!run) {
    json(response, 404, { error: "run not found" });
    return true;
  }
  if (request.method === "GET" && !match[2]) {
    json(response, 200, publicRun(run));
    return true;
  }
  if (request.method === "POST" && match[2] === "/cancel") {
    if (run.status === "running") {
      run.status = "stopping";
      appendOutput(run, "\n[console] Stop requested; waiting for safe cleanup…\n");
      run.child.kill("SIGINT");
    }
    json(response, 202, publicRun(run));
    return true;
  }
  json(response, 405, { error: "method not allowed" });
  return true;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith("/api/") && (await handleApi(request, response, pathname))) return;
  const requested = resolveRequest(request.url ?? "/");
  if (!requested) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = requested;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    await stat(filePath);
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types.get(path.extname(filePath)) ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Branch: http://127.0.0.1:${port}`);
});
