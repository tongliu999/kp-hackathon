"""Safety-critical runbook replay against an already-live Sailbox."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from .runbooks import Runbook, RunbookStep, SlotResolutionError, substitute_slots


@runtime_checkable
class PersistentSailboxRunner(Protocol):
    """Dispatch actions within one Sailbox owned by the caller.

    The protocol intentionally has no create/start method.  Lifecycle ownership
    stays outside the executor, which makes it impossible for replay to create
    a fresh box between steps.
    """

    async def execute(self, action: str, arguments: Mapping[str, Any]) -> Any:
        """Execute one named action in the existing Sailbox."""
        ...


@dataclass(frozen=True, slots=True)
class ConfirmationRequest:
    runbook_id: str
    runbook_name: str
    step: RunbookStep
    resolved_arguments: Mapping[str, Any]
    prompt: str


@runtime_checkable
class ConfirmationGate(Protocol):
    """Handoff boundary for user confirmation of irreversible work."""

    async def confirm(self, request: ConfirmationRequest) -> bool:
        ...


class StepStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CONFIRMATION_REJECTED = "confirmation_rejected"


class ExecutionStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CONFIRMATION_REJECTED = "confirmation_rejected"


@dataclass(frozen=True, slots=True)
class StepResult:
    step_id: str
    action: str
    status: StepStatus
    resolved_arguments: Mapping[str, Any]
    output: Any = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    runbook_id: str
    status: ExecutionStatus
    steps: tuple[StepResult, ...]

    @property
    def succeeded(self) -> bool:
        return self.status is ExecutionStatus.SUCCEEDED


class RunbookExecutor:
    """Execute a runbook once, sequentially, with no implicit retries."""

    def __init__(
        self,
        runner: PersistentSailboxRunner,
        confirmation_gate: ConfirmationGate | None = None,
    ) -> None:
        self._runner = runner
        self._confirmation_gate = confirmation_gate

    async def execute(
        self, runbook: Runbook, slot_values: Mapping[str, Any]
    ) -> ExecutionResult:
        try:
            slots = runbook.resolve_slots(slot_values)
        except SlotResolutionError as exc:
            return ExecutionResult(
                runbook_id=runbook.id,
                status=ExecutionStatus.FAILED,
                steps=(
                    StepResult(
                        step_id="__slots__",
                        action="resolve_slots",
                        status=StepStatus.FAILED,
                        resolved_arguments={},
                        error=str(exc),
                    ),
                ),
            )

        results: list[StepResult] = []
        for step in runbook.steps:
            try:
                arguments = substitute_slots(step.arguments, slots)
            except SlotResolutionError as exc:
                results.append(self._failure(step, {}, exc))
                return ExecutionResult(runbook.id, ExecutionStatus.FAILED, tuple(results))

            if step.irreversible:
                approved = await self._confirm(runbook, step, arguments, slots)
                if not approved:
                    results.append(
                        StepResult(
                            step_id=step.id,
                            action=step.action,
                            status=StepStatus.CONFIRMATION_REJECTED,
                            resolved_arguments=arguments,
                            error="irreversible action was not confirmed",
                        )
                    )
                    return ExecutionResult(
                        runbook.id, ExecutionStatus.CONFIRMATION_REJECTED, tuple(results)
                    )

            try:
                # Exactly one dispatch.  Retrying must be an explicit outer policy;
                # it is unsafe as an implicit behavior for irreversible actions.
                output = await self._runner.execute(step.action, arguments)
            except Exception as exc:  # runner errors become auditable step results
                results.append(self._failure(step, arguments, exc))
                return ExecutionResult(runbook.id, ExecutionStatus.FAILED, tuple(results))

            results.append(
                StepResult(
                    step_id=step.id,
                    action=step.action,
                    status=StepStatus.SUCCEEDED,
                    resolved_arguments=arguments,
                    output=output,
                )
            )

        return ExecutionResult(runbook.id, ExecutionStatus.SUCCEEDED, tuple(results))

    async def _confirm(
        self,
        runbook: Runbook,
        step: RunbookStep,
        arguments: Mapping[str, Any],
        slots: Mapping[str, Any],
    ) -> bool:
        # Missing confirmation plumbing is a denial, never an approval.
        if self._confirmation_gate is None:
            return False
        prompt = step.confirmation_prompt or f"Confirm irreversible action: {step.action}"
        try:
            # Invariant 1 wants the readback to name specifics, so the prompt is
            # templated like any other field. A prompt with no {{slot}} is unchanged.
            prompt = substitute_slots(prompt, slots)
        except SlotResolutionError:
            # An unresolvable readback would be spoken as literal "{{cuisine}}".
            # Refusing is the only safe outcome for an irreversible step.
            return False
        request = ConfirmationRequest(
            runbook_id=runbook.id,
            runbook_name=runbook.name,
            step=step,
            resolved_arguments=arguments,
            prompt=prompt,
        )
        try:
            return (await self._confirmation_gate.confirm(request)) is True
        except Exception:
            # Fail closed if the voice/UI handoff is unavailable.
            return False

    @staticmethod
    def _failure(
        step: RunbookStep, arguments: Mapping[str, Any], error: Exception
    ) -> StepResult:
        return StepResult(
            step_id=step.id,
            action=step.action,
            status=StepStatus.FAILED,
            resolved_arguments=arguments,
            error=f"{type(error).__name__}: {error}",
        )
