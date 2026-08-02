"""One command to drive the demo, so nobody picks a window under stage adrenaline.

    runbook-demo check     everything that must be true before we present
    runbook-demo warm      the live warm run: request -> confirm -> booking
    runbook-demo prove     TON-25: cold once, instant after — the demo
    runbook-demo reset     cancel every open booking

Two deliberate choices, both about not booking something by accident:

* ``warm`` is STUB unless you pass ``--live``. The safe thing is the default and
  the dangerous thing is typed out loud.
* Every run prints its mode as the first and last line. TON-16 already makes stub
  bookings say so in the logs; this makes it impossible to miss on a projector.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path

from .booking_bridge import BookingBridgeError, NodeBookingRunner
from .dialogue import SlotFillingDialogue
from .executor import RunbookExecutor
from .m1_demo import ExactYesConfirmationGate, M1WarmPath, WarmPathStatus
from .runbook_store import JSONRunbookStore

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "demo" / "demo_config.json"
RUNBOOK = ROOT / "demo" / "handwritten_runbook.json"
STORE = ROOT / "demo" / "runbook-store.json"
BOOKINGS = ROOT / "demo" / "bookings.json"

OK, BAD, WARN = "  ok  ", " FAIL ", " warn "


class TextIn:
    """Typed input. The documented stage pivot when room audio fails."""

    def __init__(self, *scripted: str) -> None:
        self._scripted = list(scripted)

    def listen(self) -> str:
        if self._scripted:
            value = self._scripted.pop(0)
            print(f"  you > {value}")
            return value
        return input("  you > ")

    async def alisten(self) -> str:
        return self.listen()


class TextOut:
    def say(self, text: str) -> None:
        print(f"  ai  > {text}")

    async def asay(self, text: str) -> None:
        self.say(text)


class _AsyncAdapter:
    """m1_demo's gate wants async listen/say; the text adapters are sync."""

    def __init__(self, inner) -> None:
        self._inner = inner

    async def listen(self) -> str:
        return self._inner.listen()

    async def say(self, text: str) -> None:
        self._inner.say(text)


def _load_config() -> dict:
    return json.loads(CONFIG.read_text())


def _check(label: str, ok: bool, detail: str = "", *, fatal: bool = True) -> bool:
    print(f"[{OK if ok else (BAD if fatal else WARN)}] {label}" + (f" — {detail}" if detail else ""))
    return ok or not fatal


def check(_args) -> int:
    """Everything that must be true before presenting. Exit 1 if it isn't."""
    print("preflight\n")
    results = []

    for name in ("OPENAI_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID"):
        results.append(_check(f"env {name}", bool(os.environ.get(name)), fatal=False))

    sail_auth = Path.home() / ".sail" / "auth.toml"
    results.append(
        _check("sail auth", sail_auth.exists() or bool(os.environ.get("SAIL_API_KEY")),
               str(sail_auth) if sail_auth.exists() else "run: sail auth login")
    )
    results.append(_check("node", shutil.which("node") is not None, "needed by the booking bridge"))

    # Actually invoke the bridge rather than checking that files exist. This is
    # the seam between Python and JavaScript; "the .mjs is on disk" proves
    # nothing about whether it runs.
    # Probe in stub mode: the question is "does the Python/JavaScript seam work",
    # which needs no Sailbox. Real-mode reachability is a separate concern and is
    # gated by BOOKING_SAILBOX below.
    try:
        open_refs = asyncio.run(
            NodeBookingRunner(stub=True, store_path=BOOKINGS).execute("booking.list_open", {})
        )
        results.append(_check("booking bridge responds", True,
                              f"{len(open_refs.get('open', []))} open booking(s)"))
    except BookingBridgeError as exc:
        results.append(_check("booking bridge responds", False, str(exc)))

    # Real bookings need an explicit opt-in to a named box. Absent it the bridge
    # refuses, which is correct - but it should be visible in preflight rather
    # than discovered at the moment someone runs --live.
    box = os.environ.get("BOOKING_SAILBOX")
    results.append(_check("BOOKING_SAILBOX — REQUIRED for --live", bool(box),
                          box or "unset: --live will refuse. Set BOOKING_SAILBOX=booking",
                          fatal=False))

    # Stub mode imports local files only, but real mode delegates into the
    # Sailbox over the Sail SDK — so a missing node_modules is invisible right up
    # until the one run that matters.
    results.append(_check("node_modules — REQUIRED for --live",
                          (ROOT / "node_modules").exists(), "run: npm install"))

    results.append(_check("demo config", CONFIG.exists()))
    results.append(_check("handwritten runbook", RUNBOOK.exists()))

    # The stage pivot depends on the exact utterance matching the store, so prove
    # the match here rather than discovering it in front of an audience.
    try:
        config = _load_config()
        store = JSONRunbookStore(STORE)
        store.save(json.loads(RUNBOOK.read_text()))
        matched = store.lookup(config["exact_spoken_request"]) is not None
        results.append(_check("exact spoken request matches a runbook", matched,
                              config["exact_spoken_request"][:58] + "..."))
        rephrased = store.lookup(config["warm_runbook_match_text"]) is not None
        results.append(_check("rephrased request also matches", rephrased,
                              "proves the matcher is semantic, not literal", fatal=False))
    except Exception as exc:  # a broken store must fail preflight, not the demo
        results.append(_check("runbook store", False, f"{type(exc).__name__}: {exc}"))

    video = next((p for p in (ROOT / "demo").glob("*.mp4")), None)
    results.append(_check("cold-path video", video is not None,
                          str(video.name) if video else "TON-23 — required, cold path is not run live",
                          fatal=False))

    stub_env = os.environ.get("BOOKING_STUB_MODE")
    results.append(_check("BOOKING_STUB_MODE not forced on", stub_env in (None, "", "0"),
                          f"currently {stub_env!r} — a real run would be silently faked"
                          if stub_env else "", fatal=False))

    ok = all(results)
    print("\n" + ("READY" if ok else "NOT READY — fix the FAIL rows above"))
    return 0 if ok else 1


