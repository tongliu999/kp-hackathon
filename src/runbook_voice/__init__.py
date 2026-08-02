"""Runbook Voice Assistant core package."""

from .executor import (
    ConfirmationGate,
    ConfirmationRequest,
    ExecutionResult,
    ExecutionStatus,
    PersistentSailboxRunner,
    RunbookExecutor,
    StepResult,
    StepStatus,
)
from .runbooks import (
    Runbook,
    RunbookSchemaError,
    RunbookStep,
    SlotDefinition,
    SlotResolutionError,
    SlotType,
    substitute_slots,
)

__version__ = "0.1.0"

__all__ = [
    "ConfirmationGate",
    "ConfirmationRequest",
    "ExecutionResult",
    "ExecutionStatus",
    "PersistentSailboxRunner",
    "Runbook",
    "RunbookExecutor",
    "RunbookSchemaError",
    "RunbookStep",
    "SlotDefinition",
    "SlotResolutionError",
    "SlotType",
    "StepResult",
    "StepStatus",
    "substitute_slots",
]
