"""Runbook Voice Assistant core package."""

from .audio import AudioClip
from .voice import LatencyReport, VoiceEchoLoop
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
    "AudioClip",
    "ConfirmationGate",
    "ConfirmationRequest",
    "ExecutionResult",
    "ExecutionStatus",
    "LatencyReport",
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
    "VoiceEchoLoop",
    "__version__",
    "substitute_slots",
]
