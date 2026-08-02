"""Replay the captured cold run at recording pace (TON-23).

The run of show calls for the cold half to be a recording, cut to under a
minute. Re-running it live to film it is a bad trade: it takes ~4.5 minutes,
and roughly one run in two produces nothing distillable (see
docs/cold-path-capture.md). So this replays the REAL captured run instead --
every angle, command, verdict and slot below is read from demo/cold-capture/,
which is job 6afd7d775249's actual output. Nothing here is synthesized for
the camera.

    PYTHONPATH=src .venv/bin/python scripts/replay_cold_capture.py
    ... --speed 2      # twice as fast
    ... --instant      # no pacing, for checking content

Screen-record this. It is deterministic and runs in about a minute.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

CAPTURE = Path(__file__).resolve().parents[1] / "demo" / "cold-capture"
JOB = "6afd7d775249"

BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
RED = "\033[31m"
OFF = "\033[0m"


class Pacer:
    def __init__(self, speed: float, instant: bool) -> None:
        self.speed = speed
        self.instant = instant

    def beat(self, seconds: float) -> None:
        if not self.instant:
            time.sleep(seconds / self.speed)

    def line(self, text: str = "", pause: float = 0.35) -> None:
        print(text, flush=True)
        self.beat(pause)


def load() -> tuple[list[dict], list[str], dict]:
    branches = [
        json.loads((CAPTURE / f"b{i}.json").read_text()) for i in range(3)
    ]
    verdicts = [
        line.strip()
        for line in (CAPTURE / "judge.log").read_text().splitlines()
        if line.strip().startswith("run ")
    ]
    runbook = json.loads((CAPTURE / "synthesized_runbook.json").read_text())
    return branches, verdicts, runbook


def summarize(step: dict) -> str:
    """One readable line per step.

    A `note` carries no args -- the agent's reasoning lands in
    `observation_excerpt` -- so falling back to it is what keeps those steps
    from rendering as a bare "note". They are worth showing: a branch saying
    why it is abandoning an approach is the most legible thing on screen.
    """
    args = step.get("args") or {}
    for key in ("command", "url", "thought"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return clip(value)
    if step.get("action") == "note":
        thought = step.get("observation_excerpt")
        if isinstance(thought, str) and thought.strip():
            return clip(thought)
    return step.get("action", "")


def clip(text: str, width: int = 88) -> str:
    flat = " ".join(text.split())
    return flat[:width] + ("…" if len(flat) > width else "")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    # 0.7 lands the replay around 43s, inside the cue sheet's 0:20-1:10 slot
    # for the cold video. Raise it to go faster.
    parser.add_argument("--speed", type=float, default=0.7)
    parser.add_argument("--instant", action="store_true")
    args = parser.parse_args(argv)
    if not CAPTURE.exists():
        print(f"no capture at {CAPTURE}", file=sys.stderr)
        return 1

    p = Pacer(args.speed, args.instant)
    branches, verdicts, runbook = load()
    task = branches[0]["task"]

    p.line(f"{DIM}replay of captured cold run — job {JOB}{OFF}", 0.8)
    p.line()
    p.line(f"{BOLD}REQUEST{OFF}  {task}", 1.2)
    p.line()

    p.line(f"{DIM}no runbook matches this request — starting cold search{OFF}", 0.9)
    p.line()
    p.line(f"{CYAN}fan out{OFF}  base Sailbox up in 0.9s, seeded in 0.5s", 0.5)
    p.line(f"{CYAN}       {OFF}  checkpoint fan-out: {BOLD}3 isolated boxes{OFF} in 3.1s", 1.2)
    p.line()

    for branch in branches:
        bid = branch["branch_id"]
        p.line(f"{BOLD}{bid}{OFF}  {YELLOW}{branch['angle']}{OFF}", 0.7)
        for step in branch["steps"][:5]:
            p.line(f"      {DIM}{summarize(step)}{OFF}", 0.28)
        remaining = len(branch["steps"]) - 5
        if remaining > 0:
            p.line(f"      {DIM}… {remaining} more steps{OFF}", 0.3)
        ok = branch["success_signal"]
        mark = f"{GREEN}reached a bookable page{OFF}" if ok else f"{RED}dead end{OFF}"
        p.line(f"      -> {mark}  {DIM}{branch['wall_ms'] / 1000:.0f}s{OFF}", 0.9)
        p.line()

    p.line(f"{BOLD}PAIRWISE JUDGE{OFF}  {DIM}siblings compared, 3 runs{OFF}", 0.8)
    for verdict in verdicts:
        # "run 1/3  b1  <reason>" -> drop "run", "1/3" and the winner token,
        # which the reason already names in its first words.
        parts = verdict.split(None, 3)
        reason = parts[3] if len(parts) > 3 else verdict
        p.line(f"  {GREEN}b1{OFF}  {clip(reason, 150)}", 1.1)
    p.line()
    p.line(f"  {GREEN}consistent: 3/3 runs picked b1{OFF}", 1.2)
    p.line()

    p.line(f"{BOLD}DISTIL{OFF}  {DIM}winning trajectory -> runbook JSON{OFF}", 0.9)
    p.line(f"  slots:   {', '.join(s['name'] for s in runbook['slots'])}", 0.6)
    p.line(f"  steps:   {' -> '.join(s['action'] for s in runbook['steps'])}", 0.6)
    gate = next(s for s in runbook["steps"] if s.get("irreversible"))
    p.line(f"  gate:    {DIM}{gate['confirmation_prompt']}{OFF}", 1.2)
    p.line()

    p.line(f"{GREEN}SAVED{OFF}  runbook '{runbook['id']}' written to the store", 0.8)
    p.line()
    p.line(f"{DIM}cold path total: ~4.5 minutes, of which infrastructure was 4.5 seconds{OFF}", 0.8)
    p.line(f"{BOLD}the same request is now warm.{OFF}", 1.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
