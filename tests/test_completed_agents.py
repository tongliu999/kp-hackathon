from __future__ import annotations

import json
from pathlib import Path

import pytest

from runbook_voice.completed_agents import (
    list_completed_agents,
    match_completed_agent,
    missing_required_slots,
    replay_completed_agent,
    suggested_slot_values,
)
from runbook_voice.executor import ExecutionStatus
from runbook_voice.runbook_store import JSONRunbookStore


RUNBOOK = {
    "id": "restaurant-reservation",
    "name": "Book a restaurant table",
    "version": "1",
    "description": "Reserve a restaurant table for dinner",
    "slots": [
        {"name": "party_size", "type": "integer", "required": True},
        {"name": "city", "type": "string", "required": True},
    ],
    "steps": [
        {
            "id": "search",
            "action": "restaurant.search",
            "arguments": {"party_size": "{{party_size}}", "city": "{{city}}"},
            "irreversible": False,
        }
    ],
}


def test_catalog_validates_artifacts_and_prefers_learned_store(tmp_path: Path) -> None:
    artifact = tmp_path / "demo" / "handwritten_runbook.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(json.dumps(RUNBOOK), encoding="utf-8")
    store_path = tmp_path / "demo" / "runbook-store.json"
    JSONRunbookStore(store_path).save({**RUNBOOK, "name": "Learned dinner agent"})

    agents = list_completed_agents(root=tmp_path, store_path=store_path)

    assert len(agents) == 1
    assert agents[0].runbook.name == "Learned dinner agent"
    assert agents[0].source == "learned store"
    assert agents[0].to_dict()["step_count"] == 1


def test_same_intent_matches_completed_agent_but_unrelated_prompt_misses(tmp_path: Path) -> None:
    artifact = tmp_path / "demo" / "handwritten_runbook.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(json.dumps(RUNBOOK), encoding="utf-8")
    agents = list_completed_agents(root=tmp_path)

    assert match_completed_agent("Arrange dinner reservations for two", agents) is agents[0]
    assert match_completed_agent("Summarize this quarterly report", agents) is None


def test_match_recovers_spoken_slot_values_without_inventing_missing_values(tmp_path: Path) -> None:
    artifact = tmp_path / "demo" / "handwritten_runbook.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(
        json.dumps(
            {
                **RUNBOOK,
                "slots": [
                    {**RUNBOOK["slots"][0], "example": "2"},
                    {**RUNBOOK["slots"][1], "example": "San Francisco"},
                ],
            }
        ),
        encoding="utf-8",
    )
    agent = list_completed_agents(root=tmp_path)[0]

    values = suggested_slot_values(agent, "Book dinner in San Francisco tomorrow for two")

    assert values == {"party_size": 2, "city": "San Francisco"}
    assert missing_required_slots(agent, values) == []


def test_match_keeps_required_slot_missing_when_prompt_does_not_contain_it(tmp_path: Path) -> None:
    artifact = tmp_path / "demo" / "handwritten_runbook.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(
        json.dumps(
            {
                **RUNBOOK,
                "slots": [
                    {**RUNBOOK["slots"][0], "example": "2"},
                    {**RUNBOOK["slots"][1], "example": "San Francisco"},
                ],
            }
        ),
        encoding="utf-8",
    )
    agent = list_completed_agents(root=tmp_path)[0]

    values = suggested_slot_values(agent, "Book dinner for two")

    assert values == {"party_size": 2}
    assert missing_required_slots(agent, values) == ["city"]


@pytest.mark.asyncio
async def test_replay_uses_runbook_executor_without_branch_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = tmp_path / "demo" / "handwritten_runbook.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(json.dumps(RUNBOOK), encoding="utf-8")
    agent = list_completed_agents(root=tmp_path)[0]
    calls: list[tuple[str, dict]] = []

    class FakeRunner:
        def __init__(self, **_: object) -> None:
            pass

        async def execute(self, action: str, arguments: dict) -> dict:
            calls.append((action, dict(arguments)))
            return {"ok": True}

    monkeypatch.setattr("runbook_voice.completed_agents.NodeBookingRunner", FakeRunner)
    result = await replay_completed_agent(
        agent,
        {"party_size": 2, "city": "San Francisco"},
        confirmed=False,
    )

    assert result["status"] == ExecutionStatus.SUCCEEDED.value
    assert result["mode"] == "safe_stub"
    assert calls == [("restaurant.search", {"party_size": 2, "city": "San Francisco"})]
