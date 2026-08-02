from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from runbook_voice.executor import (
    ConfirmationRequest,
    ExecutionStatus,
    RunbookExecutor,
    StepStatus,
)
from runbook_voice.runbooks import Runbook


class RecordingRunner:
    def __init__(
        self,
        *,
        fail_on: str | None = None,
        events: list[str] | None = None,
    ) -> None:
        self.fail_on = fail_on
        self.calls: list[tuple[str, Mapping[str, Any]]] = []
        self.events = events

    async def execute(self, action: str, arguments: Mapping[str, Any]) -> Any:
        self.calls.append((action, arguments))
        if self.events is not None:
            self.events.append(f"execute:{action}")
        if action == self.fail_on:
            raise RuntimeError("Sailbox action failed")
        return {"action": action, "call": len(self.calls)}


class RecordingGate:
    def __init__(
        self,
        approved: bool,
        *,
        events: list[str] | None = None,
        raises: bool = False,
    ) -> None:
        self.approved = approved
        self.requests: list[ConfirmationRequest] = []
        self.events = events
        self.raises = raises

    async def confirm(self, request: ConfirmationRequest) -> bool:
        self.requests.append(request)
        if self.events is not None:
            self.events.append(f"confirm:{request.step.id}")
        if self.raises:
            raise ConnectionError("voice confirmation unavailable")
        return self.approved


def make_runbook() -> Runbook:
    return Runbook.from_dict(
        {
            "id": "dinner",
            "name": "Dinner",
            "version": "1",
            "slots": [
                {"name": "city"},
                {"name": "party_size", "type": "integer"},
            ],
            "steps": [
                {
                    "id": "find",
                    "action": "restaurant.search",
                    "arguments": {"query": "Dinner in {{city}}", "party": "{{party_size}}"},
                },
                {
                    "id": "inspect",
                    "action": "restaurant.availability",
                    "arguments": {"city": "{{city}}"},
                },
                {
                    "id": "reserve",
                    "action": "restaurant.reserve",
                    "arguments": {"party": "{{party_size}}"},
                    "irreversible": True,
                    "confirmation_prompt": "Book this table?",
                },
            ],
        }
    )


@pytest.mark.asyncio
async def test_dispatches_generic_actions_in_schema_order_on_one_runner() -> None:
    runner = RecordingRunner()
    gate = RecordingGate(True)

    result = await RunbookExecutor(runner, gate).execute(
        make_runbook(), {"city": "Oakland", "party_size": 4}
    )

    assert result.status is ExecutionStatus.SUCCEEDED
    assert [call[0] for call in runner.calls] == [
        "restaurant.search",
        "restaurant.availability",
        "restaurant.reserve",
    ]
    assert runner.calls[0][1] == {"query": "Dinner in Oakland", "party": 4}
    assert [step.status for step in result.steps] == [StepStatus.SUCCEEDED] * 3
    assert [step.output["call"] for step in result.steps] == [1, 2, 3]


@pytest.mark.asyncio
async def test_confirmation_handoff_happens_before_irreversible_dispatch() -> None:
    events: list[str] = []
    runner = RecordingRunner(events=events)
    gate = RecordingGate(True, events=events)

    result = await RunbookExecutor(runner, gate).execute(
        make_runbook(), {"city": "Berkeley", "party_size": 2}
    )

    assert result.succeeded
    assert events == [
        "execute:restaurant.search",
        "execute:restaurant.availability",
        "confirm:reserve",
        "execute:restaurant.reserve",
    ]
    request = gate.requests[0]
    assert request.prompt == "Book this table?"
    assert request.resolved_arguments == {"party": 2}


@pytest.mark.asyncio
async def test_confirmation_rejection_never_calls_irreversible_action() -> None:
    runner = RecordingRunner()
    gate = RecordingGate(False)

    result = await RunbookExecutor(runner, gate).execute(
        make_runbook(), {"city": "Oakland", "party_size": 4}
    )

    assert result.status is ExecutionStatus.CONFIRMATION_REJECTED
    assert [call[0] for call in runner.calls] == [
        "restaurant.search",
        "restaurant.availability",
    ]
    assert result.steps[-1].status is StepStatus.CONFIRMATION_REJECTED


@pytest.mark.asyncio
@pytest.mark.parametrize("gate", [None, RecordingGate(False, raises=True)])
async def test_missing_or_broken_confirmation_gate_fails_closed(gate: RecordingGate | None) -> None:
    runner = RecordingRunner()

    result = await RunbookExecutor(runner, gate).execute(
        make_runbook(), {"city": "Oakland", "party_size": 4}
    )

    assert result.status is ExecutionStatus.CONFIRMATION_REJECTED
    assert all(action != "restaurant.reserve" for action, _ in runner.calls)


@pytest.mark.asyncio
async def test_first_failure_short_circuits_and_is_not_retried() -> None:
    runner = RecordingRunner(fail_on="restaurant.availability")
    gate = RecordingGate(True)

    result = await RunbookExecutor(runner, gate).execute(
        make_runbook(), {"city": "Oakland", "party_size": 4}
    )

    assert result.status is ExecutionStatus.FAILED
    assert [call[0] for call in runner.calls] == [
        "restaurant.search",
        "restaurant.availability",
    ]
    assert result.steps[-1].status is StepStatus.FAILED
    assert result.steps[-1].error == "RuntimeError: Sailbox action failed"
    assert gate.requests == []


@pytest.mark.asyncio
async def test_slot_failure_never_calls_runner() -> None:
    runner = RecordingRunner()

    result = await RunbookExecutor(runner).execute(make_runbook(), {"city": "Oakland"})

    assert result.status is ExecutionStatus.FAILED
    assert result.steps[0].step_id == "__slots__"
    assert "missing required slot" in (result.steps[0].error or "")
    assert runner.calls == []
