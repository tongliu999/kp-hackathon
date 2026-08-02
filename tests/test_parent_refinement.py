from __future__ import annotations

import json

import pytest

from runbook_voice.branch_search import Trajectory
from runbook_voice.parent_refinement import (
    ParentRefiner,
    ParentRefinementError,
    refinement_schema,
)


class Model:
    def __init__(self, payload):
        self.payload = payload
        self.call = None

    def compare(self, **kwargs):
        self.call = kwargs
        return json.dumps(self.payload)


def trajectory(branch_id="b0"):
    return Trajectory.from_dict(
        {
            "branch_id": branch_id,
            "angle": f"approach for {branch_id}",
            "task": "research the complete workflow",
            "steps": [{"i": 0, "t": 0, "action": "inspect", "outcome": "ok"}],
            "final_answer": "partial evidence",
            "success_signal": False,
            "wall_ms": 10,
        }
    )


def advice(*, complete=False, continuations=None):
    return {
        "complete": complete,
        "reason": "The current winner still lacks independent verification evidence.",
        "do": ["Preserve the verified primary-source evidence."],
        "avoid": ["Do not repeat the abandoned unauthenticated endpoint."],
        "continuations": continuations if continuations is not None else [],
    }


def continuation(index):
    return {
        "angle": f"Verification strategy {index}",
        "directive": f"Continue from the inherited environment and verify gap {index} independently.",
    }


def test_incomplete_winner_gets_distinct_stateful_continuations() -> None:
    model = Model(advice(continuations=[continuation(0), continuation(1)]))

    result = ParentRefiner(model).refine(
        trajectory(), [trajectory(), trajectory("b1")], max_branches=5, can_continue=True
    )

    assert result.complete is False
    assert len(result.angles) == 2
    assert "ENTIRE Sailbox snapshot" in model.call["system"]
    assert "continuation_allowed" in model.call["prompt"]


def test_complete_winner_stops_without_more_children() -> None:
    model = Model(advice(complete=True))

    result = ParentRefiner(model).refine(
        trajectory(), [trajectory(), trajectory("b1")], max_branches=4, can_continue=True
    )

    assert result.complete is True
    assert result.angles == ()
    assert result.do and result.avoid


def test_depth_cap_disallows_even_model_proposed_continuations() -> None:
    model = Model(advice(continuations=[continuation(0), continuation(1)]))

    with pytest.raises(ParentRefinementError, match="stopped refinement"):
        ParentRefiner(model).refine(
            trajectory(), [trajectory(), trajectory("b1")], max_branches=4, can_continue=False
        )


def test_refinement_schema_keeps_the_parent_under_the_branch_limit() -> None:
    assert refinement_schema(6)["properties"]["continuations"]["maxItems"] == 6
