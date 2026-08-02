"""Contract tests for trajectory -> runbook distillation.

The goal these tests defend is generalization, not transcription.  A distiller
that emitted the original run verbatim would pass a naive "did it produce JSON"
check and still be worthless, so the load-bearing tests here are the ones that
replay the runbook with values the winning trajectory never saw, and the one
that fails if any concrete value from that trajectory survives into a step
argument.

The schema checks import `schema/validate.py` by path rather than restating its
rules, so the tests cannot drift from the validator that gates handoff.
"""

from __future__ import annotations

import importlib.util
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from runbook_voice import (
    ConfirmationRequest,
    DistillationError,
    ExecutionStatus,
    JSONRunbookStore,
    Runbook,
    RunbookExecutor,
    StepStatus,
    SynthesisStatus,
    WarmReplayJoin,
    WarmReplayStatus,
    distill,
)

ROOT = Path(__file__).resolve().parents[1]
TRAJECTORIES = ROOT / "fixtures" / "trajectories"
DISTILLED = ROOT / "fixtures" / "runbooks" / "distilled-branch-0.json"


def _load_validator_module():
    spec = importlib.util.spec_from_file_location(
        "schema_validate", ROOT / "schema" / "validate.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_validate = _load_validator_module()


def _trajectory(branch: int) -> dict[str, Any]:
    return json.loads((TRAJECTORIES / f"branch-{branch}.json").read_text())


@pytest.fixture
def runbook_document() -> dict[str, Any]:
    return distill(_trajectory(0))


class RecordingRunner:
    """Stands in for the persistent Sailbox.  Records, never books."""

    def __init__(self, *, fail_on: str | None = None) -> None:
        self.fail_on = fail_on
        self.calls: list[tuple[str, Mapping[str, Any]]] = []

    async def execute(self, action: str, arguments: Mapping[str, Any]) -> Any:
        self.calls.append((action, arguments))
        if action == self.fail_on:
            raise RuntimeError("Sailbox action failed")
        return {"action": action, "call": len(self.calls)}

    @property
    def actions(self) -> list[str]:
        return [action for action, _ in self.calls]


class RecordingGate:
    def __init__(self, approved: bool) -> None:
        self.approved = approved
        self.requests: list[ConfirmationRequest] = []

    async def confirm(self, request: ConfirmationRequest) -> bool:
        self.requests.append(request)
        return self.approved


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _argument_text(document: Mapping[str, Any]) -> str:
    """Every string the executor would hand to the runner or speak aloud.

    Slot `example` fields are deliberately excluded: recording that the winning
    run saw "7:00 PM" is documentation, whereas the same literal inside a step
    argument is the bug.
    """
    parts: list[str] = []
    for step in document["steps"]:
        parts.extend(_strings(step.get("arguments")))
        parts.extend(_strings(step.get("confirmation_prompt")))
    return " ".join(parts)


# --- the locked contracts -------------------------------------------------


def test_distilled_runbook_satisfies_the_locked_schema(runbook_document):
    schema = json.loads((ROOT / "schema" / "runbook.schema.json").read_text())
    errors = sorted(
        Draft202012Validator(schema).iter_errors(runbook_document),
        key=lambda error: list(error.absolute_path),
    )
    assert errors == [], [
        f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
        for e in errors
    ]


def test_distilled_runbook_satisfies_project_invariants(runbook_document):
    assert _validate.check_templates(runbook_document) == []
    assert _validate.check_invariants(runbook_document) == []


def test_version_is_a_string_not_an_integer(runbook_document):
    assert runbook_document["version"] == "1"


def test_every_slot_carries_a_spoken_question(runbook_document):
    # The prompt is read aloud when a slot is unfilled, so "the party size" is
    # not usable where "How many people?" is.
    for slot in runbook_document["slots"]:
        assert slot["prompt"].endswith("?"), slot
        assert slot["prompt"] != slot["description"]


def test_exactly_one_irreversible_step_and_it_names_specifics(runbook_document):
    irreversible = [s for s in runbook_document["steps"] if s.get("irreversible")]
    assert [step["id"] for step in irreversible] == ["book"]
    prompt = irreversible[0]["confirmation_prompt"]
    declared = {slot["name"] for slot in runbook_document["slots"]}
    referenced = set(_validate.TEMPLATE.findall(prompt))
    assert referenced, "a readback with no slot refs names nothing specific"
    assert referenced <= declared


def test_every_reference_resolves_to_a_fillable_slot(runbook_document):
    """An optional slot with no default resolves to nothing and blows up later.

    `resolve_slots` skips it silently rather than failing at the door, so the
    `{{ref}}` raises SlotResolutionError mid-replay - after earlier steps ran.
    """
    declared = {slot["name"]: slot for slot in runbook_document["slots"]}
    for step in runbook_document["steps"]:
        for text in _strings(step.get("arguments")):
            for reference in _validate.TEMPLATE.findall(text):
                slot = declared[reference]
                assert slot["required"] or "default" in slot


# --- generalization -------------------------------------------------------


@pytest.mark.parametrize(
    "literal",
    ["2", "Friday", "7:00 PM", "Italian", "Trattoria Nove", "19:00"],
)
def test_no_value_from_the_original_request_survives_into_arguments(
    runbook_document, literal
):
    assert literal not in _argument_text(runbook_document)


@pytest.mark.parametrize("mechanic", ["data-test", "opentable", "http", "selector"])
def test_no_provider_mechanics_survive_into_arguments(runbook_document, mechanic):
    assert mechanic not in _argument_text(runbook_document).casefold()


def test_actions_are_abstract_verbs(runbook_document):
    assert [step["action"] for step in runbook_document["steps"]] == [
        "restaurant.search",
        "restaurant.select",
        "restaurant.book",
    ]


def test_the_request_becomes_slots(runbook_document):
    assert [slot["name"] for slot in runbook_document["slots"]] == [
        "party_size",
        "cuisine",
        "date",
        "time",
    ]
    assert [slot["type"] for slot in runbook_document["slots"]] == [
        "integer",
        "string",
        "string",
        "string",
    ]


def test_reasoning_and_navigation_do_not_become_steps(runbook_document):
    # branch-0 opens opentable.com and plans before acting; neither is a verb the
    # runner can be asked to perform.
    assert len(runbook_document["steps"]) == 3


def test_distillation_is_deterministic():
    assert distill(_trajectory(0)) == distill(_trajectory(0))


def test_checked_in_fixture_matches_the_distiller():
    """The artifact is generated, so drift between it and the code is a bug."""
    assert json.loads(DISTILLED.read_text()) == distill(_trajectory(0))


# --- refusals -------------------------------------------------------------


def test_branch_1_is_refused_for_a_value_the_request_never_mentioned():
    with pytest.raises(DistillationError) as error:
        distill(_trajectory(1))
    assert "Ristorante Adriatico" in str(error.value)


def test_branch_2_is_refused_for_not_completing():
    with pytest.raises(DistillationError) as error:
        distill(_trajectory(2))
    assert "location_resolution_failed" in str(error.value)


def test_a_trajectory_with_no_working_steps_is_refused():
    trajectory = _trajectory(0)
    for step in trajectory["steps"]:
        step["outcome"] = "abandoned"
    with pytest.raises(DistillationError, match="no steps survived"):
        distill(trajectory)


def test_an_unknown_domain_is_refused():
    trajectory = _trajectory(0)
    trajectory["task"] = "renew my passport before the trip"
    with pytest.raises(DistillationError, match="no distillation vocabulary"):
        distill(trajectory)


# --- the loop: replay through the real executor ---------------------------


async def test_replays_with_values_the_winning_run_never_used(runbook_document):
    """The point of the whole ticket.

    Nothing here is branch-0's request: five people, Thai, Saturday, half past
    eight.  A runbook that only replays the original would fail this.
    """
    runner, gate = RecordingRunner(), RecordingGate(True)
    runbook = Runbook.from_dict(runbook_document)

    result = await RunbookExecutor(runner, gate).execute(
        runbook,
        {
            "party_size": 5,
            "cuisine": "Thai",
            "date": "Saturday",
            "time": "8:30 PM",
        },
    )

    assert result.status is ExecutionStatus.SUCCEEDED
    assert runner.actions == [
        "restaurant.search",
        "restaurant.select",
        "restaurant.book",
    ]

    booked = dict(runner.calls[-1][1])
    # "{{party_size}}" alone preserves the declared type; a stringified 5 would
    # reach the provider as text.
    assert booked["party_size"] == 5
    assert isinstance(booked["party_size"], int)
    assert booked == {
        "party_size": 5,
        "cuisine": "Thai",
        "date": "Saturday",
        "time": "8:30 PM",
    }

    spoken = gate.requests[0].prompt
    assert "{{" not in spoken
    assert "5" in spoken and "Thai" in spoken and "Saturday" in spoken
    assert "8:30 PM" in spoken


async def test_the_booking_never_dispatches_without_confirmation(runbook_document):
    runner, gate = RecordingRunner(), RecordingGate(False)

    result = await RunbookExecutor(runner, gate).execute(
        Runbook.from_dict(runbook_document),
        {"party_size": 2, "cuisine": "Italian", "date": "Friday", "time": "7:00 PM"},
    )

    assert result.status is ExecutionStatus.CONFIRMATION_REJECTED
    assert "restaurant.book" not in runner.actions
    assert result.steps[-1].status is StepStatus.CONFIRMATION_REJECTED


async def test_a_missing_gate_still_fails_closed(runbook_document):
    runner = RecordingRunner()

    result = await RunbookExecutor(runner).execute(
        Runbook.from_dict(runbook_document),
        {"party_size": 2, "cuisine": "Italian", "date": "Friday", "time": "7:00 PM"},
    )

    assert result.status is ExecutionStatus.CONFIRMATION_REJECTED
    assert "restaurant.book" not in runner.actions


# --- the loop: through the warm-replay join, unmodified -------------------


async def test_warm_replay_accepts_and_replays_without_special_casing(
    tmp_path, runbook_document
):
    """The done-criterion: the executor runs it as ordinary input.

    `WarmReplayJoin` admits synthesized runbooks through the same
    `Runbook.from_dict` gate as any other document, so a pass here means nothing
    in the replay path needed to know this runbook was machine-made.
    """
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    runner, gate = RecordingRunner(), RecordingGate(True)
    join = WarmReplayJoin(store, RunbookExecutor(runner, gate))

    accepted = join.accept_synthesized(runbook_document)
    assert accepted.status is SynthesisStatus.ACCEPTED
    assert accepted.runbook_id == "restaurant-reservation"

    outcome = await join.replay(
        "book a table for two on friday at seven, somewhere italian",
        {"party_size": 3, "cuisine": "Japanese", "date": "Sunday", "time": "6:30 PM"},
    )

    assert outcome.status is WarmReplayStatus.SUCCEEDED
    assert runner.actions[-1] == "restaurant.book"
    assert dict(runner.calls[-1][1])["cuisine"] == "Japanese"


def test_the_matcher_can_find_the_distilled_runbook(tmp_path, runbook_document):
    """`description` is written for this, and only `name` + `description` count.

    `Runbook.to_dict` drops `utterance_examples`, and the store's match fields do
    not include that key anyway, so a verbose description here is not merely
    untidy - it dilutes token coverage and drops the runbook below threshold.
    """
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(Runbook.from_dict(runbook_document))

    for utterance in (
        "book a table for two on friday at seven, somewhere italian",
        "Book a table for two at an Italian restaurant in San Francisco "
        "tomorrow evening at seven.",
        "Could you arrange that dinner booking again?",
    ):
        matched = store.lookup(utterance)
        assert matched is not None, utterance
        assert matched["id"] == "restaurant-reservation"

    assert store.lookup("what is the weather tomorrow") is None


# --- Research (shell) trajectories -----------------------------------------
#
# The cold path's branch agent holds only shell/note/finish, so it emits
# run{command} steps and fills no forms. The distiller was first written against
# browser-shaped fixtures, and the two did not compose until _lift_from_request
# existed. These tests pin the seam, because nothing else in the suite crosses
# it: the fixtures cannot catch a mismatch they do not contain.


def _research_trajectory(**overrides: Any) -> dict[str, Any]:
    """A shell trajectory shaped like what branch_agent.py actually writes."""
    trajectory = {
        "branch_id": "b1",
        "angle": "Build a candidate list from an independent source, then cross-check",
        "task": (
            "Book a table for two at an Italian restaurant in San Francisco "
            "tomorrow evening at seven."
        ),
        "steps": [
            {
                "i": 0,
                "kind": "shell",
                "action": "run",
                "outcome": "ok",
                "args": {"command": 'date -u -d tomorrow +"%A %Y-%m-%d"'},
                "observation_excerpt": "TOMORROW: Monday 2026-08-03",
            },
            {
                "i": 1,
                "kind": "shell",
                "action": "run",
                "outcome": "ok",
                "args": {
                    "command": "curl -s https://sf.eater.com/maps/best-italian-restaurants-san-francisco",
                    "url": "https://sf.eater.com/maps/best-italian-restaurants-san-francisco",
                },
                "observation_excerpt": "Cotogna, Flour + Water, Che Fico",
            },
            {
                "i": 2,
                "kind": "think",
                "action": "note",
                "outcome": "ok",
                "args": {"thought": "cross-check each against the booking platform"},
            },
        ],
        "final_answer": "Not booked — stopped at the reservable booking pages.",
        "success_signal": True,
        "wall_ms": 170_200,
    }
    trajectory.update(overrides)
    return trajectory


def test_a_research_trajectory_distils_even_though_it_fills_no_forms():
    """The M2 -> M3 seam. Branches curl; they never type into a field."""
    document = distill(_research_trajectory())
    assert {slot["name"] for slot in document["slots"]} == {
        "party_size",
        "cuisine",
        "city",
        "date",
        "time",
    }
    assert document["id"] == "restaurant-reservation"


def test_a_research_runbook_declares_the_same_slots_the_dialogue_collects():
    """The executor fail-closes on an unknown slot, so these sets must agree.

    The hand-written runbook takes a city; before the vocabulary had a city rule
    the distilled one did not, and replaying it with the dialogue's own slots
    died on "unknown slots: city" -- M3's output was not drivable by M1's
    dialogue.
    """
    document = distill(_research_trajectory())
    handwritten = json.loads((ROOT / "demo/handwritten_runbook.json").read_text())
    assert {slot["name"] for slot in document["slots"]} == {
        slot["name"] for slot in handwritten["slots"]
    }


def test_a_research_runbook_still_carries_no_concrete_values():
    """The generalization property is not relaxed for research trajectories."""
    document = distill(_research_trajectory())
    text = _argument_text(document)
    for literal in ("Cotogna", "Flour + Water", "eater.com", "2026-08-03", "curl"):
        assert literal not in text
    for step in document["steps"]:
        for value in step["arguments"].values():
            assert value.startswith("{{"), value


def test_a_research_trajectory_that_pursued_another_request_is_refused():
    """At least one request value must appear in what the branch actually ran.

    Without this a trajectory that solved some unrelated task could donate its
    slots, since the slots come from the request text rather than from anything
    the run wrote.
    """
    trajectory = _research_trajectory()
    for step in trajectory["steps"]:
        step["args"].pop("url", None)
        if "command" in step["args"]:
            step["args"]["command"] = "curl -s https://example.com/weather"
    with pytest.raises(DistillationError, match="does not evidence"):
        distill(trajectory)


def test_corroboration_ignores_what_the_agent_merely_restated():
    """Observations and the final answer restate the task; that is not evidence.

    A check satisfiable by the agent echoing its own instructions would pass by
    accident and read as proof. Only executed commands and URLs count -- so a
    run whose commands touch nothing from the request is refused even though
    every slot value appears verbatim in its prose.
    """
    trajectory = _research_trajectory()
    for step in trajectory["steps"]:
        step["args"].pop("url", None)
        if "command" in step["args"]:
            step["args"]["command"] = "curl -s https://example.com/"
        step["observation_excerpt"] = (
            "Booking a table for two at an Italian restaurant tomorrow at seven"
        )
    trajectory["final_answer"] = (
        "Table for two, Italian, tomorrow at seven — ready to confirm."
    )
    with pytest.raises(DistillationError, match="does not evidence"):
        distill(trajectory)


def test_a_losing_research_trajectory_is_still_refused():
    with pytest.raises(DistillationError, match="did not complete"):
        distill(_research_trajectory(success_signal=False))


def test_a_research_runbook_replays_with_values_the_branch_never_saw():
    """The point of distilling: the next caller supplies different values."""
    import asyncio

    document = distill(_research_trajectory())
    runner = RecordingRunner()
    executor = RunbookExecutor(runner, RecordingGate(True))
    result = asyncio.run(
        executor.execute(
            Runbook.from_dict(document),
            {
                "party_size": 4,
                "cuisine": "Japanese",
                "city": "New York",
                "date": "Saturday",
                "time": "8 pm",
            },
        )
    )
    assert result.succeeded
    assert runner.actions == ["restaurant.search", "restaurant.book"]
    assert dict(runner.calls[-1][1])["cuisine"] == "Japanese"
    assert dict(runner.calls[-1][1])["party_size"] == 4
