from __future__ import annotations

import pytest

from runbook_voice.runbooks import (
    Runbook,
    RunbookSchemaError,
    SlotDefinition,
    SlotResolutionError,
    SlotType,
    substitute_slots,
)


def test_m0_document_round_trips_and_accepts_synthesis_aliases() -> None:
    document = {
        "id": "restaurant-booking",
        "name": "Book a restaurant",
        "schema_version": 1,
        "description": "Find then book.",
        "slots": [
            {"name": "party_size", "type": "integer"},
            {"name": "preferences", "type": "object", "default": {"outside": True}},
        ],
        "steps": [
            {
                "id": "search",
                "tool": "browser.search",
                "params": {"party": "{{party_size}}"},
            },
            {
                "id": "book",
                "action": "browser.click",
                "arguments": {"label": "Book for {{party_size}}"},
                "irreversible": True,
                "confirmation_prompt": "Place this booking?",
            },
        ],
    }

    runbook = Runbook.from_dict(document)

    assert runbook.version == "1"
    assert runbook.steps[0].action == "browser.search"
    assert runbook.steps[0].arguments == {"party": "{{party_size}}"}
    assert runbook.to_dict() == {
        "id": "restaurant-booking",
        "name": "Book a restaurant",
        "version": "1",
        "description": "Find then book.",
        "slots": [
            {"name": "party_size", "type": "integer", "required": True},
            {
                "name": "preferences",
                "type": "object",
                "required": True,
                "default": {"outside": True},
            },
        ],
        "steps": [
            {
                "id": "search",
                "action": "browser.search",
                "arguments": {"party": "{{party_size}}"},
                "irreversible": False,
            },
            {
                "id": "book",
                "action": "browser.click",
                "arguments": {"label": "Book for {{party_size}}"},
                "irreversible": True,
                "confirmation_prompt": "Place this booking?",
            },
        ],
    }


def test_recursive_substitution_preserves_full_expression_type() -> None:
    payload = {
        "party": "{{party_size}}",
        "title": "Table for {{party_size}}",
        "nested": [{"preferences": "{{preferences}}"}],
        "unchanged": 4,
    }

    assert substitute_slots(
        payload,
        {"party_size": 3, "preferences": {"quiet": True}},
    ) == {
        "party": 3,
        "title": "Table for 3",
        "nested": [{"preferences": {"quiet": True}}],
        "unchanged": 4,
    }


@pytest.mark.parametrize(
    ("slot_type", "bad_value"),
    [
        (SlotType.STRING, 1),
        (SlotType.INTEGER, True),
        (SlotType.NUMBER, "1"),
        (SlotType.BOOLEAN, 1),
        (SlotType.OBJECT, []),
        (SlotType.ARRAY, "not-an-array"),
    ],
)
def test_slot_type_validation(slot_type: SlotType, bad_value: object) -> None:
    slot = SlotDefinition("value", slot_type)

    with pytest.raises(SlotResolutionError):
        slot.validate(bad_value)


def test_invalid_defaults_and_duplicate_ids_are_rejected() -> None:
    with pytest.raises(SlotResolutionError):
        SlotDefinition("count", SlotType.INTEGER, default="two")

    with pytest.raises(RunbookSchemaError, match="step ids must be unique"):
        Runbook.from_dict(
            {
                "id": "duplicate",
                "name": "Duplicate",
                "version": "1",
                "steps": [
                    {"id": "same", "action": "a"},
                    {"id": "same", "action": "b"},
                ],
            }
        )


def test_missing_unknown_and_unavailable_slots_fail_closed() -> None:
    runbook = Runbook.from_dict(
        {
            "id": "slots",
            "name": "Slots",
            "version": "1",
            "slots": [
                {"name": "required_value"},
                {"name": "optional_value", "required": False},
            ],
            "steps": [],
        }
    )

    with pytest.raises(SlotResolutionError, match="missing required"):
        runbook.resolve_slots({})
    with pytest.raises(SlotResolutionError, match="unknown slots"):
        runbook.resolve_slots({"required_value": "ok", "typo": "bad"})
    with pytest.raises(SlotResolutionError, match="unavailable slot"):
        substitute_slots("{{optional_value}}", {"required_value": "ok"})
