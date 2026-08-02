"""The program one branch runs *inside* its own Sailbox.

This module is shipped into a box verbatim — the orchestrator reads its own
source with ``Path(__file__).read_text()`` and writes it to ``/root/branch``.
So it is deliberately **standalone**: stdlib only, and no imports from
:mod:`runbook_voice`.  A box that has never heard of this package can run it.
The same constraint is why it uses ``urllib`` against Sail's OpenAI-compatible
inference endpoint rather than an SDK: nothing to ``pip install`` in the guest.

The loop is launched detached (``setsid nohup``) because the research measured
that anything tied to an in-flight ``exec()`` session is reaped when a box is
branched.  The orchestrator therefore cannot hold the process open; it polls for
``DONE`` instead, which is written *after* ``trajectory.json`` so a poller never
reads a half-written file.

Steps are appended to ``steps.jsonl`` as they happen rather than assembled at the
end.  A branch that dies still leaves its evidence behind, and a trajectory with
steps is useful to the judge where a missing one is not.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from typing import Any, Callable, Sequence

BRANCH_DIR = "/root/branch"
JOB_FILE = "job.json"
STEPS_FILE = "steps.jsonl"
TRAJECTORY_FILE = "trajectory.json"
DONE_FILE = "DONE"

# Mirrors the cap in schema/trajectory.schema.json. Full page dumps blow out the
# judge's context for no gain.
OBSERVATION_LIMIT = 2000

DEFAULT_BASE_URL = "https://api.sailresearch.com/v1"
DEFAULT_MODEL = "zai-org/GLM-5.2-FP8"
# ~1 min/turn. Each turn feeds the next, so `standard` (~5 min/turn) would turn
# an 8-step branch into a 40-minute one.
DEFAULT_COMPLETION_WINDOW = "priority"
DEFAULT_MAX_STEPS = 12
DEFAULT_DEADLINE_SECONDS = 900.0
DEFAULT_SHELL_TIMEOUT = 60.0
DEFAULT_REQUEST_TIMEOUT = 300.0

SYSTEM_PROMPT = """\
You are one of three independent agents racing to work out how to do an unfamiliar \
task. You each have your own Linux box and your own assigned approach. Another \
system will later compare your attempts, so your job is to make YOUR approach \
work — not to hedge toward what the others might do.

Your assigned approach:
{directive}

You research and gather. You NEVER complete the task's irreversible step: no \
booking, reserving, purchasing, paying, ordering, or confirming, and no request \
that would create or change anything on someone else's system. That step happens \
once, later, after a human confirms it. Reaching a page or an endpoint where the \
irreversible action *could* be taken is a complete and successful outcome — stop \
there and report what you found.

Work in short concrete moves. Call exactly one tool per turn. When a line of \
attack turns out to be a dead end, say so in a `note` with abandoning=true and \
move on: a recorded dead end is useful evidence, a hidden one is not.

Let failing commands fail. A step's outcome is taken from its exit code, so \
`cmd || echo failed` and `cmd; echo EXIT $?` both record a failure as a success \
and corrupt the record of what you actually learned. Run the bare command.

