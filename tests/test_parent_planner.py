from __future__ import annotations

import json
from typing import Any, Mapping

import pytest

from runbook_voice.parent_planner import (
    MAX_BRANCH_LIMIT,
    MIN_BRANCHES,
    ParentPlanner,
    ParentPlanningError,
    plan_schema,
    validate_branch_limit,
)


class FixedModel:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.call: dict[str, Any] | None = None

    def compare(
        self, *, system: str, prompt: str, schema: Mapping[str, Any]
    ) -> str:
        self.call = {"system": system, "prompt": prompt, "schema": schema}
        return json.dumps(self.payload)


def approach(index: int) -> dict[str, str]:
    return {
        "angle": f"Distinct strategy number {index}",
        "directive": (
            f"Use evidence source {index} and validate the result with method {index}; "
            "record every failed attempt before finishing."
        ),
    }


def test_parent_decides_the_count_below_the_user_limit() -> None:
    model = FixedModel(
        {
            "rationale": "This narrow task benefits from two independent evidence paths.",
            "approaches": [approach(0), approach(1)],
        }
    )

    plan = ParentPlanner(model).plan("research a narrow question", max_branches=6)

    assert plan.branch_count == 2
    assert plan.max_branches == 6
    assert [angle.branch_id for angle in plan.angles] == ["b0", "b1"]
    assert model.call is not None
    assert model.call["schema"]["properties"]["approaches"]["maxItems"] == 6
    assert "ceiling, not a target" in model.call["prompt"]


def test_parent_can_use_the_full_limit_when_approaches_are_distinct() -> None:
    model = FixedModel(
        {
            "rationale": "This broad task has four materially different validation paths.",
            "approaches": [approach(index) for index in range(4)],
        }
    )

    plan = ParentPlanner(model).plan("compare a broad market", max_branches=4)

    assert plan.branch_count == 4
    assert len({angle.directive for angle in plan.angles}) == 4


@pytest.mark.parametrize("value", [MIN_BRANCHES - 1, MAX_BRANCH_LIMIT + 1, True, 3.5])
def test_branch_limit_is_bounded(value: object) -> None:
    with pytest.raises(ValueError, match="branch limit"):
        validate_branch_limit(value)  # type: ignore[arg-type]


def test_duplicate_parent_approaches_fail_before_any_boxes_launch() -> None:
    duplicate = approach(0)
    model = FixedModel(
        {
            "rationale": "Two independent attempts are requested, but these are duplicates.",
            "approaches": [duplicate, duplicate],
        }
    )

    with pytest.raises(ParentPlanningError, match="duplicate"):
        ParentPlanner(model).plan("a task", max_branches=5)


def test_plan_schema_never_allows_a_single_branch() -> None:
    schema = plan_schema(8)
    approaches = schema["properties"]["approaches"]

    assert approaches["minItems"] == 2
    assert approaches["maxItems"] == 8
