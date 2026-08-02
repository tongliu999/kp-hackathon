from __future__ import annotations

from dataclasses import dataclass
import json
import multiprocessing
from pathlib import Path
from typing import Sequence

import pytest

from runbook_voice.runbook_store import (
    DeterministicSemanticMatcher,
    JSONRunbookStore,
    Runbook,
    RunbookStoreCorruptionError,
    RunbookStoreError,
    RunbookValidationError,
)


RESTAURANT_RUNBOOK: Runbook = {
    "id": "restaurant-reservation",
    "name": "Reserve a restaurant table",
    "version": "1.0",
    "description": "Book a table for dinner at a restaurant",
    "slots": [
        {
            "name": "party_size",
            "type": "integer",
            "required": True,
            "description": "Number of diners",
            "default": None,
        }
    ],
    "steps": [
        {
            "id": "reserve",
            "action": "restaurant.reserve",
            "arguments": {"party_size": "{{party_size}}"},
            "irreversible": True,
            "description": "Submit the reservation",
            "confirmation_prompt": "Should I book it?",
        }
    ],
}


def _save_in_child(path: str, runbook: Runbook) -> None:
    JSONRunbookStore(path).save(runbook)


def _lookup_in_child(path: str, utterance: str, output: multiprocessing.Queue) -> None:
    output.put(JSONRunbookStore(path).lookup(utterance))


def _save_numbered_runbook(path: str, number: int) -> None:
    JSONRunbookStore(path).save(
        {
            "id": f"runbook-{number}",
            "name": f"Unique workflow {number}",
            "version": "1.0",
            "slots": [],
            "steps": [],
        }
    )


def test_save_and_semantic_lookup_across_processes(tmp_path: Path) -> None:
    path = tmp_path / "data" / "runbooks.json"
    context = multiprocessing.get_context("spawn")

    saver = context.Process(target=_save_in_child, args=(str(path), RESTAURANT_RUNBOOK))
    saver.start()
    saver.join(timeout=10)
    assert saver.exitcode == 0

    output = context.Queue()
    reader = context.Process(
        target=_lookup_in_child,
        args=(str(path), "Could you arrange a dinner reservation for me?", output),
    )
    reader.start()
    reader.join(timeout=10)
    assert reader.exitcode == 0
    assert output.get(timeout=2) == RESTAURANT_RUNBOOK


