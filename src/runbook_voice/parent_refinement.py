"""Parent decisions for a bounded, stateful Sailbox search tree."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Mapping, Sequence

from .branch_search import Angle, Trajectory, TreeDecision
from .judge import PairwiseJudge
from .parent_planner import MIN_BRANCHES, StructuredPlanningModel, validate_branch_limit

REFINEMENT_SYSTEM_PROMPT = """\
You are the parent agent deciding whether the strongest branch has a complete,
reusable way to perform the user's task.

The winner's next children inherit its ENTIRE Sailbox snapshot: processes, browser
cookies, local databases, repositories, vector indexes, downloaded data, and caches.
Do not restart from scratch. If more work is needed, propose materially different
continuations that build on the inherited state and close specific evidence gaps.

Mark complete only when the recorded evidence covers every stated constraint and the
path is reusable. Extract positive guidance from what worked and negative guidance
from errors, abandoned paths, unsafe actions, and unsupported assumptions. Children
remain read-only and may not book, pay, send, publish, or perform irreversible steps.
"""


class ParentRefinementError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class RefinementAdvice:
    complete: bool
    reason: str
    do: tuple[str, ...]
    avoid: tuple[str, ...]
    angles: tuple[Angle, ...]


def refinement_schema(max_branches: int) -> dict[str, Any]:
    limit = validate_branch_limit(max_branches)
    guidance = {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "items": {"type": "string", "minLength": 12},
    }
    return {
        "type": "object",
        "properties": {
            "complete": {"type": "boolean"},
            "reason": {"type": "string", "minLength": 20},
            "do": guidance,
            "avoid": guidance,
            "continuations": {
                "type": "array",
                "minItems": 0,
                "maxItems": limit,
                "items": {
                    "type": "object",
                    "properties": {
                        "angle": {"type": "string", "minLength": 12},
                        "directive": {"type": "string", "minLength": 30},
                    },
                    "required": ["angle", "directive"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["complete", "reason", "do", "avoid", "continuations"],
        "additionalProperties": False,
    }


class ParentRefiner:
    def __init__(self, model: StructuredPlanningModel) -> None:
        self._model = model

    def refine(
        self,
        winner: Trajectory,
        siblings: Sequence[Trajectory],
        *,
        max_branches: int,
        can_continue: bool,
    ) -> RefinementAdvice:
        limit = validate_branch_limit(max_branches)
        prompt = {
            "winner": winner.to_dict(),
            "siblings": [item.to_dict() for item in siblings if item.branch_id != winner.branch_id],
            "continuation_allowed": can_continue,
            "continuation_limit": limit,
            "instruction": (
                "If complete, return no continuations. If incomplete and continuation is "
                f"allowed, return {MIN_BRANCHES}–{limit} distinct ways to improve the "
                "winner from its inherited Sailbox state. If continuation is not allowed, "
                "return no continuations and explain the remaining gap."
            ),
        }
        raw = self._model.compare(
            system=REFINEMENT_SYSTEM_PROMPT,
            prompt=json.dumps(prompt, indent=2),
            schema=refinement_schema(limit),
        )
        return _parse_advice(raw, limit, can_continue)


class ParentTreeController:
    """Judge a round, then decide whether and how its winner should branch."""

    def __init__(
        self,
        model: StructuredPlanningModel,
        *,
        max_branches: int,
    ) -> None:
        self._judge = PairwiseJudge(model)
        self._refiner = ParentRefiner(model)
        self._max_branches = validate_branch_limit(max_branches)

    def decide(
        self,
        trajectories: Sequence[Trajectory],
        *,
        depth: int,
        can_continue: bool,
    ) -> TreeDecision:
        verdict = self._judge.pick([item.to_dict() for item in trajectories])
        winner = next(item for item in trajectories if item.branch_id == verdict.winner)
        advice = self._refiner.refine(
            winner,
            trajectories,
            max_branches=self._max_branches,
            can_continue=can_continue,
        )
        reason = f"{verdict.reason} {advice.reason}".strip()
        return TreeDecision(
            winner=verdict.winner,
            complete=advice.complete,
            reason=reason,
            next_angles=advice.angles,
            do=advice.do,
            avoid=advice.avoid,
        )


def _parse_advice(raw: str, limit: int, can_continue: bool) -> RefinementAdvice:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ParentRefinementError(f"parent returned malformed refinement JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ParentRefinementError("parent refinement must be an object")
    complete = payload.get("complete")
    reason = payload.get("reason")
    if not isinstance(complete, bool):
        raise ParentRefinementError("parent refinement needs a completion decision")
    if not isinstance(reason, str) or len(reason.strip()) < 20:
        raise ParentRefinementError("parent refinement needs a meaningful reason")
    do = _guidance(payload.get("do"), "do")
    avoid = _guidance(payload.get("avoid"), "avoid")
    continuations = payload.get("continuations")
    if not isinstance(continuations, list):
        raise ParentRefinementError("parent refinement needs a continuations array")
    if complete or not can_continue:
        if continuations:
            raise ParentRefinementError("a stopped refinement cannot launch continuations")
        return RefinementAdvice(complete, reason.strip(), do, avoid, ())
    if not MIN_BRANCHES <= len(continuations) <= limit:
        raise ParentRefinementError(
            f"incomplete winner needs {MIN_BRANCHES}–{limit} continuations"
        )
    angles: list[Angle] = []
    for index, item in enumerate(continuations):
        if not isinstance(item, Mapping):
            raise ParentRefinementError(f"continuation {index} is not an object")
        angle = item.get("angle")
        directive = item.get("directive")
        if not isinstance(angle, str) or len(angle.strip()) < 12:
            raise ParentRefinementError(f"continuation {index} has no useful angle")
        if not isinstance(directive, str) or len(directive.strip()) < 30:
            raise ParentRefinementError(f"continuation {index} has no useful directive")
        angles.append(Angle(f"next-{index}", angle.strip(), directive.strip()))
    if len({item.directive.casefold() for item in angles}) != len(angles):
        raise ParentRefinementError("parent produced duplicate continuations")
    return RefinementAdvice(False, reason.strip(), do, avoid, tuple(angles))


def _guidance(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise ParentRefinementError(f"parent refinement needs {label} guidance")
    items = tuple(item.strip() for item in value if isinstance(item, str) and len(item.strip()) >= 12)
    if len(items) != len(value):
        raise ParentRefinementError(f"parent refinement has invalid {label} guidance")
    return items


__all__ = [
    "ParentRefiner",
    "ParentRefinementError",
    "ParentTreeController",
    "REFINEMENT_SYSTEM_PROMPT",
    "RefinementAdvice",
    "refinement_schema",
]