You have a hard budget of {max_steps} tool calls and every tool result tells you \
how many are left. Spend them: `finish` as soon as you can state a concrete \
answer, and never let the budget run out without calling it — a branch that \
stops mid-investigation reports nothing, and partial findings stated plainly \
beat silence. Set success_signal honestly.\
"""

TOOLS: tuple[dict[str, Any], ...] = (
    {
        "type": "function",
        "function": {
            "name": "shell",
            "description": (
                "Run one shell command on your own Linux box and get back its "
                "combined output. Use it to fetch and inspect pages (curl), read "
                "files, and compute. Read-only work only."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command to run."},
                    "url": {
                        "type": "string",
                        "description": "The URL this command fetches, if any.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note",
            "description": (
                "Record a reasoning step: what you plan to try next, or why you "
                "are abandoning the line of attack you were on."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "thought": {"type": "string"},
                    "abandoning": {
                        "type": "boolean",
                        "description": "True if this note drops the current approach.",
                    },
                },
                "required": ["thought"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finish",
            "description": "Report your conclusion and stop.",
            "parameters": {
                "type": "object",
                "properties": {
                    "final_answer": {"type": "string"},
                    "success_signal": {
                        "type": "boolean",
                        "description": "Did you actually complete the research task?",
                    },
                },
                "required": ["final_answer", "success_signal"],
            },
        },
    },
)

# --- Invariant 1 ---------------------------------------------------------------
# Branches research; they never book. The structural guarantee is that a branch
# has no confirmation gate and no path to RunbookExecutor, so it *cannot* reach
# the repo's irreversible step. This screen is the second layer: the shell tool
# can reach the open internet, so a write-shaped request is refused before it
# runs. Refusals are recorded as `abandoned` rather than dropped — the judge
# should see that a branch tried to book and was stopped.
_WRITE_METHODS = ("post", "put", "patch", "delete")
# Path segments that commit rather than describe. Deliberately narrow: reading a
# booking page is the branch's *success* condition, not a violation, so blocking
# every URL containing "book" or "reserv" would refuse the research the branch
# exists to do. Measured on a real run - an over-broad list blocked every
# availability lookup and the branch reported it in its own final answer.
_COMMIT_PATHS = (
    "/checkout",
    "/confirm",
    "/payment",
    "/purchase",
    "/place-order",
    "confirm-reservation",
    "complete-booking",
)
_HTTP_TOOLS = ("curl", "wget", "http ", "httpie")


def screen_command(command: str) -> str | None:
    """Return why a command is refused, or ``None`` to allow it.

    The irreversible step is the *submission*, not the page that offers it, so
    this screens for write-shaped requests rather than for booking vocabulary.
    """
    lowered = command.lower()
    if not any(tool in lowered for tool in _HTTP_TOOLS):
        return None

    for method in _WRITE_METHODS:
        if f"-x {method}" in lowered or f"--request {method}" in lowered:
            return f"refused: {method.upper()} is a write request; branches are read-only"
    if any(flag in lowered for flag in ("--data", "--form", " -d ", " -F ")):
        return "refused: sending a request body would commit something; branches are read-only"
    if any(path in lowered for path in _COMMIT_PATHS):
        return (
            "refused: this endpoint commits the booking. Branches stop at the page "
            "that offers it - reaching that page is success - and a human confirms."
        )
    return None


def truncate(text: str, limit: int = OBSERVATION_LIMIT) -> str:
    """Cap an observation at the schema's limit, marking that it was cut."""
    if len(text) <= limit:
        return text
    marker = " …[truncated]"
    return text[: limit - len(marker)] + marker