def test_lookup_returns_none_for_a_real_miss(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(RESTAURANT_RUNBOOK)

    assert store.lookup("What is tomorrow's weather forecast?") is None
    assert store.lookup("") is None


def test_missing_store_returns_none_without_creating_directory(tmp_path: Path) -> None:
    parent = tmp_path / "does-not-exist"
    store = JSONRunbookStore(parent / "runbooks.json")

    assert store.lookup("anything") is None
    assert not parent.exists()


def test_m0_runbook_contract_round_trips_unchanged(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(RESTAURANT_RUNBOOK)

    assert store.lookup("reserve a restaurant table") == RESTAURANT_RUNBOOK


def test_list_returns_isolated_completed_runbooks(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(RESTAURANT_RUNBOOK)

    listed = store.list()
    listed[0]["name"] = "mutated outside the store"

    assert store.list() == [RESTAURANT_RUNBOOK]


@dataclass
class _CanonicalRunbook:
    document: Runbook

    def to_dict(self) -> Runbook:
        return self.document


def test_accepts_m0_runbook_object_with_to_dict(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(_CanonicalRunbook(RESTAURANT_RUNBOOK))

    assert store.lookup("arrange dinner reservations") == RESTAURANT_RUNBOOK


def test_save_replaces_the_same_runbook_id(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    store = JSONRunbookStore(path)
    store.save(RESTAURANT_RUNBOOK)
    updated = {**RESTAURANT_RUNBOOK, "description": "Arrange a fancy dinner booking"}
    store.save(updated)

    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["runbooks"] == [updated]


def test_concurrent_processes_do_not_lose_writes(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    context = multiprocessing.get_context("spawn")
    processes = [
        context.Process(target=_save_numbered_runbook, args=(str(path), number))
        for number in range(12)
    ]

    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)

    assert [process.exitcode for process in processes] == [0] * len(processes)
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["format_version"] == 1
    assert {item["id"] for item in document["runbooks"]} == {
        f"runbook-{number}" for number in range(12)
    }


@pytest.mark.parametrize(
    "contents",
    [
        "{not json",
        json.dumps({"format_version": 999, "runbooks": []}),
        json.dumps({"format_version": 1, "runbooks": "not-an-array"}),
        json.dumps({"format_version": 1, "runbooks": ["not-an-object"]}),
    ],
)
def test_corruption_fails_clearly_and_never_looks_like_a_miss(
    tmp_path: Path, contents: str
) -> None:
    path = tmp_path / "runbooks.json"
    path.write_text(contents, encoding="utf-8")

    with pytest.raises(RunbookStoreCorruptionError, match="runbook store"):
        JSONRunbookStore(path).lookup("anything")


def test_save_refuses_to_overwrite_a_corrupted_store(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    corrupt = "{still broken"
    path.write_text(corrupt, encoding="utf-8")

    with pytest.raises(RunbookStoreCorruptionError):
        JSONRunbookStore(path).save(RESTAURANT_RUNBOOK)
    assert path.read_text(encoding="utf-8") == corrupt


@pytest.mark.parametrize(
    "invalid",
    [
        [],
        {"bad": {1, 2}},
        {"bad": float("nan")},
        {"bad": ("tuple",)},
        {"bad": {1: "non-string key"}},
    ],
)
def test_save_rejects_non_json_runbooks(tmp_path: Path, invalid: object) -> None:
    with pytest.raises(RunbookValidationError):
        JSONRunbookStore(tmp_path / "runbooks.json").save(invalid)  # type: ignore[arg-type]


def test_failed_atomic_replace_leaves_existing_store_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import runbook_voice.runbook_store as module

    path = tmp_path / "runbooks.json"
    store = JSONRunbookStore(path)
    store.save(RESTAURANT_RUNBOOK)
    original = path.read_bytes()

    def fail_replace(source: object, destination: object) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(RunbookStoreError, match="simulated replace failure"):
        store.save({**RESTAURANT_RUNBOOK, "description": "changed"})
    assert path.read_bytes() == original
    assert list(tmp_path.glob(".runbooks.json.*.tmp")) == []


def test_legacy_top_level_array_is_read_and_migrated_on_save(tmp_path: Path) -> None:
    path = tmp_path / "runbooks.json"
    path.write_text(json.dumps([RESTAURANT_RUNBOOK]), encoding="utf-8")
    store = JSONRunbookStore(path)

    assert store.lookup("arrange restaurant dinner") == RESTAURANT_RUNBOOK
    store.save({"id": "weather", "name": "Check weather forecast"})
    assert json.loads(path.read_text(encoding="utf-8"))["format_version"] == 1


class _NeverMatcher:
    def match(self, utterance: str, runbooks: Sequence[Runbook]) -> None:
        return None


class _InventingMatcher:
    def match(self, utterance: str, runbooks: Sequence[Runbook]) -> Runbook:
        return {"id": "invented"}


def test_matcher_is_injectable_and_can_force_the_null_seam(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json", matcher=_NeverMatcher())
    store.save(RESTAURANT_RUNBOOK)

    assert store.lookup("reserve a table") is None


def test_matcher_cannot_return_an_unpersisted_runbook(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json", matcher=_InventingMatcher())
    store.save(RESTAURANT_RUNBOOK)

    with pytest.raises(RunbookStoreError, match="one of its candidate"):
        store.lookup("anything")


def test_deterministic_matcher_validates_threshold() -> None:
    with pytest.raises(ValueError, match="between 0 and 1"):
        DeterministicSemanticMatcher(threshold=1.1)


# A skill as the distiller now stores one: the values that became slots are
# stripped out of the remembered example, so all that is left is the intent.
LEARNED_SKILL: Runbook = {
    "id": "restaurant-reservation",
    "name": "Book a restaurant table",
    "version": "1",
    "description": "Book a restaurant table for dinner",
    "utterance_examples": ["book a table"],
    "slots": [],
    "steps": [],
}

# A hand-written runbook whose examples still carry one instance's values.  It
# is the harder shape to match: most of its words are values nobody will repeat.
BUNDLED_SKILL: Runbook = {
    "id": "book-restaurant-table",
    "name": "Book a restaurant table",
    "version": "1",
    "description": "Reserve or book a restaurant table for dinner",
    "utterance_examples": [
        "book me a table for two friday at seven",
        "get us a dinner reservation saturday night",
        "reserve somewhere italian for four people tomorrow at eight",
    ],
    "slots": [],
    "steps": [],
}

FLIGHT_SKILL: Runbook = {
    "id": "book-flight",
    "name": "Book a flight",
    "version": "1",
    "description": "Book an airline flight",
    "utterance_examples": ["book a flight"],
    "slots": [],
    "steps": [],
}

HAIRCUT_SKILL: Runbook = {
    "id": "book-haircut",
    "name": "Book a haircut",
    "version": "1",
    "description": "Book a haircut at a salon",
    "utterance_examples": ["book a haircut"],
    "slots": [],
    "steps": [],
}


REPHRASINGS = [
    # The live failure: transcription and fast typing misspell the one token
    # that carries the intent, and abbreviate the rest.
    "book me a japanese resturant on sunday for 4 pm",
    "book me an italian restuarant for 2 tmmrw at 7pm",
    "reserve a restuarant table tomorrow",
    "book a restraunt for sunday",
    "make me a resevation somewhere italian",
    # Abbreviated values.
    "book a table tmrw 7pm for 4",
    # Different slot values from the ones the skill was learned on.
    "book a japanese restaurant on saturday",
    # Same words, different order, with the request's own filler.
    "for 4 people on sunday, a japanese restaurant reservation",
    # Synonyms, which already worked and must keep working.
    "Could you arrange a dinner reservation for me?",
    # More detail than the skill remembers must not score worse than less.
    "Book a table for two at an Italian restaurant in San Francisco"
    " tomorrow evening at seven.",
]

UNRELATED = [
    "get me a haircut",
    "deploy the website",
    "what's the weather",
    "book me a flight to tokyo tomorrow",
    "book me an uber to the airport",
    "reserve a hotel room for tomorrow",
    "Summarize this quarterly report",
    # Values with no intent attached are not a request to replay anything.
    "sunday at 7pm for four",
]


@pytest.mark.parametrize("skill", [LEARNED_SKILL, BUNDLED_SKILL], ids=["learned", "bundled"])
@pytest.mark.parametrize("utterance", REPHRASINGS)
def test_realistic_rephrasings_reach_the_learned_skill(
    tmp_path: Path, skill: Runbook, utterance: str
) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(skill)

    assert store.lookup(utterance) == skill


@pytest.mark.parametrize("skill", [LEARNED_SKILL, BUNDLED_SKILL], ids=["learned", "bundled"])
@pytest.mark.parametrize("utterance", UNRELATED)
def test_unrelated_requests_still_take_the_cold_path(
    tmp_path: Path, skill: Runbook, utterance: str
) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    store.save(skill)

    assert store.lookup(utterance) is None


def test_extra_detail_never_scores_worse_than_the_bare_intent() -> None:
    """Adding the details a request would really carry must not cost recall.

    Coverage used to divide by the shorter side, so every word a request added
    diluted it: "book a table" matched, and the same request with a cuisine and
    a day attached fell under the threshold.  A longer, more specific request is
    the normal case, not a degraded one.
    """
    matcher = DeterministicSemanticMatcher()
    growing = [
        "book a table",
        "book a japanese table",
        "book a japanese restaurant table on sunday",
        "book a japanese restaurant table on sunday at 4 pm for 6 people",
    ]

    for utterance in growing:
        assert matcher.match(utterance, [LEARNED_SKILL]) is LEARNED_SKILL


def test_each_skill_wins_its_own_request_when_several_are_stored(
    tmp_path: Path,
) -> None:
    store = JSONRunbookStore(tmp_path / "runbooks.json")
    for skill in (LEARNED_SKILL, FLIGHT_SKILL, HAIRCUT_SKILL):
        store.save(skill)

    assert store.lookup("book me a japanese resturant on sunday")["id"] == (
        "restaurant-reservation"
    )
    assert store.lookup("book me a flight to tokyo tomorrow")["id"] == "book-flight"
    assert store.lookup("book me a haircut on friday")["id"] == "book-haircut"
    assert store.lookup("deploy the website") is None


@pytest.mark.parametrize(
    "utterance",
    [
        # One edit from "table", but it is its own word.
        "fix my cable",
        # One edit from "book", likewise.
        "please look at my calendar",
        "i took the kids to school",
        # One edit from "flight", but slips do not land on the first letter.
        "there was a slight delay",
    ],
)
def test_lookalike_words_are_not_treated_as_slips(utterance: str) -> None:
    """Tolerating misspellings must not start inventing intent from real words."""
    matcher = DeterministicSemanticMatcher()

    assert matcher.match(utterance, [LEARNED_SKILL, FLIGHT_SKILL]) is None


def test_matching_is_deterministic_and_order_independent() -> None:
    matcher = DeterministicSemanticMatcher()
    utterance = "book me a japanese resturant on sunday for 4 pm"
    forward = [LEARNED_SKILL, FLIGHT_SKILL, HAIRCUT_SKILL]

    first = matcher.match(utterance, forward)
    assert first is LEARNED_SKILL
    assert matcher.match(utterance, list(reversed(forward))) is LEARNED_SKILL
    assert matcher.match(utterance, forward) is first
