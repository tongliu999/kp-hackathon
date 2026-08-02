"""The assistant itself: always on, decides warm or cold, learns while you talk.

    runbook-demo assistant             real branching search on a miss (minutes)
    runbook-demo assistant --recorded  fixture trajectories on a miss (seconds)

Every piece of this already existed — the store decides warm vs cold, the
coordinator acknowledges and notifies, the branching search satisfies
ColdTaskWorker, the distiller turns a winner into a runbook. What did not exist
was a session that holds them together, which is why the project had three
scripts instead of an assistant.

The loop:

    you ask something
      -> store has a runbook  -> fill slots, confirm, execute        (instant)
      -> store has nothing    -> "I'll get back to you", keep listening
                                 ... branches run, judge picks, distiller writes
                                 ... the runbook is INSTALLED into the store
                                 -> it interrupts to say it learned the task

    ask the same thing again  -> now it is warm

That last transition is the demo. Nothing changed but the cache, and the
audience watches the cache fill in real time rather than being told about it.

The prompt stays live while a cold task runs. That is the point of TON-14: the
conversation is released, not blocked, so you can keep talking to an assistant
that is thinking in the background.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol

from .booking_bridge import NodeBookingRunner
from .cold_tasks import ColdTaskCoordinator, NotificationKind
from .distiller import DistillationError, distill
from .executor import RunbookExecutor
from .judge import JudgeError, PairwiseJudge, SailJudgeModel, longest_successful_branch
from .runbook_store import JSONRunbookStore
from .runbooks import Runbook

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "trajectories"
STORE = ROOT / "demo" / "assistant-store.json"
BOOKINGS = ROOT / "demo" / "assistant-bookings.json"

SLOT_VALUES: dict[str, Any] = {
    "party_size": 2,
    "cuisine": "Italian",
    "city": "San Francisco",
    "date": "tomorrow",
    "time": "7:00 PM",
}


def say(text: str) -> None:
    print(f"\n  ai  > {text}\n", flush=True)


class ConsoleNotifier:
    """Speaks acknowledgements and results. Interrupts the prompt on purpose."""

    async def notify(self, job_id: str, text: str, kind: NotificationKind) -> None:
        say(text if kind is NotificationKind.ACKNOWLEDGEMENT else f"\a{text}")


class LearningWorker:
    """The cold path, ending in a runbook installed into the store.

    ColdTaskWorker returns a spoken summary. The important side effect is the
    save: without it the assistant would answer the question once and be exactly
    as slow the next time, which is the thing this project exists to fix.
    """

    def __init__(self, store: JSONRunbookStore, *, recorded: bool, app: str) -> None:
        self._store = store
        self._recorded = recorded
        self._app = app
        self.last_seconds: float | None = None
        # Set by the session to the moment YOU asked, so the reported figure is
        # time-to-answer rather than time-inside-the-worker. Those differ by the
        # acknowledgement round trip, and time-to-answer is what an audience feels.
        self.answer_clock: float | None = None

    async def run(self, request: str, job_id: str) -> str:
        started = time.perf_counter()

        if self._recorded:
            trajectories = [json.loads(p.read_text()) for p in sorted(FIXTURES.glob("*.json"))]
        else:
            from .branch_search import BranchingSearch

            search = BranchingSearch(app=self._app, progress=lambda m: print(f"      {m}"))
            trajectories = [t.to_dict() for t in await search.search(request, job_id)]

        winner, why = _pick_winner(trajectories)
        try:
            document = distill(winner)
        except DistillationError as exc:
            self.last_seconds = time.perf_counter() - started
            return f"I tried {len(trajectories)} approaches but could not turn any into a repeatable skill: {exc}"

        self._store.save(document)
        self.last_seconds = time.perf_counter() - (self.answer_clock or started)
        return (
            f"I worked out how to do that — tried {len(trajectories)} approaches and kept "
            f"{winner['branch_id']} because {why[:120].rstrip('.')}. "
            f"I've saved it as a skill, so ask me again and it'll be instant. "
            f"[answer took {self.last_seconds:.1f}s]"
        )


def _pick_winner(trajectories: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    """Judge the branches, falling back to TON-19's documented heuristic."""
    try:
        verdict = PairwiseJudge(SailJudgeModel()).pick(trajectories)
        winner_id, why = verdict.winner, verdict.reason
    except (JudgeError, Exception) as exc:  # noqa: BLE001 — any judge failure falls back
        winner_id = longest_successful_branch(trajectories)
        why = f"the judge was unavailable ({type(exc).__name__}) so I took the longest successful run"
    return next(t for t in trajectories if t["branch_id"] == winner_id), why