class StepRecorder:
    """Append-only step log. Owns ordinals and elapsed time so callers cannot skew them."""

    def __init__(
        self,
        *,
        path: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._path = path
        self._clock = clock
        self._started = clock()
        self.steps: list[dict[str, Any]] = []

    @property
    def elapsed(self) -> float:
        return self._clock() - self._started

    def record(
        self,
        *,
        kind: str,
        action: str,
        args: dict[str, Any] | None = None,
        url: str | None = None,
        observation: str | None = None,
        outcome: str = "ok",
        note: str | None = None,
    ) -> dict[str, Any]:
        step: dict[str, Any] = {
            "i": len(self.steps),
            "t": round(self.elapsed, 3),
            "kind": kind,
            "action": action,
            "outcome": outcome,
        }
        # Optional keys are omitted rather than emitted as null: the schema sets
        # additionalProperties false and types every field it declares.
        if args:
            step["args"] = args
        if url:
            step["url"] = url
        if observation is not None:
            step["observation_excerpt"] = truncate(observation)
        if note:
            step["note"] = note

        self.steps.append(step)
        if self._path:
            with open(self._path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(step) + "\n")
        return step


def run_shell(command: str, timeout: float = DEFAULT_SHELL_TIMEOUT) -> tuple[int, str]:
    """Run one command, returning its exit code and combined output."""
    try:
        completed = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout:.0f}s"
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def http_transport(
    base_url: str, api_key: str, timeout: float = DEFAULT_REQUEST_TIMEOUT
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """POST chat completions to Sail's OpenAI-compatible endpoint."""
    url = f"{base_url.rstrip('/')}/chat/completions"

    def post(payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read())

    return post


def _tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull tool calls out of a reply, tolerating a model that inlines JSON.

    Native tool calls are the contract. The fallback exists because a model that
    answers with a bare ``{"tool": ..., "args": ...}`` object is describing the
    same intent, and losing a whole turn to a formatting slip is worse than
    parsing it.
    """
    calls = message.get("tool_calls") or []
    if calls:
        return calls

    content = (message.get("content") or "").strip()
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(content[start : end + 1])
    except json.JSONDecodeError:
        return []
    name = parsed.get("tool") or parsed.get("name")
    if not name:
        return []
    arguments = parsed.get("args") or parsed.get("arguments") or {}
    return [
        {
            "id": "inline-0",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }
    ]


def _arguments(call: dict[str, Any]) -> dict[str, Any]:
    raw = (call.get("function") or {}).get("arguments") or "{}"
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def run_branch(
    job: dict[str, Any],
    *,
    transport: Callable[[dict[str, Any]], dict[str, Any]],
    shell: Callable[[str], tuple[int, str]] = run_shell,
    recorder: StepRecorder | None = None,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
) -> dict[str, Any]:
    """Run one branch's agent loop and return its trajectory.

    Every exit path produces a trajectory with at least one step, including the
    ones where the model never cooperated — a partial trajectory is evidence and
    an absent one is a hole in the comparison.
    """
    recorder = recorder or StepRecorder()
    task = job["task"]
    max_steps = int(job.get("max_steps", DEFAULT_MAX_STEPS))

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT.format(
                directive=job["directive"], max_steps=max_steps
            ),
        },
        {"role": "user", "content": task},
    ]
    payload_base = {
        "model": job.get("model", DEFAULT_MODEL),
        "tools": list(TOOLS),
        "metadata": {
            "completion_window": job.get("completion_window", DEFAULT_COMPLETION_WINDOW)
        },
    }

    final_answer: str | None = None
    success_signal = False
    error: str | None = None

    while len(recorder.steps) < max_steps:
        if recorder.elapsed > deadline_seconds:
            error = "deadline_exceeded"
            recorder.record(
                kind="think",
                action="stop",
                outcome="abandoned",
                observation=f"Out of time after {recorder.elapsed:.0f}s.",
                note="deadline_exceeded",
            )
            break

        try:
            reply = transport({**payload_base, "messages": messages})
        except Exception as exc:  # a dead endpoint is a step, not a traceback
            error = f"{type(exc).__name__}: {exc}"
            recorder.record(
                kind="think",
                action="call_model",
                outcome="error",
                observation=error,
            )
            break

        message = ((reply.get("choices") or [{}])[0].get("message")) or {}
        calls = _tool_calls(message)
        if not calls:
            recorder.record(
                kind="think",
                action="call_model",
                outcome="abandoned",
                observation=truncate(message.get("content") or "(empty reply)"),
                note="model replied without calling a tool",
            )
            # Echo the reply back before the nudge: two consecutive user turns
            # is a message shape some endpoints reject outright.
            messages.append(
                {"role": "assistant", "content": message.get("content") or ""}
            )
            messages.append({"role": "user", "content": "Call exactly one tool."})
            continue

        call = calls[0]
        name = (call.get("function") or {}).get("name") or ""
        arguments = _arguments(call)
        messages.append(
            {
                "role": "assistant",
                "content": message.get("content") or "",
                "tool_calls": [call],
            }
        )

        if name == "finish":
            final_answer = str(arguments.get("final_answer", "")).strip()
            success_signal = bool(arguments.get("success_signal"))
            recorder.record(
                kind="think",
                action="finish",
                observation=final_answer,
                outcome="ok",
            )
            break

        if name == "note":
            thought = str(arguments.get("thought", "")).strip()
            abandoning = bool(arguments.get("abandoning"))
            recorder.record(
                kind="think",
                action="note",
                observation=thought,
                outcome="abandoned" if abandoning else "ok",
                note="dropped this approach" if abandoning else None,
            )
            observation = "Noted."
        elif name == "shell":
            observation = _run_shell_step(recorder, arguments, shell)
        else:
            recorder.record(
                kind="think",
                action=name or "unknown_tool",
                args=arguments,
                outcome="error",
                observation=f"No such tool: {name!r}.",
            )
            observation = f"No tool named {name!r}. Use shell, note, or finish."

        # The model cannot ration a budget it cannot see. Without this it spends
        # every step investigating and never calls finish, which costs the judge
        # a final answer it could have had.
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call.get("id", "0"),
                "content": truncate(observation) + _budget_hint(recorder, max_steps),
            }
        )

    if final_answer is None and error is None:
        error = "step_budget_exhausted"

    if not recorder.steps:
        # minItems is 1: a trajectory with no steps is not a trajectory.
        recorder.record(
            kind="think",
            action="start",
            outcome="error",
            observation="Branch produced no steps.",
        )

    trajectory: dict[str, Any] = {
        "branch_id": job["branch_id"],
        "angle": job["angle"],
        "task": task,
        "steps": recorder.steps,
        "success_signal": success_signal,
        "wall_ms": int(recorder.elapsed * 1000),
    }
    if final_answer:
        trajectory["final_answer"] = final_answer
    if error:
        trajectory["error"] = error
    return trajectory


def _budget_hint(recorder: StepRecorder, max_steps: int) -> str:
    remaining = max_steps - len(recorder.steps)
    if remaining <= 1:
        return (
            "\n\n[LAST STEP. Call finish now with whatever you have — say what you "
            "found, what you could not resolve, and set success_signal honestly.]"
        )
    return f"\n\n[{remaining} steps left.]"


def _run_shell_step(
    recorder: StepRecorder,
    arguments: dict[str, Any],
    shell: Callable[[str], tuple[int, str]],
) -> str:
    command = str(arguments.get("command", "")).strip()
    url = str(arguments.get("url", "")).strip() or None
    if not command:
        recorder.record(
            kind="shell", action="run", outcome="error", observation="No command given."
        )
        return "No command given."

    refusal = screen_command(command)
    if refusal:
        recorder.record(
            kind="shell",
            action="run",
            args={"command": command},
            url=url,
            outcome="abandoned",
            observation=refusal,
            note="blocked by Invariant 1: branches research, they never book",
        )
        return f"{refusal}. Research it instead, then finish."

    exit_code, output = shell(command)
    recorder.record(
        kind="shell",
        action="run",
        args={"command": command},
        url=url,
        outcome="ok" if exit_code == 0 else "error",
        observation=output.strip() or f"(no output, exit {exit_code})",
    )
    return output.strip() or f"(no output, exit {exit_code})"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one branch of a 3-way search.")
    parser.add_argument("--dir", default=BRANCH_DIR, help="working directory in the box")
    args = parser.parse_args(argv)

    job_path = os.path.join(args.dir, JOB_FILE)
    with open(job_path, encoding="utf-8") as handle:
        job = json.load(handle)

    recorder = StepRecorder(path=os.path.join(args.dir, STEPS_FILE))
    try:
        trajectory = run_branch(
            job,
            transport=http_transport(
                job.get("base_url", DEFAULT_BASE_URL),
                os.environ.get("SAIL_API_KEY", ""),
            ),
            recorder=recorder,
            deadline_seconds=float(job.get("deadline_seconds", DEFAULT_DEADLINE_SECONDS)),
        )
    except Exception as exc:  # the orchestrator polls for DONE; never leave it waiting
        trajectory = {
            "branch_id": job.get("branch_id", "?"),
            "angle": job.get("angle", ""),
            "task": job.get("task", ""),
            "steps": recorder.steps
            or [
                {
                    "i": 0,
                    "t": 0.0,
                    "kind": "think",
                    "action": "start",
                    "outcome": "error",
                    "observation_excerpt": "Branch died before recording a step.",
                }
            ],
            "success_signal": False,
            "wall_ms": int(recorder.elapsed * 1000),
            "error": f"{type(exc).__name__}: {exc}",
        }

    with open(os.path.join(args.dir, TRAJECTORY_FILE), "w", encoding="utf-8") as handle:
        json.dump(trajectory, handle, indent=2)
    # DONE last, always: it is the poller's signal that the file above is whole.
    with open(os.path.join(args.dir, DONE_FILE), "w", encoding="utf-8") as handle:
        handle.write("done\n")
    return 0 if trajectory.get("success_signal") else 1


if __name__ == "__main__":
    sys.exit(main())
