"""Let the parent agent choose a bounded, diverse fan-out plan."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Mapping, Protocol

from .branch_search import Angle

MIN_BRANCHES = 2
MAX_BRANCH_LIMIT = 8
DEFAULT_BRANCH_LIMIT = 5

PARENT_SYSTEM_PROMPT = """\
You are the parent agent planning a branching search for an unfamiliar task.

Choose how many child agents to launch and give every child a materially different
approach. Use fewer branches for a narrow task and more only when they buy genuinely
different evidence. Approaches must differ in strategy, information source, constraint
handling, or validation method — cosmetic prompt rewrites are duplicates.

Children are read-only researchers. They cannot book, pay, send, publish, or perform
other irreversible external actions. Their complete trajectories will return to you.
If the best attempt is incomplete, its entire Sailbox can be checkpointed and forked
again so later children improve the existing environment instead of restarting. The
final root-to-leaf path becomes a reusable runbook with both do and avoid guidance.
"""


class ParentPlanningError(RuntimeError):
    """The parent model did not produce a safe, usable branch plan."""


class StructuredPlanningModel(Protocol):
    def compare(
        self, *, system: str, prompt: str, schema: Mapping[str, Any]
    ) -> str: ...


@dataclass(frozen=True, slots=True)
class BranchPlan:
    rationale: str
    max_branches: int
    angles: tuple[Angle, ...]

    @property
    def branch_count(self) -> int:
        return len(self.angles)


def validate_branch_limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("branch limit must be an integer")
    if not MIN_BRANCHES <= value <= MAX_BRANCH_LIMIT:
        raise ValueError(
            f"branch limit must be between {MIN_BRANCHES} and {MAX_BRANCH_LIMIT}"
        )
    return value


def plan_schema(max_branches: int) -> dict[str, Any]:
    limit = validate_branch_limit(max_branches)
    return {
        "type": "object",
        "properties": {
            "rationale": {
                "type": "string",
                "minLength": 20,
                "description": "Why this task needs this many distinct approaches.",
            },
            "approaches": {
                "type": "array",
                "minItems": MIN_BRANCHES,
                "maxItems": limit,
                "items": {
                    "type": "object",
                    "properties": {
                        "angle": {
                            "type": "string",
                            "minLength": 12,
                            "description": "Short human-readable name for the strategy.",
                        },
                        "directive": {
                            "type": "string",
                            "minLength": 30,
                            "description": "Concrete instructions that make this attempt distinct.",
                        },
                    },
                    "required": ["angle", "directive"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["rationale", "approaches"],
        "additionalProperties": False,
    }


class ParentPlanner:
    """Ask one parent model for a bounded set of non-duplicate approaches."""

    def __init__(self, model: StructuredPlanningModel) -> None:
        self._model = model

    def plan(self, task: str, max_branches: int = DEFAULT_BRANCH_LIMIT) -> BranchPlan:
        task = task.strip()
        if not task:
            raise ParentPlanningError("task must not be empty")
        limit = validate_branch_limit(max_branches)
        raw = self._model.compare(
            system=PARENT_SYSTEM_PROMPT,
            prompt=(
                f"Task:\n{task}\n\nChoose between {MIN_BRANCHES} and {limit} "
                "approaches. The limit is a ceiling, not a target."
            ),
            schema=plan_schema(limit),
        )
        return _parse_plan(raw, limit)


def _parse_plan(raw: str, max_branches: int) -> BranchPlan:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ParentPlanningError(f"parent returned malformed JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ParentPlanningError("parent plan must be an object")

    rationale = payload.get("rationale")
    approaches = payload.get("approaches")
    if not isinstance(rationale, str) or len(rationale.strip()) < 20:
        raise ParentPlanningError("parent plan needs a meaningful rationale")
    if not isinstance(approaches, list):
        raise ParentPlanningError("parent plan has no approaches")
    if not MIN_BRANCHES <= len(approaches) <= max_branches:
        raise ParentPlanningError(
            f"parent chose {len(approaches)} branches; allowed range is "
            f"{MIN_BRANCHES}–{max_branches}"
        )

    angles: list[Angle] = []
    for index, approach in enumerate(approaches):
        if not isinstance(approach, dict):
            raise ParentPlanningError(f"approach {index} is not an object")
        angle = approach.get("angle")
        directive = approach.get("directive")
        if not isinstance(angle, str) or len(angle.strip()) < 12:
            raise ParentPlanningError(f"approach {index} has no useful angle")
        if not isinstance(directive, str) or len(directive.strip()) < 30:
            raise ParentPlanningError(f"approach {index} has no useful directive")
        angles.append(Angle(f"b{index}", angle.strip(), directive.strip()))

    normalized_angles = {item.angle.casefold() for item in angles}
    normalized_directives = {item.directive.casefold() for item in angles}
    if len(normalized_angles) != len(angles) or len(normalized_directives) != len(angles):
        raise ParentPlanningError("parent produced duplicate approaches")
    return BranchPlan(rationale.strip(), max_branches, tuple(angles))


__all__ = [
    "BranchPlan",
    "DEFAULT_BRANCH_LIMIT",
    "MAX_BRANCH_LIMIT",
    "MIN_BRANCHES",
    "PARENT_SYSTEM_PROMPT",
    "ParentPlanner",
    "ParentPlanningError",
    "StructuredPlanningModel",
    "plan_schema",
    "validate_branch_limit",
]
