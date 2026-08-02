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
