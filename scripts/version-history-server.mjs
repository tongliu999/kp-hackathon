import { createReadStream, mkdirSync } from "node:fs";
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
  try {
    const judgeLog = await readFile(path.join(directory, "judge.log"), "utf8");
    winner = judgeLog.match(/tally:\s*(b\d+)\s+x\d+/)?.[1] ?? null;
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

async function listHistory() {
  historyRegistry.clear();
  const savedRecords = [
    ...(await findTrajectoryRuns(path.join(root, "runs"), "live")),
    ...(await findTrajectoryRuns(path.join(root, "demo", "cold-capture"), "recorded")),
  ];
  const activeRecords = [...runs.values()]
    .filter(
      (run) =>
        run.task === "fanout" &&
        (run.status === "running" || run.status === "stopping")
    )
    .map((run) => ({
      id: `workflow:${run.id}`,
      workflowId: run.id,
      task: run.request,
      source: "live",
      path: "live fan-out",
      createdAt: run.startedAt,
      winner: null,
      branches: [],
      workflowStatus: run.status,
      expectedBranches: 3,
    }));
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
    if (!request || request.length > 1_000) throw new Error("request must be 1–1,000 characters");
    return {
      label: "Live 3-way Sail fan-out",
      request,
      command: "python",
      args: [
        "-m",
        "runbook_voice.branch_search_demo",
        request,
        "--out",
        "runs",
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
  if (task === "validate") {
    return { label: "Validate runbooks and trajectories", command: "python", args: ["schema/validate.py"] };
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
  if (task === "demo-check") {
    return {
      label: "Demo preflight",
      command: "python",
      args: ["-m", "runbook_voice.demo", "check"],
    };
  }
  if (task === "rehearse") {
    return { label: "Run 3 safe booking rehearsals", command: "node", args: ["scripts/rehearse.mjs"] };
  }
  if (task === "tests") {
    return { label: "Run project test suite", command: "npm", args: ["test"] };
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
  };
}

function appendOutput(run, chunk) {
  run.output = `${run.output}${String(chunk)}`.slice(-MAX_OUTPUT);
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
  });
  return run;
}

async function handleApi(request, response, pathname) {
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
  console.log(`Agent version history: http://127.0.0.1:${port}`);
});