class _Stopwatch(Protocol):
    """Whatever is holding the confirmation gate's accumulated wait."""

    waited: float


async def _replay(executor: RunbookExecutor, matched, gate: _Stopwatch) -> float:
    """Replay a known runbook and return the time the MACHINE spent.

    The human's thinking time at the confirmation gate is subtracted. Counting it
    would make the warm number depend on how fast someone says "yes", and the
    contrast this whole project rests on is machine work versus machine work.
    """
    runbook = Runbook.from_dict(matched)
    slots = {
        s.name: SLOT_VALUES.get(s.name, 2 if s.type.value == "integer" else f"<{s.name}>")
        for s in runbook.slots
    }
    gate.waited = 0.0
    started = time.perf_counter()
    result = await executor.execute(runbook, slots)
    elapsed = time.perf_counter() - started - gate.waited

    for step in result.steps:
        print(f"      {step.action:20} {step.status.value:11} {step.output or step.error or ''}")
    return max(elapsed, 0.0)


async def session(args) -> int:
    if args.fresh:
        STORE.unlink(missing_ok=True)
        BOOKINGS.unlink(missing_ok=True)

    store = JSONRunbookStore(STORE)
    gate_prompts: list[str] = []

    class Gate:
        """The spoken confirm gate, and a stopwatch for how long the human took."""

        waited: float = 0.0

        async def confirm(self, request) -> bool:
            gate_prompts.append(request.prompt)
            print(f"\n  ai  > {request.prompt}")
            asked = time.perf_counter()
            reply = await asyncio.to_thread(input, "  you > ")
            Gate.waited += time.perf_counter() - asked
            return reply.strip().casefold() in {"yes", "y", "yes book it", "yes, book it"}

    gate = Gate()
    executor = RunbookExecutor(
        NodeBookingRunner(stub=not args.live, confirmation_is_upstream=True, store_path=BOOKINGS),
        gate,
    )
    worker = LearningWorker(store, recorded=args.recorded, app=args.app)
    coordinator = ColdTaskCoordinator(worker, ConsoleNotifier())

    mode = "LIVE — bookings are real" if args.live else "STUB — nothing will be booked"
    print(f"\n=== assistant ready · {mode} ===")
    print("  ask for something. ctrl-c or 'quit' to stop.")
    print(f"  skills on disk: {STORE.name}"
          f"{' (cleared)' if args.fresh else ''}\n")

    try:
        while True:
            try:
                utterance = (await asyncio.to_thread(input, "  you > ")).strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not utterance:
                continue
            if utterance.casefold() in {"quit", "exit"}:
                break

            asked_at = time.perf_counter()
            matched = store.lookup(utterance)
            if matched is None:
                # Released, not blocked: submit_no_match returns as soon as the
                # acknowledgement is spoken, so the prompt comes straight back.
                worker.answer_clock = asked_at
                await coordinator.submit_no_match(utterance)
                continue

            say(f"I already know how to do that — {matched['id']}. Doing it now.")
            elapsed = await _replay(executor, matched, gate)
            cold = worker.last_seconds
            print(f"\n      answered in {elapsed:.1f}s"
                  + (f"  — the first time you asked, it took {cold:.1f}s. "
                     f"{cold / elapsed:.0f}x faster, nothing changed but the cache."
                     if cold else "")
                  + "\n      (machine time; the pause was you confirming)\n")
    finally:
        # Do not cancel: a cold task still running has boxes booted and a judge
        # call in flight, and killing it mid-flight leaks both.
        await coordinator.close(cancel_pending=False)

    print("\n  bye.\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="runbook-demo assistant", description="Always-on assistant: warm if known, learn if not."
    )
    parser.add_argument("--recorded", action="store_true",
                        help="use fixture trajectories on a miss instead of booting Sailboxes")
    parser.add_argument("--live", action="store_true", help="BOOK FOR REAL (default: stub)")
    parser.add_argument("--fresh", action="store_true", help="forget every learned skill first")
    parser.add_argument("--app", default="assistant", help="Sail app namespace")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(session(build_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
