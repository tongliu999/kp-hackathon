import { createReadStream, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.VERSION_HISTORY_PORT ?? 4173);
const runs = new Map();
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

function taskCommand(task, input) {
  if (task === "fanout") {
    const request = String(input?.request ?? DEFAULT_REQUEST).trim();
    if (!request || request.length > 1_000) throw new Error("request must be 1–1,000 characters");
    return {
      label: "Live 3-way Sail fan-out",
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
    return {
      label: "Live pairwise trajectory judge",
      command: "python",
      args: ["-m", "runbook_voice.judge_check", "--runs", "3", "--expect", "b0"],
    };
  }
  if (task === "validate") {
    return { label: "Validate runbooks and trajectories", command: "python", args: ["schema/validate.py"] };
  }
  if (task === "distill") {
    return {
      label: "Distill winning trajectory",
      command: "runbook-distill",
      args: [
        "fixtures/trajectories/branch-0.json",
        "-o",
        "runs/console-distilled-runbook.json",
      ],
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
  };
}

function appendOutput(run, chunk) {
  run.output = `${run.output}${String(chunk)}`.slice(-MAX_OUTPUT);
}

function startRun(task, input) {
  const active = [...runs.values()].find((run) => run.status === "running");
  if (active) {
    const error = new Error(`${active.label} is already running`);
    error.statusCode = 409;
    throw error;
  }
  const spec = taskCommand(task, input);
  mkdirSync(path.join(root, "runs"), { recursive: true });
  const run = {
    id: randomUUID(),
    task,
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