async def _warm(live: bool, utterance: str | None, auto: bool) -> int:
    config = _load_config()
    utterance = utterance or config["exact_spoken_request"]

    store = JSONRunbookStore(STORE)
    store.save(json.loads(RUNBOOK.read_text()))

    # Scripted replies only in --auto; otherwise a human answers, including the
    # confirmation. Never script the confirmation for a live booking.
    slots = TextIn(*(["2", "Italian", "San Francisco", "tomorrow", "7 pm"] if auto else []))
    reply = config["confirmation_response"] if auto else None
    gate_in = _AsyncAdapter(TextIn(reply) if reply else TextIn())

    runner = NodeBookingRunner(
        stub=not live, confirmation_is_upstream=True, store_path=BOOKINGS
    )
    path = M1WarmPath(
        SlotFillingDialogue(store, slots, TextOut()),
        RunbookExecutor(runner, ExactYesConfirmationGate(gate_in, _AsyncAdapter(TextOut()))),
    )

    print(f"\n  request > {utterance}\n")
    outcome = await path.run(utterance)

    print()
    if outcome.execution:
        for step in outcome.execution.steps:
            print(f"  {step.action:22} {step.status.value:22} {step.output or step.error or ''}")
    print(f"\n  {outcome.status.value.upper()}")

    if outcome.status is WarmPathStatus.SUCCEEDED and live and outcome.execution:
        ref = (outcome.execution.steps[-1].output or {}).get("confirmation_id")
        print(f"\n  !! REAL BOOKING {ref} — cancel it: runbook-demo reset")
    return 0 if outcome.status is WarmPathStatus.SUCCEEDED else 1


def warm(args) -> int:
    mode = "LIVE — this books for real" if args.live else "STUB — nothing will be booked"
    print(f"\n=== {mode} ===")
    try:
        code = asyncio.run(_warm(args.live, args.request, args.auto))
    except BookingBridgeError as exc:
        print(f"\nbooking bridge: {exc}", file=sys.stderr)
        return 2
    print(f"=== {mode} ===")
    return code


def run_prove(args) -> int:
    """TON-25. Imported lazily: the proof pulls in the branching search, which
    reaches for a Sail key that `check` and `warm` have no need of."""
    from .prove import prove

    return asyncio.run(prove(args))


def reset(_args) -> int:
    runner = NodeBookingRunner(store_path=BOOKINGS)
    try:
        result = asyncio.run(runner.execute("booking.reset", {}))
    except BookingBridgeError as exc:
        print(f"reset failed: {exc}", file=sys.stderr)
        return 2
    cancelled = result.get("cancelled", [])
    print(f"cancelled {len(cancelled)} booking(s): {', '.join(cancelled) or 'none open'}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="runbook-demo", description="Drive the demo from one command."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="verify everything needed to present").set_defaults(fn=check)

    w = sub.add_parser("warm", help="the live warm run")
    w.add_argument("--live", action="store_true", help="BOOK FOR REAL (default: stub)")
    w.add_argument("--request", help="override the utterance from demo_config.json")
    w.add_argument("--auto", action="store_true", help="script slot answers; never for --live")
    w.set_defaults(fn=warm)

    p = sub.add_parser("prove", help="TON-25: cold once, instant after")
    p.add_argument("--recorded", action="store_true",
                   help="use fixture trajectories instead of booting Sailboxes")
    p.add_argument("--live", action="store_true", help="BOOK FOR REAL (default: stub)")
    p.add_argument("--app", default="branch-proof", help="Sail app namespace")
    p.set_defaults(fn=run_prove)

    sub.add_parser("reset", help="cancel every open booking").set_defaults(fn=reset)

    args = parser.parse_args(argv)
    if getattr(args, "live", False) and getattr(args, "auto", False):
        parser.error("--auto cannot be combined with --live: a real booking is confirmed by a human")
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
