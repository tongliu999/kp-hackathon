from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from runbook_voice.executor import (
    ConfirmationRequest,
    ExecutionResult,
    ExecutionStatus,
    RunbookExecutor,
)
from runbook_voice.runbook_store import JSONRunbookStore, RunbookStoreError
from runbook_voice.runbooks import Runbook
from runbook_voice.warm_replay import (
    SynthesisStatus,
    WarmReplayJoin,
    WarmReplayStatus,
)


SYNTHESIZED_RUNBOOK: dict[str, Any] = {
    "id": "restaurant-reservation",
    "name": "Reserve an Italian restaurant table",
    "version": "1",
    "description": "Book dinner in San Francisco tomorrow evening",
    "slots": [
        {"name": "city", "type": "string", "required": True},
        {"name": "party_size", "type": "integer", "required": True},
        {"name": "day", "type": "string", "required": True},
        {"name": "time", "type": "string", "required": True},
    ],
    "steps": [
        {
            "id": "search",
            "action": "restaurant.search",
            "arguments": {
                "city": "{{city}}",
                "query": "Italian dinner for {{party_size}} on {{day}} at {{time}}",
            },
            "irreversible": False,
        },
        {
            "id": "reserve",
            "action": "restaurant.reserve",
            "arguments": {
                "city": "{{city}}",
                "party_size": "{{party_size}}",
                "day": "{{day}}",
                "time": "{{time}}",
            },
            "irreversible": True,
            "confirmation_prompt": "Place this restaurant reservation?",
        },
    ],
}

SLOTS = {
    "city": "San Francisco",
    "party_size": 2,
    "day": "tomorrow",
    "time": "seven",
}


class RecordingRunner:
    def __init__(self, *, fail_on: str | None = None) -> None:
        self.fail_on = fail_on
        self.calls: list[tuple[str, Mapping[str, Any]]] = []

    async def execute(self, action: str, arguments: Mapping[str, Any]) -> Any:
        self.calls.append((action, arguments))
        if action == self.fail_on:
            raise RuntimeError("persistent runner failed")
        return {"ok": True, "action": action}


class RecordingGate:
    def __init__(self, approved: bool) -> None:
        self.approved = approved
        self.requests: list[ConfirmationRequest] = []

    async def confirm(self, request: ConfirmationRequest) -> bool:
        self.requests.append(request)
        return self.approved


class RecordingExecutor:
    def __init__(self) -> None:
        self.calls: list[tuple[Runbook, Mapping[str, Any]]] = []

    async def execute(
        self, runbook: Runbook, slot_values: Mapping[str, Any]
    ) -> ExecutionResult:
        self.calls.append((runbook, slot_values))
        return ExecutionResult(runbook.id, ExecutionStatus.SUCCEEDED, ())


class FailingStore:
    def __init__(self, *, fail_save: bool = False, fail_lookup: bool = False) -> None:
        self.fail_save = fail_save
        self.fail_lookup = fail_lookup

    def save(self, runbook: Runbook) -> None:
        if self.fail_save:
            raise RunbookStoreError("save unavailable")

    def lookup(self, utterance: str) -> Mapping[str, Any] | None:
        if self.fail_lookup:
            raise RunbookStoreError("lookup unavailable")
        return None


class StaticStore:
    def __init__(self, document: Mapping[str, Any] | None) -> None:
        self.document = document

    def save(self, runbook: Runbook) -> None:
        self.document = runbook.to_dict()

    def lookup(self, utterance: str) -> Mapping[str, Any] | None:
        return self.document


def make_join(path: Path, runner: RecordingRunner, gate: RecordingGate) -> WarmReplayJoin:
    return WarmReplayJoin(
        JSONRunbookStore(path),
        RunbookExecutor(runner, gate),
    )


@pytest.mark.asyncio
async def test_synthesized_runbook_survives_new_store_and_replays_rephrased_request(
    tmp_path: Path,
) -> None:
    path = tmp_path / "runbooks.json"
    writer_runner = RecordingRunner()
    accepted = make_join(path, writer_runner, RecordingGate(True)).accept_synthesized(
        SYNTHESIZED_RUNBOOK
    )

    # A new store and join instance prove that the warm path reads durable data,
    # rather than replaying an in-memory Runbook left by synthesis.
    runner = RecordingRunner()
    gate = RecordingGate(True)
    reader = make_join(path, runner, gate)
    replayed = await reader.replay(
        "Could you arrange that San Francisco dinner booking tomorrow for two?",
        SLOTS,
    )

    assert accepted.status is SynthesisStatus.ACCEPTED
    assert accepted.runbook_id == "restaurant-reservation"
    assert replayed.status is WarmReplayStatus.SUCCEEDED
    assert replayed.execution is not None and replayed.execution.succeeded
    assert [action for action, _ in runner.calls] == [
        "restaurant.search",
        "restaurant.reserve",
    ]
    assert runner.calls[0][1] == {
        "city": "San Francisco",
        "query": "Italian dinner for 2 on tomorrow at seven",
    }
    assert runner.calls[1][1]["party_size"] == 2
    assert len(gate.requests) == 1
    assert gate.requests[0].step.id == "reserve"


