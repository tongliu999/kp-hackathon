from __future__ import annotations

import builtins
from copy import deepcopy
import json
from pathlib import Path
from typing import Any

import pytest

from runbook_voice import branch_agent
from runbook_voice.branch_agent import (
    OBSERVATION_LIMIT,
    StepRecorder,
    main,
    run_branch,
    screen_command,
    truncate,
)

SCHEMA_PATH = Path(__file__).parents[1] / "schema" / "trajectory.schema.json"

JOB = {
    "branch_id": "b0",
    "angle": "Straight at the primary source",
    "directive": "Go directly to the obvious service and take the first exact match.",
    "task": "book a table for two on friday at seven, somewhere italian",
    "max_steps": 8,
}


def tool_reply(name: str, arguments: dict[str, Any], content: str = "", usage=None) -> dict[str, Any]:
    reply = {
        "choices": [
            {
                "message": {
                    "content": content,
                    "tool_calls": [
                        {
                            "id": "call-0",
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ],
                }
            }
        ]
    }
    if usage is not None:
        reply["usage"] = usage
    return reply


def text_reply(content: str) -> dict[str, Any]:
    return {"choices": [{"message": {"content": content}}]}


class ScriptedTransport:
    """Replays canned model replies and remembers what it was sent."""

    def __init__(self, *replies: dict[str, Any]) -> None:
        self._replies = list(replies)
        self.payloads: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> dict[str, Any]:
        # Snapshot: the loop appends to the same `messages` list every turn, so
        # holding the reference would only ever show its final state.
        self.payloads.append(deepcopy(payload))
        if not self._replies:
            raise AssertionError("transport called more times than the test scripted")
        return self._replies.pop(0)


class RecordingShell:
    def __init__(self, *results: tuple[int, str]) -> None:
        self._results = list(results)
        self.commands: list[str] = []

    def __call__(self, command: str) -> tuple[int, str]:
        self.commands.append(command)
        return self._results.pop(0) if self._results else (0, "ok")


def ticking_clock(step: float = 1.0):
    """Monotonic fake clock; `t` must never go backwards in a trajectory."""
    ticks = iter(range(10_000))
    return lambda: next(ticks) * step


def recorder() -> StepRecorder:
    return StepRecorder(clock=ticking_clock())


def test_a_finished_branch_records_every_step_it_took() -> None:
    shell = RecordingShell((0, "14 results, top is Trattoria Nove 4.8 stars"))
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "Filter by cuisine first."}),
        tool_reply(
            "shell",
            {"command": "curl -s https://example.test/search", "url": "https://example.test/search"},
        ),
        tool_reply("finish", {"final_answer": "Trattoria Nove at 7pm", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, shell=shell, recorder=recorder())

    assert [step["action"] for step in trajectory["steps"]] == ["note", "run", "finish"]
    assert [step["i"] for step in trajectory["steps"]] == [0, 1, 2]
    assert [step["kind"] for step in trajectory["steps"]] == ["think", "shell", "think"]
    assert trajectory["final_answer"] == "Trattoria Nove at 7pm"
    assert trajectory["success_signal"] is True
    assert "error" not in trajectory
    # Steps, not just the final answer - a trajectory of only conclusions is
    # nothing for the distiller to turn into a runbook.
    assert trajectory["steps"][1]["observation_excerpt"].startswith("14 results")
    assert trajectory["steps"][1]["url"] == "https://example.test/search"


def test_branch_records_token_usage_and_estimated_model_cost() -> None:
    pricing = {
        "input_usd_per_million": 0.70,
        "cached_input_usd_per_million": 0.18,
        "output_usd_per_million": 3.00,
        "source": "https://docs.sailresearch.com/pricing",
        "as_of": "2026-08-02",
    }
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "look"}, usage={"prompt_tokens": 1000, "completion_tokens": 100}),
        tool_reply("finish", {"final_answer": "done", "success_signal": True}, usage={"prompt_tokens": 1500, "completion_tokens": 200}),
    )

    trajectory = run_branch({**JOB, "pricing": pricing}, transport=transport, recorder=recorder())

    assert trajectory["metrics"]["model_calls"] == 2
    assert trajectory["metrics"]["input_tokens"] == 2500
    assert trajectory["metrics"]["output_tokens"] == 300
    assert trajectory["metrics"]["estimated_cost_usd"] == 0.00265


