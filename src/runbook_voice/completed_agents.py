"""Catalog and safely replay completed runbook agents for the Branch console."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from .booking_bridge import NodeBookingRunner
from .executor import ConfirmationRequest, RunbookExecutor
from .runbook_store import DeterministicSemanticMatcher, JSONRunbookStore
from .runbooks import Runbook, RunbookSchemaError, SlotResolutionError


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STORE = ROOT / "demo" / "runbook-store.json"
BOOKING_STORE = ROOT / "runs" / "agent-bookings.json"
_NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}


@dataclass(frozen=True, slots=True)
class CompletedAgent:
    runbook: Runbook
    match_document: Mapping[str, Any]
    source: str
    origin: str
    completed_at: str

    def to_dict(self) -> dict[str, Any]:
        document = self.runbook.to_dict()
        return {
            "id": self.runbook.id,
            "name": self.runbook.name,
            "description": self.runbook.description,
            "version": self.runbook.version,
            "source": self.source,
            "origin": self.origin,
            "completed_at": self.completed_at,
            "slot_count": len(self.runbook.slots),
            "step_count": len(self.runbook.steps),
            "has_irreversible_steps": any(step.irreversible for step in self.runbook.steps),
            "runbook": document,
        }


def list_completed_agents(
    *, root: Path = ROOT, store_path: Path | None = None
) -> list[CompletedAgent]:
    """Discover validated learned and bundled runbooks, deduplicated by id."""

    store_path = store_path or root / "demo" / "runbook-store.json"
    by_id: dict[str, CompletedAgent] = {}
    artifact_patterns = (
        "demo/handwritten_runbook.json",
        "demo/cold-capture/synthesized_runbook.json",
        "runs/*runbook*.json",
        "runs/generated/*.json",
    )
    for pattern in artifact_patterns:
        for artifact in sorted(root.glob(pattern)):
            agent = _agent_from_path(artifact, root=root)
            if agent is not None:
                by_id[agent.runbook.id] = agent

    if store_path.exists():
        completed_at = _timestamp(store_path)
        for document in JSONRunbookStore(store_path).list():
            try:
                runbook = Runbook.from_dict(document)
            except (RunbookSchemaError, SlotResolutionError, TypeError, AttributeError):
                continue
            by_id[runbook.id] = CompletedAgent(
                runbook=runbook,
                match_document=document,
                source="learned store",
                origin=str(store_path.relative_to(root)),
                completed_at=completed_at,
            )

    return sorted(
        by_id.values(),
        key=lambda agent: (agent.runbook.name.casefold(), agent.runbook.id),
    )


def match_completed_agent(
    utterance: str, agents: Sequence[CompletedAgent]
) -> CompletedAgent | None:
    documents = [dict(agent.match_document) for agent in agents]
    selected = DeterministicSemanticMatcher().match(utterance, documents)
    if selected is None:
        return None
    identity = selected.get("id")
    return next((agent for agent in agents if agent.runbook.id == identity), None)


def suggested_slot_values(agent: CompletedAgent, utterance: str) -> dict[str, Any]:
    """Recover typed slot examples when the request actually contains them.

    Distilled runbooks retain examples from the successful trajectory. Reusing
    those values is deterministic and avoids another model call, while the
    containment check prevents an unrelated example from being silently used.
    """

    raw_slots = agent.match_document.get("slots", [])
    if not isinstance(raw_slots, list):
        raw_slots = []
    examples = {
        item.get("name"): item.get("example")
        for item in raw_slots
        if isinstance(item, Mapping) and isinstance(item.get("name"), str)
    }
    normalized = " ".join(utterance.casefold().split())
    values: dict[str, Any] = {}
    for slot in agent.runbook.slots:
        if slot.has_default:
            continue
        example = examples.get(slot.name)
        if example is None:
            continue
        phrase = " ".join(str(example).casefold().split())
        try:
            if slot.type.value == "integer":
                party_match = re.search(
                    r"\b(?:for|party\s+of)\s+(\d+|" + "|".join(_NUMBER_WORDS) + r")\b",
                    normalized,
                )
                candidate = party_match.group(1) if party_match else phrase if phrase in normalized else ""
                value = _NUMBER_WORDS.get(
                    candidate,
                    int(candidate) if candidate.lstrip("+-").isdigit() else None,
                )
            elif slot.type.value == "number":
                if phrase not in normalized:
                    continue
                value = float(phrase)
            elif slot.type.value == "boolean":
                if phrase not in normalized:
                    continue
                value = phrase in {"1", "true", "yes", "on"}
            elif slot.type.value in {"object", "array"}:
                if phrase not in normalized:
                    continue
                value = json.loads(str(example))
            else:
                value = _string_slot_value(slot.name, str(example), normalized)
            if value is None:
                continue
            slot.validate(value)
        except (ValueError, TypeError, json.JSONDecodeError, SlotResolutionError):
            continue
        values[slot.name] = value
    return values


def _string_slot_value(name: str, example: str, utterance: str) -> str | None:
    phrase = " ".join(example.casefold().split())
    if phrase in utterance:
        return example
    if name.casefold() == "date":
        match = re.search(
            r"\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b",
            utterance,
        )
        return match.group(1) if match else None
    if name.casefold() == "time":
        words = "|".join(key for key in _NUMBER_WORDS if key != "zero")
        match = re.search(
            rf"\b(?:at|around)\s+((?:\d{{1,2}}(?::\d{{2}})?|{words})(?:\s*[ap]\.?m\.?)?)\b",
            utterance,
        )
        return match.group(1) if match else None
    if name.casefold() in {"city", "location"}:
        match = re.search(
            r"\bin\s+([a-z][a-z .'-]*?)(?=\s+(?:today|tomorrow|tonight|on|at|for)\b|[,.;]|$)",
            utterance,
        )
        return match.group(1).strip().title() if match else None
    return None


def missing_required_slots(agent: CompletedAgent, values: Mapping[str, Any]) -> list[str]:
    return [
        slot.name
        for slot in agent.runbook.slots
        if slot.required and not slot.has_default and slot.name not in values
    ]


def _agent_from_path(path: Path, *, root: Path) -> CompletedAgent | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        runbook = Runbook.from_dict(payload)
    except (
        OSError,
        json.JSONDecodeError,
        RunbookSchemaError,
        SlotResolutionError,
        TypeError,
        AttributeError,
    ):
        return None
    return CompletedAgent(
        runbook=runbook,
        match_document=payload,
        source="bundled" if path.name == "handwritten_runbook.json" else "distilled artifact",
        origin=str(path.relative_to(root)),
        completed_at=_timestamp(path),
    )


def _timestamp(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


class _ExplicitConfirmationGate:
    def __init__(self, approved: bool) -> None:
        self._approved = approved

    async def confirm(self, request: ConfirmationRequest) -> bool:
        print(f"CONFIRMATION {request.prompt}", flush=True)
        return self._approved


async def replay_completed_agent(
    agent: CompletedAgent,
    slots: Mapping[str, Any],
    *,
    confirmed: bool,
) -> dict[str, Any]:
    """Execute a saved runbook once in safe local stub mode."""

    runner = NodeBookingRunner(
        stub=True,
        confirmation_is_upstream=True,
        store_path=BOOKING_STORE,
    )
    result = await RunbookExecutor(
        runner,
        _ExplicitConfirmationGate(confirmed),
    ).execute(agent.runbook, slots)
    return {
        "agent_id": agent.runbook.id,
        "agent_name": agent.runbook.name,
        "status": result.status.value,
        "mode": "safe_stub",
        "steps": [
            {
                "step_id": step.step_id,
                "action": step.action,
                "status": step.status.value,
                "arguments": dict(step.resolved_arguments),
                "output": step.output,
                "error": step.error,
            }
            for step in result.steps
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="runbook-completed-agents")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list")
    match = subparsers.add_parser("match")
    match.add_argument("utterance")
    run = subparsers.add_parser("run")
    run.add_argument("--id", required=True)
    run.add_argument("--slots-json", default="{}")
    run.add_argument("--confirm", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    agents = list_completed_agents()
    if args.command == "list":
        print("AGENTS_JSON " + json.dumps({"agents": [agent.to_dict() for agent in agents]}))
        return 0
    if args.command == "match":
        agent = match_completed_agent(args.utterance, agents)
        slots = suggested_slot_values(agent, args.utterance) if agent else {}
        print(
            "AGENT_MATCH "
            + json.dumps(
                {
                    "matched": agent is not None,
                    "agent": agent.to_dict() if agent else None,
                    "slots": slots,
                    "missing_slots": missing_required_slots(agent, slots) if agent else [],
                }
            )
        )
        return 0

    agent = next((item for item in agents if item.runbook.id == args.id), None)
    if agent is None:
        raise SystemExit(f"completed agent {args.id!r} was not found")
    try:
        slots = json.loads(args.slots_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"slots must be valid JSON: {exc}") from exc
    if not isinstance(slots, dict):
        raise SystemExit("slots must be a JSON object")
    print(f"REUSING_AGENT {agent.runbook.id} — no branch search launched", flush=True)
    result = asyncio.run(replay_completed_agent(agent, slots, confirmed=args.confirm))
    print("AGENT_REPLAY " + json.dumps(result), flush=True)
    return 0 if result["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CompletedAgent",
    "list_completed_agents",
    "main",
    "match_completed_agent",
    "missing_required_slots",
    "replay_completed_agent",
    "suggested_slot_values",
]