@pytest.mark.asyncio
async def test_match_is_deserialized_before_executor_fake_receives_it(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    executor = RecordingExecutor()
    join = WarmReplayJoin(JSONRunbookStore(path), executor)
    assert join.accept_synthesized(SYNTHESIZED_RUNBOOK).accepted

    outcome = await WarmReplayJoin(JSONRunbookStore(path), executor).replay(
        "Arrange a dinner reservation in San Francisco",
        SLOTS,
    )

    assert outcome.status is WarmReplayStatus.SUCCEEDED
    assert len(executor.calls) == 1
    runbook, received_slots = executor.calls[0]
    assert isinstance(runbook, Runbook)
    assert runbook.id == "restaurant-reservation"
    assert received_slots is SLOTS


def test_invalid_synthesized_schema_is_not_persisted(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    executor = RecordingExecutor()

    outcome = WarmReplayJoin(JSONRunbookStore(path), executor).accept_synthesized(
        {"id": "incomplete", "name": "Missing version and steps"}
    )

    assert outcome.status is SynthesisStatus.INVALID_SCHEMA
    assert "RunbookSchemaError" in (outcome.error or "")
    assert not path.exists()
    assert executor.calls == []


def test_invalid_slot_default_from_synthesizer_is_schema_failure() -> None:
    payload = {
        **SYNTHESIZED_RUNBOOK,
        "slots": [{"name": "party_size", "type": "integer", "default": "two"}],
    }

    outcome = WarmReplayJoin(FailingStore(), RecordingExecutor()).accept_synthesized(payload)

    assert outcome.status is SynthesisStatus.INVALID_SCHEMA
    assert "SlotResolutionError" in (outcome.error or "")


def test_save_failure_is_explicit() -> None:
    outcome = WarmReplayJoin(
        FailingStore(fail_save=True), RecordingExecutor()
    ).accept_synthesized(SYNTHESIZED_RUNBOOK)

    assert outcome.status is SynthesisStatus.STORE_FAILURE
    assert outcome.runbook_id == "restaurant-reservation"
    assert "save unavailable" in (outcome.error or "")


@pytest.mark.asyncio
async def test_no_match_is_explicit_and_does_not_execute(tmp_path: Path) -> None:
    executor = RecordingExecutor()
    join = WarmReplayJoin(JSONRunbookStore(tmp_path / "runbooks.json"), executor)
    assert join.accept_synthesized(SYNTHESIZED_RUNBOOK).accepted

    outcome = await join.replay("What is the weather?", SLOTS)

    assert outcome.status is WarmReplayStatus.NO_MATCH
    assert outcome.execution is None
    assert executor.calls == []


@pytest.mark.asyncio
async def test_lookup_failure_is_explicit() -> None:
    outcome = await WarmReplayJoin(
        FailingStore(fail_lookup=True), RecordingExecutor()
    ).replay("reserve dinner", SLOTS)

    assert outcome.status is WarmReplayStatus.STORE_FAILURE
    assert "lookup unavailable" in (outcome.error or "")


@pytest.mark.asyncio
async def test_invalid_persisted_schema_never_reaches_executor() -> None:
    executor = RecordingExecutor()

    outcome = await WarmReplayJoin(
        StaticStore({"id": "broken", "name": "Broken", "version": "1"}), executor
    ).replay("broken", {})

    assert outcome.status is WarmReplayStatus.INVALID_STORED_SCHEMA
    assert outcome.runbook_id == "broken"
    assert executor.calls == []


@pytest.mark.asyncio
async def test_slot_failure_is_distinct_and_never_calls_runner(tmp_path: Path) -> None:
    runner = RecordingRunner()
    join = make_join(tmp_path / "runbooks.json", runner, RecordingGate(True))
    assert join.accept_synthesized(SYNTHESIZED_RUNBOOK).accepted

    outcome = await join.replay(
        "Arrange a San Francisco dinner reservation",
        {"city": "San Francisco"},
    )

    assert outcome.status is WarmReplayStatus.SLOT_FAILURE
    assert outcome.execution is not None
    assert outcome.execution.steps[0].step_id == "__slots__"
    assert "missing required slot" in (outcome.error or "")
    assert runner.calls == []


@pytest.mark.asyncio
async def test_confirmation_rejection_cannot_dispatch_irreversible_step(tmp_path: Path) -> None:
    runner = RecordingRunner()
    gate = RecordingGate(False)
    join = make_join(tmp_path / "runbooks.json", runner, gate)
    assert join.accept_synthesized(SYNTHESIZED_RUNBOOK).accepted

    outcome = await join.replay("Reserve an Italian restaurant table", SLOTS)

    assert outcome.status is WarmReplayStatus.CONFIRMATION_REJECTED
    assert [action for action, _ in runner.calls] == ["restaurant.search"]
    assert len(gate.requests) == 1
    assert outcome.execution is not None
    assert outcome.execution.status is ExecutionStatus.CONFIRMATION_REJECTED


@pytest.mark.asyncio
async def test_executor_failure_is_explicit_and_stops_at_first_error(tmp_path: Path) -> None:
    runner = RecordingRunner(fail_on="restaurant.search")
    join = make_join(tmp_path / "runbooks.json", runner, RecordingGate(True))
    assert join.accept_synthesized(SYNTHESIZED_RUNBOOK).accepted

    outcome = await join.replay("Book a table for dinner", SLOTS)

    assert outcome.status is WarmReplayStatus.EXECUTOR_FAILURE
    assert "persistent runner failed" in (outcome.error or "")
    assert [action for action, _ in runner.calls] == ["restaurant.search"]


@pytest.mark.asyncio
async def test_unexpected_executor_exception_is_an_executor_failure() -> None:
    class RaisingExecutor:
        async def execute(
            self, runbook: Runbook, slot_values: Mapping[str, Any]
        ) -> ExecutionResult:
            raise RuntimeError("executor unavailable")

    outcome = await WarmReplayJoin(
        StaticStore(SYNTHESIZED_RUNBOOK), RaisingExecutor()
    ).replay("restaurant reservation", SLOTS)

    assert outcome.status is WarmReplayStatus.EXECUTOR_FAILURE
    assert "executor unavailable" in (outcome.error or "")