def test_step_times_never_go_backwards() -> None:
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "one"}),
        tool_reply("note", {"thought": "two"}),
        tool_reply("finish", {"final_answer": "done", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, recorder=recorder())

    times = [step["t"] for step in trajectory["steps"]]
    assert times == sorted(times)
    assert trajectory["wall_ms"] > 0


def test_a_failing_command_becomes_an_error_step_not_a_crash() -> None:
    shell = RecordingShell((7, "curl: (6) Could not resolve host"))
    transport = ScriptedTransport(
        tool_reply("shell", {"command": "curl -s https://nope.test"}),
        tool_reply("finish", {"final_answer": "could not reach it", "success_signal": False}),
    )

    trajectory = run_branch(JOB, transport=transport, shell=shell, recorder=recorder())

    assert trajectory["steps"][0]["outcome"] == "error"
    assert "Could not resolve host" in trajectory["steps"][0]["observation_excerpt"]
    # The branch kept going, and reported honestly.
    assert trajectory["success_signal"] is False


def test_an_abandoned_note_is_recorded_as_a_dead_end() -> None:
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "The listicle has no availability data.", "abandoning": True}),
        tool_reply("finish", {"final_answer": "went elsewhere", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, recorder=recorder())

    # The judge reads dead ends as signal and the distiller strips them.
    # Recording only what worked destroys both.
    assert trajectory["steps"][0]["outcome"] == "abandoned"
    assert trajectory["steps"][0]["note"]


def test_the_model_replying_without_a_tool_call_costs_a_step_not_the_run() -> None:
    transport = ScriptedTransport(
        text_reply("I think I should probably look at OpenTable."),
        tool_reply("finish", {"final_answer": "ok", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, recorder=recorder())

    assert trajectory["steps"][0]["outcome"] == "abandoned"
    assert trajectory["steps"][0]["note"] == "model replied without calling a tool"
    assert transport.payloads[1]["messages"][-1] == {
        "role": "user",
        "content": "Call exactly one tool.",
    }


def test_a_model_that_inlines_json_instead_of_calling_a_tool_is_still_understood() -> None:
    transport = ScriptedTransport(
        text_reply('Here you go:\n{"tool": "finish", "args": '
                   '{"final_answer": "inline", "success_signal": true}}'),
    )

    trajectory = run_branch(JOB, transport=transport, recorder=recorder())

    assert trajectory["final_answer"] == "inline"
    assert trajectory["steps"][0]["action"] == "finish"


def test_a_dead_endpoint_ends_the_branch_with_evidence() -> None:
    def explode(_payload: dict[str, Any]) -> dict[str, Any]:
        raise TimeoutError("inference timed out")

    trajectory = run_branch(JOB, transport=explode, recorder=recorder())

    assert trajectory["error"] == "TimeoutError: inference timed out"
    assert trajectory["success_signal"] is False
    assert trajectory["steps"], "even a dead branch must carry its steps"


def test_running_out_of_steps_is_reported_rather_than_hidden() -> None:
    job = {**JOB, "max_steps": 2}
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "one"}),
        tool_reply("note", {"thought": "two"}),
    )

    trajectory = run_branch(job, transport=transport, recorder=recorder())

    assert trajectory["error"] == "step_budget_exhausted"
    assert len(trajectory["steps"]) == 2


def test_a_branch_out_of_time_stops_itself_and_keeps_what_it_has() -> None:
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "one"}),
        tool_reply("note", {"thought": "two"}),
    )

    trajectory = run_branch(
        JOB, transport=transport, recorder=recorder(), deadline_seconds=3.0
    )

    assert trajectory["error"] == "deadline_exceeded"
    assert trajectory["steps"][-1]["outcome"] == "abandoned"


def test_the_branch_is_told_how_much_budget_it_has_left() -> None:
    # A model that cannot see its budget spends every step investigating and
    # never calls finish, which costs the judge a final answer it could have had.
    job = {**JOB, "max_steps": 3}
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "one"}),
        tool_reply("note", {"thought": "two"}),
        tool_reply("finish", {"final_answer": "wrapped up", "success_signal": False}),
    )

    trajectory = run_branch(JOB | job, transport=transport, recorder=recorder())

    assert "[2 steps left.]" in transport.payloads[1]["messages"][-1]["content"]
    assert "LAST STEP" in transport.payloads[2]["messages"][-1]["content"]
    assert trajectory["final_answer"] == "wrapped up"
    assert "error" not in trajectory


def test_the_step_budget_is_stated_in_the_prompt() -> None:
    transport = ScriptedTransport(
        tool_reply("finish", {"final_answer": "done", "success_signal": True})
    )

    run_branch({**JOB, "max_steps": 5}, transport=transport, recorder=recorder())

    assert "budget of 5 tool calls" in transport.payloads[0]["messages"][0]["content"]


