"""Intent lookup and deliberately small slot-filling dialogue policy.

The orchestration works with text at its boundaries. Audio capture,
transcription, synthesis, and playback remain adapter concerns, so this module
is fully testable without service credentials or devices.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
import json
import math
import re
from types import MappingProxyType
from typing import Any, Protocol

from .runbooks import Runbook, SlotDefinition, SlotResolutionError, SlotType


NO_MATCH_MESSAGE = "I don't know how to do that yet"
RETRY_MESSAGE = "I didn't catch that"

_INTEGER = re.compile(r"^[+-]?\d+$")
_TRUE_VALUES = frozenset({"1", "on", "true", "yes"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


class RunbookLookup(Protocol):
    """The only store capability needed by the dialogue."""

    def lookup(self, utterance: str) -> Mapping[str, Any] | None: ...


class DialogueInput(Protocol):
    """Synchronous source of already-transcribed replies."""

    def listen(self) -> str: ...


class DialogueOutput(Protocol):
    """Synchronous sink for text that should be spoken."""

    def say(self, text: str) -> None: ...


class AsyncDialogueInput(Protocol):
    """Asynchronous source of already-transcribed replies."""

    async def listen(self) -> str: ...


class AsyncDialogueOutput(Protocol):
    """Asynchronous sink for text that should be spoken."""

    async def say(self, text: str) -> None: ...


class DialogueStatus(str, Enum):
    READY = "ready"
    NO_MATCH = "no_match"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RunbookInvocation:
    """Fully resolved warm-path input ready for ``RunbookExecutor``."""

    runbook: Runbook
    slot_values: Mapping[str, Any]

    def __post_init__(self) -> None:
        object.__setattr__(self, "slot_values", MappingProxyType(dict(self.slot_values)))


@dataclass(frozen=True, slots=True)
class DialogueOutcome:
    """Explicit seam between warm replay, cold search, and safe failure."""

    status: DialogueStatus
    utterance: str
    message: str
    invocation: RunbookInvocation | None = None
    failed_slot: str | None = None

    @property
    def ready(self) -> bool:
        return self.status is DialogueStatus.READY


class SlotFillingDialogue:
    """Synchronous lookup and linear, declaration-ordered slot collection."""

    def __init__(
        self,
        store: RunbookLookup,
        dialogue_input: DialogueInput,
        dialogue_output: DialogueOutput,
        *,
        max_attempts: int = 2,
    ) -> None:
        _validate_max_attempts(max_attempts)
        self._store = store
        self._input = dialogue_input
        self._output = dialogue_output
        self._max_attempts = max_attempts

    def run(
        self,
        utterance: str,
        prefilled_slots: Mapping[str, Any] | None = None,
    ) -> DialogueOutcome:
        runbook = _lookup_runbook(self._store, utterance)
        if runbook is None:
            self._output.say(NO_MATCH_MESSAGE)
            return DialogueOutcome(
                status=DialogueStatus.NO_MATCH,
                utterance=utterance,
                message=NO_MATCH_MESSAGE,
            )

        values = _prepare_prefilled(runbook, prefilled_slots)
        for slot in _missing_required_slots(runbook, values):
            self._output.say(slot_question(slot))
            parsed = self._collect_slot(slot)
            if parsed is _MISSING:
                return DialogueOutcome(
                    status=DialogueStatus.FAILED,
                    utterance=utterance,
                    message=RETRY_MESSAGE,
                    failed_slot=slot.name,
                )
            values[slot.name] = parsed

        resolved = runbook.resolve_slots(values)
        confirmation = confirmation_text(runbook, resolved)
        # If speaking fails, no invocation is returned to the executor caller.
        self._output.say(confirmation)
        return DialogueOutcome(
            status=DialogueStatus.READY,
            utterance=utterance,
            message=confirmation,
            invocation=RunbookInvocation(runbook, resolved),
        )

    def _collect_slot(self, slot: SlotDefinition) -> Any:
        for _ in range(self._max_attempts):
            try:
                response = self._input.listen()
                return parse_slot_value(slot, response)
            except Exception:
                # Capture/transcription and parse failures share the one
                # intentionally small repair path. The bound prevents loops.
                self._output.say(RETRY_MESSAGE)
        return _MISSING


class AsyncSlotFillingDialogue:
    """Async equivalent for streaming or event-loop based voice adapters."""

    def __init__(
        self,
        store: RunbookLookup,
        dialogue_input: AsyncDialogueInput,
        dialogue_output: AsyncDialogueOutput,
        *,
        max_attempts: int = 2,
    ) -> None:
        _validate_max_attempts(max_attempts)
        self._store = store
        self._input = dialogue_input
        self._output = dialogue_output
        self._max_attempts = max_attempts

    async def run(
        self,
        utterance: str,
        prefilled_slots: Mapping[str, Any] | None = None,
    ) -> DialogueOutcome:
        runbook = _lookup_runbook(self._store, utterance)
        if runbook is None:
            await self._output.say(NO_MATCH_MESSAGE)
            return DialogueOutcome(
                status=DialogueStatus.NO_MATCH,
                utterance=utterance,
                message=NO_MATCH_MESSAGE,
            )

        values = _prepare_prefilled(runbook, prefilled_slots)
        for slot in _missing_required_slots(runbook, values):
            await self._output.say(slot_question(slot))
            parsed = await self._collect_slot(slot)
            if parsed is _MISSING:
                return DialogueOutcome(
                    status=DialogueStatus.FAILED,
                    utterance=utterance,
                    message=RETRY_MESSAGE,
                    failed_slot=slot.name,
                )
            values[slot.name] = parsed

        resolved = runbook.resolve_slots(values)
        confirmation = confirmation_text(runbook, resolved)
        await self._output.say(confirmation)
        return DialogueOutcome(
            status=DialogueStatus.READY,
            utterance=utterance,
            message=confirmation,
            invocation=RunbookInvocation(runbook, resolved),
        )

    async def _collect_slot(self, slot: SlotDefinition) -> Any:
        for _ in range(self._max_attempts):
            try:
                response = await self._input.listen()
                return parse_slot_value(slot, response)
            except Exception:
                await self._output.say(RETRY_MESSAGE)
        return _MISSING


def parse_slot_value(slot: SlotDefinition, response: str) -> Any:
    """Parse one transcribed reply according to its declared M0 slot type."""

    if not isinstance(response, str):
        raise TypeError("slot response must be text")
    text = response.strip()
    if not text:
        raise ValueError("slot response is empty")

    if slot.type is SlotType.STRING:
        value: Any = text
    elif slot.type is SlotType.INTEGER:
        if not _INTEGER.fullmatch(text):
            raise ValueError("expected an integer")
        value = int(text)
    elif slot.type is SlotType.NUMBER:
        value = _parse_number(text)
    elif slot.type is SlotType.BOOLEAN:
        normalized = text.casefold()
        if normalized in _TRUE_VALUES:
            value = True
        elif normalized in _FALSE_VALUES:
            value = False
        else:
            raise ValueError("expected yes/no or true/false")
    elif slot.type in (SlotType.OBJECT, SlotType.ARRAY):
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError("expected JSON") from error
    else:  # pragma: no cover - SlotType prevents unsupported values
        raise ValueError(f"unsupported slot type: {slot.type}")

    slot.validate(value)
    return value


def slot_question(slot: SlotDefinition) -> str:
    """Build the one allowed question for a missing slot."""

    # A hand-written prompt is already a question; use it verbatim rather than
    # wrapping it into "Please provide How many people?".
    if slot.prompt:
        return slot.prompt.strip()
    label = (slot.description or slot.name.replace("_", " ")).strip().rstrip(".?")
    return f"Please provide {label}."


def confirmation_text(runbook: Runbook, values: Mapping[str, Any]) -> str:
    """Render every resolved slot in declaration order for spoken confirmation."""

    filled = [
        f"{slot.name.replace('_', ' ')}: {_format_value(values[slot.name])}"
        for slot in runbook.slots
        if slot.name in values
    ]
    if not filled:
        return "Got it. No slot values are needed."
    return "Got it. " + "; ".join(filled) + "."


def _lookup_runbook(store: RunbookLookup, utterance: str) -> Runbook | None:
    document = store.lookup(utterance)
    if document is None:
        return None
    if isinstance(document, Runbook):
        return document
    return Runbook.from_dict(document)


def _prepare_prefilled(
    runbook: Runbook, prefilled: Mapping[str, Any] | None
) -> dict[str, Any]:
    values = dict(prefilled or {})
    definitions = {slot.name: slot for slot in runbook.slots}
    unknown = sorted(set(values) - set(definitions))
    if unknown:
        raise SlotResolutionError(f"unknown slots: {', '.join(unknown)}")
    for name, value in values.items():
        slot = definitions[name]
        if isinstance(value, str):
            try:
                values[name] = parse_slot_value(slot, value)
            except (SlotResolutionError, TypeError, ValueError) as error:
                raise SlotResolutionError(
                    f"prefilled slot {name!r} is invalid: {error}"
                ) from error
        else:
            slot.validate(value)
    return values


def _missing_required_slots(
    runbook: Runbook, values: Mapping[str, Any]
) -> list[SlotDefinition]:
    return [
        slot
        for slot in runbook.slots
        if slot.required and not slot.has_default and slot.name not in values
    ]


def _parse_number(text: str) -> int | float:
    if _INTEGER.fullmatch(text):
        return int(text)
    try:
        value = float(text)
    except ValueError as error:
        raise ValueError("expected a number") from error
    if not math.isfinite(value):
        raise ValueError("expected a finite number")
    return value


def _format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Mapping):
        return json.dumps(_jsonable(value), sort_keys=True, separators=(",", ":"))
    if isinstance(value, tuple | list):
        return json.dumps(_jsonable(value), separators=(",", ":"))
    return str(value)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_jsonable(item) for item in value]
    return value


def _validate_max_attempts(max_attempts: int) -> None:
    if (
        not isinstance(max_attempts, int)
        or isinstance(max_attempts, bool)
        or max_attempts < 1
    ):
        raise ValueError("max_attempts must be a positive integer")


_MISSING = object()


__all__ = [
    "AsyncDialogueInput",
    "AsyncDialogueOutput",
    "AsyncSlotFillingDialogue",
    "DialogueInput",
    "DialogueOutcome",
    "DialogueOutput",
    "DialogueStatus",
    "NO_MATCH_MESSAGE",
    "RETRY_MESSAGE",
    "RunbookInvocation",
    "RunbookLookup",
    "SlotFillingDialogue",
    "confirmation_text",
    "parse_slot_value",
    "slot_question",
]
