from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

import pytest

from runbook_voice.dialogue import (
    AsyncSlotFillingDialogue,
    DialogueStatus,
    NO_MATCH_MESSAGE,
    RETRY_MESSAGE,
    SlotFillingDialogue,
    confirmation_text,
    parse_slot_value,
)
from runbook_voice.runbook_store import JSONRunbookStore
from runbook_voice.runbooks import Runbook, RunbookStep, SlotDefinition, SlotType


def _restaurant_runbook() -> Runbook:
    return Runbook(
        id="restaurant",
        name="Restaurant reservation",
        version="1.0",
        description="Book a dinner table at a restaurant",
        slots=(
            SlotDefinition(
                "party_size",
                SlotType.INTEGER,
                description="the number of diners",
            ),
            SlotDefinition("date", description="the reservation date"),
            SlotDefinition("outdoor", SlotType.BOOLEAN, required=False, default=False),
            SlotDefinition("note", required=False),
        ),
        steps=(
            RunbookStep(
                id="reserve",
                action="restaurant.reserve",
                arguments={"size": "{{party_size}}", "date": "{{date}}"},
            ),
        ),
    )


class _Input:
    def __init__(self, *responses: Any) -> None:
        self.responses = deque(responses)
        self.calls = 0

    def listen(self) -> str:
        self.calls += 1
        return self.responses.popleft()


class _FailingInput:
    def listen(self) -> str:
        raise RuntimeError("transcriber unavailable")


class _Output:
    def __init__(self) -> None:
        self.messages: list[str] = []

    def say(self, text: str) -> None:
        self.messages.append(text)


class _AsyncInput:
    def __init__(self, *responses: Any) -> None:
        self.responses = deque(responses)
        self.calls = 0

    async def listen(self) -> str:
        self.calls += 1
        return self.responses.popleft()


class _AsyncOutput:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def say(self, text: str) -> None:
        self.messages.append(text)


def _store(tmp_path: Path) -> JSONRunbookStore:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(_restaurant_runbook())
    return store


def test_matched_dialogue_collects_slots_and_returns_executor_handoff(
    tmp_path: Path,
) -> None:
    dialogue_input = _Input("2", "tomorrow")
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(_store(tmp_path), dialogue_input, dialogue_output)

    outcome = dialogue.run("Please arrange a dinner reservation")

    assert outcome.status is DialogueStatus.READY
    assert outcome.ready
    assert outcome.invocation is not None
    assert outcome.invocation.runbook.id == "restaurant"
    assert dict(outcome.invocation.slot_values) == {
        "party_size": 2,
        "date": "tomorrow",
        "outdoor": False,
    }
    assert dialogue_output.messages == [
        "Please provide the number of diners.",
        "Please provide the reservation date.",
        "Got it. party size: 2; date: tomorrow; outdoor: false.",
    ]


def test_no_match_speaks_and_stores_exact_cold_path_seam(tmp_path: Path) -> None:
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(_store(tmp_path), _Input(), dialogue_output)

    outcome = dialogue.run("Tell me tomorrow's weather")

    assert outcome.status is DialogueStatus.NO_MATCH
    assert outcome.invocation is None
    assert outcome.message == NO_MATCH_MESSAGE == "I don't know how to do that yet"
    assert dialogue_output.messages == [NO_MATCH_MESSAGE]


def test_slots_are_asked_in_declaration_order_with_only_fixed_type_retry(
    tmp_path: Path,
) -> None:
    dialogue_input = _Input("two", "2", "Friday")
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(_store(tmp_path), dialogue_input, dialogue_output)

    outcome = dialogue.run("Book a restaurant table")

    assert outcome.status is DialogueStatus.READY
    assert dialogue_output.messages[:4] == [
        "Please provide the number of diners.",
        RETRY_MESSAGE,
        "Please provide the reservation date.",
        "Got it. party size: 2; date: Friday; outdoor: false.",
    ]
    assert dialogue_input.calls == 3


def test_retry_is_bounded_and_fails_without_an_invocation(tmp_path: Path) -> None:
    dialogue_input = _Input("", "still not a number", "unused")
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(
        _store(tmp_path), dialogue_input, dialogue_output, max_attempts=2
    )

    outcome = dialogue.run("Reserve a table")

    assert outcome.status is DialogueStatus.FAILED
    assert outcome.failed_slot == "party_size"
    assert outcome.invocation is None
    assert outcome.message == RETRY_MESSAGE
    assert dialogue_input.calls == 2
    assert dialogue_output.messages == [
        "Please provide the number of diners.",
        RETRY_MESSAGE,
        RETRY_MESSAGE,
    ]


