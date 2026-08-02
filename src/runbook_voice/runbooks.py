"""M0 runbook schema and slot resolution.

The models in this module deliberately contain no Sailbox or voice-provider
types.  They form the JSON-compatible contract between runbook synthesis,
storage, and replay.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
import re
from types import MappingProxyType
from typing import Any


class RunbookSchemaError(ValueError):
    """Raised when a runbook document does not satisfy the M0 schema."""


class SlotResolutionError(ValueError):
    """Raised when supplied slot values cannot resolve a runbook step."""


class SlotType(str, Enum):
    STRING = "string"
    INTEGER = "integer"
    NUMBER = "number"
    BOOLEAN = "boolean"
    OBJECT = "object"
    ARRAY = "array"


_NO_DEFAULT = object()
_FULL_SLOT = re.compile(r"^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$")
_SLOT = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _freeze(value: Any) -> Any:
    """Make schema payloads immutable without losing JSON-like structure."""
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list | tuple):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


@dataclass(frozen=True, slots=True)
class SlotDefinition:
    """A named value supplied at replay time."""

    name: str
    type: SlotType = SlotType.STRING
    required: bool = True
    description: str | None = None
    # The spoken question asked when this slot is missing. `description` is
    # documentation ("the party size"); `prompt` is askable ("How many people?").
    prompt: str | None = None
    default: Any = field(default=_NO_DEFAULT, repr=False)

    def __post_init__(self) -> None:
        if not self.name or not _FULL_SLOT.fullmatch("{{" + self.name + "}}"):
            raise RunbookSchemaError(f"invalid slot name: {self.name!r}")
        try:
            object.__setattr__(self, "type", SlotType(self.type))
        except ValueError as exc:
            raise RunbookSchemaError(f"unsupported type for slot {self.name!r}: {self.type!r}") from exc
        if self.default is not _NO_DEFAULT:
            object.__setattr__(self, "default", _freeze(self.default))
            self.validate(self.default)

    @property
    def has_default(self) -> bool:
        return self.default is not _NO_DEFAULT

    def validate(self, value: Any) -> None:
        valid = {
            SlotType.STRING: lambda item: isinstance(item, str),
            SlotType.INTEGER: lambda item: isinstance(item, int) and not isinstance(item, bool),
            SlotType.NUMBER: lambda item: isinstance(item, int | float) and not isinstance(item, bool),
            SlotType.BOOLEAN: lambda item: isinstance(item, bool),
            SlotType.OBJECT: lambda item: isinstance(item, Mapping),
            SlotType.ARRAY: lambda item: isinstance(item, Sequence) and not isinstance(item, str | bytes),
        }[self.type](value)
        if not valid:
            raise SlotResolutionError(
                f"slot {self.name!r} must be {self.type.value}; got {type(value).__name__}"
            )

    @classmethod
    def from_dict(cls, document: Mapping[str, Any]) -> SlotDefinition:
        if "name" not in document:
            raise RunbookSchemaError("slot is missing 'name'")
        kwargs: dict[str, Any] = {
            "name": document["name"],
            "type": document.get("type", SlotType.STRING),
            "required": document.get("required", True),
            "description": document.get("description"),
            "prompt": document.get("prompt"),
        }
        if "default" in document:
            kwargs["default"] = document["default"]
        return cls(**kwargs)

    def to_dict(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "name": self.name,
            "type": self.type.value,
            "required": self.required,
        }
        if self.description is not None:
            document["description"] = self.description
        if self.prompt is not None:
            document["prompt"] = self.prompt
        if self.has_default:
            document["default"] = _thaw(self.default)
        return document


@dataclass(frozen=True, slots=True)
class RunbookStep:
    """One schema-driven action dispatched to the persistent runner."""

    id: str
    action: str
    arguments: Mapping[str, Any] = field(default_factory=dict)
    irreversible: bool = False
    description: str | None = None
    confirmation_prompt: str | None = None

    def __post_init__(self) -> None:
        if not self.id:
            raise RunbookSchemaError("step id cannot be empty")
        if not self.action:
            raise RunbookSchemaError(f"step {self.id!r} has an empty action")
        if not isinstance(self.arguments, Mapping):
            raise RunbookSchemaError(f"step {self.id!r} arguments must be an object")
        object.__setattr__(self, "arguments", _freeze(self.arguments))

    @classmethod
    def from_dict(cls, document: Mapping[str, Any]) -> RunbookStep:
        action = document.get("action", document.get("tool", document.get("type")))
        arguments = document.get(
            "arguments", document.get("params", document.get("input", {}))
        )
        try:
            return cls(
                id=document["id"],
                action=action,
                arguments=arguments,
                irreversible=document.get("irreversible", False),
                description=document.get("description"),
                confirmation_prompt=document.get("confirmation_prompt"),
            )
        except KeyError as exc:
            raise RunbookSchemaError("step is missing 'id'") from exc

    def to_dict(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "id": self.id,
            "action": self.action,
            "arguments": _thaw(self.arguments),
            "irreversible": self.irreversible,
        }
        if self.description is not None:
            document["description"] = self.description
        if self.confirmation_prompt is not None:
            document["confirmation_prompt"] = self.confirmation_prompt
        return document


@dataclass(frozen=True, slots=True)
class Runbook:
    """A versioned sequence of replayable actions."""

    id: str
    name: str
    version: str
    slots: tuple[SlotDefinition, ...]
    steps: tuple[RunbookStep, ...]
    description: str | None = None

    def __post_init__(self) -> None:
        if not self.id or not self.name or not self.version:
            raise RunbookSchemaError("runbook id, name, and version are required")
        object.__setattr__(self, "slots", tuple(self.slots))
        object.__setattr__(self, "steps", tuple(self.steps))
        slot_names = [slot.name for slot in self.slots]
        step_ids = [step.id for step in self.steps]
        if len(slot_names) != len(set(slot_names)):
            raise RunbookSchemaError("slot names must be unique")
        if len(step_ids) != len(set(step_ids)):
            raise RunbookSchemaError("step ids must be unique")

    @classmethod
    def from_dict(cls, document: Mapping[str, Any]) -> Runbook:
        try:
            return cls(
                id=document["id"],
                name=document["name"],
                version=str(document.get("version", document.get("schema_version", ""))),
                description=document.get("description"),
                slots=tuple(SlotDefinition.from_dict(slot) for slot in document.get("slots", ())),
                steps=tuple(RunbookStep.from_dict(step) for step in document["steps"]),
            )
        except KeyError as exc:
            raise RunbookSchemaError(f"runbook is missing {exc.args[0]!r}") from exc

    def to_dict(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "slots": [slot.to_dict() for slot in self.slots],
            "steps": [step.to_dict() for step in self.steps],
        }
        if self.description is not None:
            document["description"] = self.description
        return document

    def resolve_slots(self, supplied: Mapping[str, Any]) -> dict[str, Any]:
        """Validate supplied values and apply defaults for declared slots."""
        definitions = {slot.name: slot for slot in self.slots}
        unknown = sorted(set(supplied) - set(definitions))
        if unknown:
            raise SlotResolutionError(f"unknown slots: {', '.join(unknown)}")

        resolved: dict[str, Any] = {}
        for slot in self.slots:
            if slot.name in supplied:
                value = supplied[slot.name]
            elif slot.has_default:
                value = slot.default
            elif slot.required:
                raise SlotResolutionError(f"missing required slot: {slot.name}")
            else:
                continue
            slot.validate(value)
            resolved[slot.name] = value
        return resolved


def substitute_slots(value: Any, slots: Mapping[str, Any]) -> Any:
    """Recursively replace ``{{slot}}`` expressions in a JSON-like value.

    A string consisting solely of one expression preserves the slot's original
    type.  Expressions embedded in larger strings are converted to text.
    """
    if isinstance(value, Mapping):
        return {key: substitute_slots(item, slots) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [substitute_slots(item, slots) for item in value]
    if not isinstance(value, str):
        return value

    full_match = _FULL_SLOT.fullmatch(value)
    if full_match:
        name = full_match.group(1)
        if name not in slots:
            raise SlotResolutionError(f"step references unavailable slot: {name}")
        return _thaw(slots[name])

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in slots:
            raise SlotResolutionError(f"step references unavailable slot: {name}")
        return str(slots[name])

    return _SLOT.sub(replace, value)
