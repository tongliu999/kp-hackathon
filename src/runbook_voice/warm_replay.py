"""Join synthesized runbooks to durable, safety-gated warm replay.

TON-21's output enters this module as an untrusted mapping.  This module does
not synthesize or repair it: the ordinary M0 ``Runbook.from_dict`` path is the
only admission gate.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from .executor import ExecutionResult, ExecutionStatus, RunbookExecutor
from .runbook_store import JSONRunbookStore, RunbookStoreError
from .runbooks import Runbook, RunbookSchemaError, SlotResolutionError


class SynthesisStatus(str, Enum):
    ACCEPTED = "accepted"
    INVALID_SCHEMA = "invalid_schema"
    STORE_FAILURE = "store_failure"


@dataclass(frozen=True, slots=True)
class SynthesisOutcome:
    status: SynthesisStatus
    runbook_id: str | None = None
    error: str | None = None

    @property
    def accepted(self) -> bool:
        return self.status is SynthesisStatus.ACCEPTED


class WarmReplayStatus(str, Enum):
    SUCCEEDED = "succeeded"
    NO_MATCH = "no_match"
    STORE_FAILURE = "store_failure"
    INVALID_STORED_SCHEMA = "invalid_stored_schema"
    SLOT_FAILURE = "slot_failure"
    CONFIRMATION_REJECTED = "confirmation_rejected"
    EXECUTOR_FAILURE = "executor_failure"


@dataclass(frozen=True, slots=True)
class WarmReplayOutcome:
    status: WarmReplayStatus
    runbook_id: str | None = None
    execution: ExecutionResult | None = None
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.status is WarmReplayStatus.SUCCEEDED


class RunbookRepository(Protocol):
    """The small persistence surface required by the join point."""

    def save(self, runbook: Runbook) -> None:
        ...

    def lookup(self, utterance: str) -> Mapping[str, Any] | None:
        ...


class ReplayExecutor(Protocol):
    """Execution surface implemented by :class:`RunbookExecutor`."""

    async def execute(
        self, runbook: Runbook, slot_values: Mapping[str, Any]
    ) -> ExecutionResult:
        ...


class WarmReplayJoin:
    """Persist validated cold-path output and replay it on a warm match.

    Production callers should pass ``JSONRunbookStore`` and a
    ``RunbookExecutor`` configured with their persistent runner and confirmation
    gate.  The join point has no confirmation flag or direct runner access, so
    it cannot bypass the executor's irreversible-action gate.
    """

    def __init__(
        self,
        store: JSONRunbookStore | RunbookRepository,
        executor: RunbookExecutor | ReplayExecutor,
    ) -> None:
        self._store = store
        self._executor = executor

    def accept_synthesized(self, payload: Mapping[str, Any]) -> SynthesisOutcome:
        """Validate and persist one untrusted TON-21 M0 mapping.

        Invalid payloads are never repaired or written.  A valid model is saved
        through its canonical ``to_dict`` representation supplied by the store.
        """
        if not isinstance(payload, Mapping):
            return SynthesisOutcome(
                SynthesisStatus.INVALID_SCHEMA,
                error="synthesized runbook must be an object",
            )
        try:
            runbook = Runbook.from_dict(payload)
        except (RunbookSchemaError, SlotResolutionError, TypeError, AttributeError) as exc:
            return SynthesisOutcome(
                SynthesisStatus.INVALID_SCHEMA,
                error=_error_text(exc),
            )

        try:
            self._store.save(runbook)
        except RunbookStoreError as exc:
            return SynthesisOutcome(
                SynthesisStatus.STORE_FAILURE,
                runbook_id=runbook.id,
                error=_error_text(exc),
            )
        return SynthesisOutcome(SynthesisStatus.ACCEPTED, runbook_id=runbook.id)

    async def replay(
        self,
        utterance: str,
        slot_values: Mapping[str, Any],
    ) -> WarmReplayOutcome:
        """Match, deserialize, and execute a saved runbook exactly once."""
        try:
            document = self._store.lookup(utterance)
        except RunbookStoreError as exc:
            return WarmReplayOutcome(
                WarmReplayStatus.STORE_FAILURE,
                error=_error_text(exc),
            )
        if document is None:
            return WarmReplayOutcome(WarmReplayStatus.NO_MATCH)

        try:
            runbook = Runbook.from_dict(document)
        except (RunbookSchemaError, SlotResolutionError, TypeError, AttributeError) as exc:
            identity = document.get("id") if isinstance(document.get("id"), str) else None
            return WarmReplayOutcome(
                WarmReplayStatus.INVALID_STORED_SCHEMA,
                runbook_id=identity,
                error=_error_text(exc),
            )

        try:
            execution = await self._executor.execute(runbook, slot_values)
        except Exception as exc:
            return WarmReplayOutcome(
                WarmReplayStatus.EXECUTOR_FAILURE,
                runbook_id=runbook.id,
                error=_error_text(exc),
            )

        if execution.status is ExecutionStatus.SUCCEEDED:
            status = WarmReplayStatus.SUCCEEDED
        elif execution.status is ExecutionStatus.CONFIRMATION_REJECTED:
            status = WarmReplayStatus.CONFIRMATION_REJECTED
        elif any(step.step_id == "__slots__" for step in execution.steps):
            status = WarmReplayStatus.SLOT_FAILURE
        else:
            status = WarmReplayStatus.EXECUTOR_FAILURE

        error = next(
            (step.error for step in reversed(execution.steps) if step.error is not None),
            None,
        )
        return WarmReplayOutcome(
            status,
            runbook_id=runbook.id,
            execution=execution,
            error=error,
        )


def _error_text(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


__all__ = [
    "ReplayExecutor",
    "RunbookRepository",
    "SynthesisOutcome",
    "SynthesisStatus",
    "WarmReplayJoin",
    "WarmReplayOutcome",
    "WarmReplayStatus",
]
