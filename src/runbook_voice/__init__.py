"""Runbook Voice Assistant core package."""

from .audio import AudioClip
from .cold_tasks import ColdTaskCoordinator, JobSnapshot, JobStatus
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
from .runbook_store import (
    DeterministicSemanticMatcher,
    JSONRunbookStore,
    RunbookMatcher,
    RunbookSerializable,
    RunbookStore,
    RunbookStoreCorruptionError,
    RunbookStoreError,
    RunbookValidationError,
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
from .voice import LatencyReport, VoiceEchoLoop

__version__ = "0.1.0"

__all__ = [
    "AudioClip",
    "ColdTaskCoordinator",
    "ConfirmationGate",
    "ConfirmationRequest",
    "DeterministicSemanticMatcher",
    "ExecutionResult",
    "ExecutionStatus",
    "JSONRunbookStore",
    "JobSnapshot",
    "JobStatus",
    "LatencyReport",
    "PersistentSailboxRunner",
    "Runbook",
    "RunbookExecutor",
    "RunbookMatcher",
    "RunbookSchemaError",
    "RunbookSerializable",
    "RunbookStep",
    "RunbookStore",
    "RunbookStoreCorruptionError",
    "RunbookStoreError",
    "RunbookValidationError",
    "SlotDefinition",
    "SlotResolutionError",
    "SlotType",
    "StepResult",
    "StepStatus",
    "VoiceEchoLoop",
    "__version__",
    "substitute_slots",
]
