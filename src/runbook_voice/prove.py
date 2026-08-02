"""TON-25: the demo, in one command. Ask cold, ask again, show the gap.

    runbook-demo prove             real branching search (boots Sailboxes, minutes)
    runbook-demo prove --recorded  same chain over recorded trajectories, seconds

The proof is a *measured* contrast, not a vibe. Both halves run back to back
from a genuinely empty store, and both are timed, because "cold once, instant
after" is the entire pitch and an audience that isn't told the first ask took
four minutes just sees a fast assistant.

What makes the cold run genuinely cold is that the store starts empty and the
warm lookup uses a REPHRASED request. A cold run against a pre-seeded store, or
a warm run that replays the identical string, proves nothing.

``--recorded`` swaps only the branching search for fixture trajectories. Judge,
distiller, store, matcher and executor are the real ones, so the chain under
test is the same — it just costs seconds instead of boxes. Use it to prove the
harness; use the real one to prove the system.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .booking_bridge import NodeBookingRunner
from .distiller import DistillationError, distill
from .executor import RunbookExecutor
from .judge import JudgeError, PairwiseJudge, SailJudgeModel, longest_successful_branch
from .runbook_store import JSONRunbookStore
from .runbooks import Runbook

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "trajectories"
STORE = ROOT / "demo" / "proof-store.json"
BOOKINGS = ROOT / "demo" / "proof-bookings.json"

COLD_REQUEST = "Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven."
WARM_REQUEST = "Reserve an Italian restaurant table in San Francisco tomorrow evening for two at seven."


class _AlwaysConfirm:
    """Stands in for the spoken gate. The gate itself is proven by TON-12/TON-18."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def confirm(self, request) -> bool:
        self.prompts.append(request.prompt)
        return True


# The values a caller would supply for the warm ask. Keyed by slot name because
# the distiller decides which slots exist — filling every string slot with one
# value puts "time: Italian" on the projector.
WARM_SLOT_VALUES: dict[str, Any] = {
    "party_size": 2,
    "cuisine": "Italian",
    "city": "San Francisco",
    "date": "tomorrow",
    "time": "7:00 PM",
}


def _slots_for(runbook: Runbook) -> dict[str, Any]:
    """Supply each declared slot, preferring its own example over a guess."""
    values: dict[str, Any] = {}
    for slot in runbook.slots:
        if slot.name in WARM_SLOT_VALUES:
            values[slot.name] = WARM_SLOT_VALUES[slot.name]
        elif slot.type.value == "integer":
            values[slot.name] = 2
        else:
            # Better a visibly generic value than a plausible wrong one.
            values[slot.name] = f"<{slot.name}>"
    return values


def _load_recorded() -> list[dict[str, Any]]:
    trajectories = [json.loads(p.read_text()) for p in sorted(FIXTURES.glob("*.json"))]
    if not trajectories:
        raise SystemExit(f"no recorded trajectories in {FIXTURES}")
    return trajectories


async def _search_live(request: str, app: str) -> list[dict[str, Any]]:
    from .branch_search import BranchingSearch

    search = BranchingSearch(app=app, progress=lambda m: print(f"    {m}"))
    trajectories = await search.search(request, job_id="ton25-proof")
    return [t.to_dict() for t in trajectories]


def _pick_winner(trajectories: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    """Judge the branches, falling back to the documented heuristic if it errors.

    TON-19 specifies that fallback: worse, but honest, and it keeps the demo
    alive rather than dying on a judge outage in front of an audience.
    """
    try:
        verdict = PairwiseJudge(SailJudgeModel()).pick(trajectories)
        winner_id, why = verdict.winner, verdict.reason
    except (JudgeError, Exception) as exc:  # noqa: BLE001 - any judge failure falls back
        winner_id = longest_successful_branch(trajectories)
        why = f"judge unavailable ({type(exc).__name__}), fell back to longest successful branch"
    winner = next(t for t in trajectories if t["branch_id"] == winner_id)
    return winner, why


async def prove(args) -> int:
    STORE.unlink(missing_ok=True)
    BOOKINGS.unlink(missing_ok=True)
    store = JSONRunbookStore(STORE)

    runner = NodeBookingRunner(
        stub=not args.live, confirmation_is_upstream=True, store_path=BOOKINGS
    )
    gate = _AlwaysConfirm()
    executor = RunbookExecutor(runner, gate)

    mode = "LIVE — this books for real" if args.live else "STUB — nothing will be booked"
    print(f"\n=== {mode} ===")
    print(f"store: empty ({STORE.name} removed) — the cold run is genuinely cold\n")

    # ---- COLD ---------------------------------------------------------------
    print(f'COLD  ask: "{COLD_REQUEST}"')
    if store.lookup(COLD_REQUEST) is not None:
        print("  !! store was not empty; the cold run would be fake")
        return 1
    print("  no runbook matches — falling back to branching search")

    cold_start = time.perf_counter()
    if args.recorded:
        print("  [recorded] using fixture trajectories instead of live boxes")
        trajectories = _load_recorded()
    else:
        trajectories = await _search_live(COLD_REQUEST, args.app)
    print(f"  {len(trajectories)} branches: {[t['branch_id'] for t in trajectories]}")

    winner, why = _pick_winner(trajectories)
    print(f"  winner: {winner['branch_id']} — {why}")

    try:
        document = distill(winner)
    except DistillationError as exc:
        print(f"  distillation failed: {exc}")
        return 1
    store.save(document)
    print(f"  distilled -> {document['id']} ({len(document['steps'])} steps), saved to store")
    cold_seconds = time.perf_counter() - cold_start

    # ---- WARM ---------------------------------------------------------------
    # A different phrasing on purpose: replaying the identical string would only
    # prove string equality, not that the runbook generalized.
    print(f'\nWARM  ask: "{WARM_REQUEST}"')
    warm_start = time.perf_counter()
    matched = store.lookup(WARM_REQUEST)
    if matched is None:
        print("  !! no match — the distilled runbook is not retrievable by a rephrasing")
        return 1
    print(f"  matched {matched['id']} from a rephrased request")

    runbook = Runbook.from_dict(matched)
    slots = _slots_for(runbook)
    result = await executor.execute(runbook, slots)
    warm_seconds = time.perf_counter() - warm_start

    for prompt in gate.prompts:
        print(f'  confirm: "{prompt}"')
    for step in result.steps:
        print(f"  {step.action:20} {step.status.value:11} {step.output or step.error or ''}")
    if not result.succeeded:
        print("  !! warm replay failed")
        return 1

    # ---- THE NUMBER ---------------------------------------------------------
    speedup = cold_seconds / warm_seconds if warm_seconds else float("inf")
    print("\n" + "=" * 58)
    print(f"  COLD  {cold_seconds:8.1f}s   branching search, judge, distill")
    print(f"  WARM  {warm_seconds:8.1f}s   lookup and replay")
    print(f"  {speedup:>10.0f}x   same request, nothing changed but the cache")
    print("=" * 58)
    if args.recorded:
        print("  (--recorded: cold half used fixtures, so the gap is a floor, not the real one)")
    print(f"=== {mode} ===")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="runbook-demo prove", description="TON-25: cold once, instant after."
    )
    parser.add_argument("--recorded", action="store_true",
                        help="use fixture trajectories instead of booting Sailboxes")
    parser.add_argument("--live", action="store_true", help="BOOK FOR REAL (default: stub)")
    parser.add_argument("--app", default="branch-proof", help="Sail app namespace")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(prove(build_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
