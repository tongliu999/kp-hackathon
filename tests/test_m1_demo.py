from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

import pytest

import runbook_voice.m1_demo as m1_demo
from runbook_voice.dialogue import SlotFillingDialogue
from runbook_voice.executor import RunbookExecutor
from runbook_voice.m1_demo import ExactYesConfirmationGate, M1WarmPath, WarmPathStatus
from runbook_voice.runbook_store import JSONRunbookStore


ROOT = Path(__file__).parents[1]


class Replies:
    def __init__(self, *values: str) -> None:
        self.values = list(values)

    def listen(self) -> str:
        return self.values.pop(0)


class Spoken:
    def __init__(self) -> None:
        self.messages: list[str] = []

    def say(self, text: str) -> None:
        self.messages.append(text)


class AsyncReply:
    def __init__(self, value: str | Exception) -> None:
        self.value = value

    async def listen(self) -> str:
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


class AsyncSpoken:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def say(self, text: str) -> None:
        self.messages.append(text)


class BookingRunner:
    def __init__(self, *, fail_action: str | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail_action = fail_action

    async def execute(self, action: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((action, dict(arguments)))
        if action == self.fail_action:
            raise RuntimeError("provider failed")
        if action == "restaurant.book":
            return {"confirmation_id": "FAKE-ONLY-123"}
        return {"candidates": 1}


def build_path(tmp_path: Path, confirmation: str | Exception, *slots: str, fail=None):
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(json.loads((ROOT / "demo/handwritten_runbook.json").read_text()))
    voice = Spoken()
    dialogue = SlotFillingDialogue(store, Replies(*slots), voice)
    confirm_voice = AsyncSpoken()
    gate = ExactYesConfirmationGate(AsyncReply(confirmation), confirm_voice)
    runner = BookingRunner(fail_action=fail)
    return M1WarmPath(dialogue, RunbookExecutor(runner, gate)), runner, voice, confirm_voice


@pytest.mark.asyncio
async def test_offline_path_collects_slots_and_returns_fake_confirmation(tmp_path):
    path, runner, voice, confirm_voice = build_path(
        tmp_path, " YES ", "2", "Italian", "San Francisco", "tomorrow", "7 pm"
    )
    outcome = await path.run("Please reserve a dinner table")
    assert outcome.status is WarmPathStatus.SUCCEEDED
    assert [action for action, _ in runner.calls] == ["restaurant.search", "restaurant.book"]
    assert outcome.execution.steps[-1].output["confirmation_id"] == "FAKE-ONLY-123"
    assert voice.messages[0] == "Please provide the party size."
    assert "configured-provider" in confirm_voice.messages[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", ["no", "maybe", "", RuntimeError("silence")])
async def test_non_exact_yes_never_dispatches_irreversible_step(tmp_path, reply):
    path, runner, _, _ = build_path(
        tmp_path, reply, "2", "Italian", "San Francisco", "tomorrow", "7 pm"
    )
    outcome = await path.run("book a restaurant table")
    assert outcome.status is WarmPathStatus.CONFIRMATION_REJECTED
    assert [action for action, _ in runner.calls] == ["restaurant.search"]


@pytest.mark.asyncio
async def test_no_match_never_calls_runner(tmp_path):
    runner = BookingRunner()
    dialogue = SlotFillingDialogue(JSONRunbookStore(tmp_path / "empty.json"), Replies(), Spoken())
    gate = ExactYesConfirmationGate(AsyncReply("yes"), AsyncSpoken())
    outcome = await M1WarmPath(dialogue, RunbookExecutor(runner, gate)).run("launch a satellite")
    assert outcome.status is WarmPathStatus.NO_MATCH
    assert runner.calls == []


@pytest.mark.asyncio
async def test_runner_failure_is_explicit_and_stops(tmp_path):
    path, runner, _, _ = build_path(
        tmp_path, "yes", "2", "Italian", "San Francisco", "tomorrow", "7 pm", fail="restaurant.search"
    )
    outcome = await path.run("reserve a restaurant table")
    assert outcome.status is WarmPathStatus.EXECUTION_FAILED
    assert [action for action, _ in runner.calls] == ["restaurant.search"]


def test_warm_proof_has_no_cold_dependency():
    source = inspect.getsource(m1_demo)
    assert "cold_tasks" not in source
    assert "branching" not in source.casefold()


def test_live_cli_fails_closed(capsys):
    assert m1_demo.main(["--live"]) == 2
    assert "REFUSED" in capsys.readouterr().err