def test_input_adapter_failures_use_the_same_bounded_safe_failure(tmp_path: Path) -> None:
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(
        _store(tmp_path), _FailingInput(), dialogue_output, max_attempts=2
    )

    outcome = dialogue.run("Reserve a table")

    assert outcome.status is DialogueStatus.FAILED
    assert outcome.invocation is None
    assert dialogue_output.messages == [
        "Please provide the number of diners.",
        RETRY_MESSAGE,
        RETRY_MESSAGE,
    ]


def test_prefilled_values_and_defaults_skip_questions_but_are_confirmed(
    tmp_path: Path,
) -> None:
    dialogue_input = _Input()
    dialogue_output = _Output()
    dialogue = SlotFillingDialogue(_store(tmp_path), dialogue_input, dialogue_output)

    outcome = dialogue.run(
        "Make a dinner booking", {"party_size": "4", "date": "Saturday"}
    )

    assert outcome.status is DialogueStatus.READY
    assert dialogue_input.calls == 0
    assert dialogue_output.messages == [
        "Got it. party size: 4; date: Saturday; outdoor: false."
    ]
    assert outcome.invocation is not None
    assert dict(outcome.invocation.slot_values) == {
        "party_size": 4,
        "date": "Saturday",
        "outdoor": False,
    }


@pytest.mark.parametrize(
    ("slot_type", "response", "expected"),
    [
        (SlotType.STRING, "  hello  ", "hello"),
        (SlotType.INTEGER, "-12", -12),
        (SlotType.NUMBER, "3.25", 3.25),
        (SlotType.NUMBER, "3", 3),
        (SlotType.BOOLEAN, "YES", True),
        (SlotType.BOOLEAN, "off", False),
        (SlotType.OBJECT, '{"quiet":true}', {"quiet": True}),
        (SlotType.ARRAY, '["window",2]', ["window", 2]),
    ],
)
def test_parse_slot_value_by_declared_type(
    slot_type: SlotType, response: str, expected: Any
) -> None:
    assert parse_slot_value(SlotDefinition("value", slot_type), response) == expected


@pytest.mark.parametrize(
    ("slot_type", "response"),
    [
        (SlotType.INTEGER, "2.5"),
        (SlotType.NUMBER, "NaN"),
        (SlotType.BOOLEAN, "maybe"),
        (SlotType.OBJECT, "[]"),
        (SlotType.ARRAY, "{}"),
        (SlotType.STRING, "  "),
    ],
)
def test_parse_slot_value_rejects_unparseable_input(
    slot_type: SlotType, response: str
) -> None:
    with pytest.raises((TypeError, ValueError)):
        parse_slot_value(SlotDefinition("value", slot_type), response)


def test_confirmation_text_uses_schema_order() -> None:
    runbook = _restaurant_runbook()
    assert confirmation_text(
        runbook,
        {"date": "Monday", "outdoor": True, "party_size": 3},
    ) == "Got it. party size: 3; date: Monday; outdoor: true."


@pytest.mark.asyncio
async def test_async_dialogue_matches_collects_and_confirms(tmp_path: Path) -> None:
    dialogue_input = _AsyncInput("6", "Sunday")
    dialogue_output = _AsyncOutput()
    dialogue = AsyncSlotFillingDialogue(
        _store(tmp_path), dialogue_input, dialogue_output
    )

    outcome = await dialogue.run("Arrange dinner reservations")

    assert outcome.status is DialogueStatus.READY
    assert outcome.invocation is not None
    assert dict(outcome.invocation.slot_values) == {
        "party_size": 6,
        "date": "Sunday",
        "outdoor": False,
    }
    assert dialogue_output.messages[-1] == (
        "Got it. party size: 6; date: Sunday; outdoor: false."
    )


@pytest.mark.asyncio
async def test_async_dialogue_has_explicit_no_match_outcome(tmp_path: Path) -> None:
    dialogue_output = _AsyncOutput()
    dialogue = AsyncSlotFillingDialogue(_store(tmp_path), _AsyncInput(), dialogue_output)

    outcome = await dialogue.run("Read my unread email")

    assert outcome.status is DialogueStatus.NO_MATCH
    assert outcome.message == NO_MATCH_MESSAGE
    assert dialogue_output.messages == [NO_MATCH_MESSAGE]


@pytest.mark.parametrize("dialogue_type", [SlotFillingDialogue, AsyncSlotFillingDialogue])
@pytest.mark.parametrize("max_attempts", [0, -1, True, 1.5])
def test_attempt_limit_must_be_a_positive_integer(
    tmp_path: Path, dialogue_type: type[Any], max_attempts: Any
) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        dialogue_type(
            _store(tmp_path), _Input(), _Output(), max_attempts=max_attempts
        )