def test_observations_are_capped_at_the_schema_limit() -> None:
    shell = RecordingShell((0, "x" * 9000))
    transport = ScriptedTransport(
        tool_reply("shell", {"command": "curl -s https://big.test"}),
        tool_reply("finish", {"final_answer": "big", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, shell=shell, recorder=recorder())

    excerpt = trajectory["steps"][0]["observation_excerpt"]
    assert len(excerpt) <= OBSERVATION_LIMIT
    assert excerpt.endswith("[truncated]")


def test_truncate_leaves_short_text_alone() -> None:
    assert truncate("short") == "short"


# --- Invariant 1: branches research, they never book ---------------------------


@pytest.mark.parametrize(
    "command",
    [
        "curl -X POST https://example.test/reservations",
        "curl --request PUT https://example.test/holds/1",
        "curl -s --data 'covers=2' https://example.test/search",
        "curl -s https://example.test/confirm-reservation",
        "curl -s https://example.test/cart/checkout",
    ],
)
def test_write_shaped_commands_are_refused(command: str) -> None:
    assert screen_command(command) is not None


@pytest.mark.parametrize(
    "command",
    [
        "curl -s https://example.test/search?cuisine=italian",
        # Reaching the page that offers the booking is the branch's success
        # condition, not a violation - the irreversible step is the submission.
        "curl -s https://example.test/restaurant/9/book?time=1900",
        "curl -s https://example.test/reservations?date=2026-08-03",
        "cat /root/branch/notes.txt",
        "python3 -c 'print(2+2)'",
        "ls -d /root",
    ],
)
def test_read_only_commands_are_allowed(command: str) -> None:
    assert screen_command(command) is None


def test_a_branch_that_tries_to_book_is_stopped_and_the_attempt_is_recorded() -> None:
    shell = RecordingShell()
    transport = ScriptedTransport(
        tool_reply("shell", {"command": "curl -X POST https://example.test/reservations"}),
        tool_reply("finish", {"final_answer": "held a table", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, shell=shell, recorder=recorder())

    assert shell.commands == [], "the booking request must never reach the shell"
    blocked = trajectory["steps"][0]
    # Recorded as a dead end rather than dropped: the judge should be able to see
    # that a branch reached for the irreversible step and was stopped.
    assert blocked["outcome"] == "abandoned"
    assert "Invariant 1" in blocked["note"]


# --- what the box writes back --------------------------------------------------


def test_emitted_trajectories_match_the_locked_schema() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    shell = RecordingShell((0, "results"), (3, "failed"))
    transport = ScriptedTransport(
        tool_reply("note", {"thought": "plan", "abandoning": True}),
        tool_reply("shell", {"command": "curl -s https://a.test", "url": "https://a.test"}),
        tool_reply("shell", {"command": "curl -s https://b.test"}),
        tool_reply("finish", {"final_answer": "done", "success_signal": True}),
    )

    trajectory = run_branch(JOB, transport=transport, shell=shell, recorder=recorder())

    validator = jsonschema.Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))
    assert list(validator.iter_errors(trajectory)) == []


def test_steps_are_appended_as_they_happen(tmp_path: Path) -> None:
    # A branch that dies mid-run still leaves its evidence on disk, which is the
    # whole reason steps are streamed rather than assembled at the end.
    path = tmp_path / "steps.jsonl"
    log = StepRecorder(path=str(path), clock=ticking_clock())

    log.record(kind="think", action="plan", observation="first")
    assert len(path.read_text().splitlines()) == 1
    log.record(kind="shell", action="run", observation="second")
    assert len(path.read_text().splitlines()) == 2


def test_done_is_written_after_the_trajectory(tmp_path: Path, monkeypatch) -> None:
    _write_job(tmp_path)
    monkeypatch.setattr(
        branch_agent,
        "http_transport",
        lambda *_args, **_kwargs: ScriptedTransport(
            tool_reply("finish", {"final_answer": "done", "success_signal": True})
        ),
    )
    opened = _record_write_order(monkeypatch)

    assert main(["--dir", str(tmp_path)]) == 0

    # DONE last, or the orchestrator can read a half-written trajectory.
    assert opened.index(str(tmp_path / "trajectory.json")) < opened.index(
        str(tmp_path / "DONE")
    )
    assert json.loads((tmp_path / "trajectory.json").read_text())["final_answer"] == "done"


def test_a_branch_that_blows_up_still_signals_done(tmp_path: Path, monkeypatch) -> None:
    _write_job(tmp_path)

    def explode(*_args, **_kwargs):
        raise RuntimeError("everything is on fire")

    monkeypatch.setattr(branch_agent, "run_branch", explode)

    # The orchestrator polls for DONE. A branch that dies without writing it
    # would hold the whole fan-out open until the poll deadline.
    assert main(["--dir", str(tmp_path)]) == 1
    assert (tmp_path / "DONE").exists()
    trajectory = json.loads((tmp_path / "trajectory.json").read_text())
    assert trajectory["error"] == "RuntimeError: everything is on fire"
    assert trajectory["steps"], "minItems is 1 - a trajectory needs at least one step"


def _write_job(directory: Path) -> None:
    (directory / "job.json").write_text(json.dumps(JOB))


def _record_write_order(monkeypatch) -> list[str]:
    opened: list[str] = []
    real_open = builtins.open

    def spy(file, mode="r", *args, **kwargs):
        if "w" in mode or "a" in mode:
            opened.append(str(file))
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy)
    return opened
