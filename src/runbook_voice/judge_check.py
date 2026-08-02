"""Hand the judge two obviously-unequal branches and confirm it is not picking at random.

TON-19 asks for exactly this before the judge is trusted: the recorded fixtures have a
deliberate ranking (b0 > b1 > b2, with b1 falsely self-reporting success), so a judge
that disagrees with itself across repeated runs is broken rather than unlucky. Prints
every verdict, then the tally, and exits non-zero unless the runs agree - the reason
strings are as much of the signal as the winners, which is why they are all printed
rather than summarized.

If this does not come out consistent, the answer is the documented fallback
(:func:`~.judge.longest_successful_branch`), not an afternoon of prompt tuning.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
from typing import Any

from .judge import DEFAULT_MODEL, JudgeError, PairwiseJudge, SailJudgeModel

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "trajectories"


def load_trajectories(directory: Path) -> list[dict[str, Any]]:
    paths = sorted(directory.glob("*.json"))
    if len(paths) < 2:
        raise SystemExit(f"need at least two trajectories in {directory}")
    return [json.loads(path.read_text()) for path in paths]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the pairwise judge repeatedly on the recorded fixtures."
    )
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--effort", default="high")
    parser.add_argument("--fixtures", type=Path, default=FIXTURES)
    parser.add_argument(
        "--expect",
        default=None,
        help="branch_id the runs must agree on; consistency alone is checked without it",
    )
    args = parser.parse_args(argv)
    if args.runs < 1:
        raise SystemExit("--runs must be at least 1")

    trajectories = load_trajectories(args.fixtures)
    judge = PairwiseJudge(
        SailJudgeModel(
            model=args.model, temperature=args.temperature, effort=args.effort
        )
    )
    branches = ", ".join(str(t.get("branch_id")) for t in trajectories)
    print(f"{args.model} @ temperature={args.temperature} effort={args.effort}")
    print(f"comparing: {branches}\n")

    winners: Counter[str] = Counter()
    for run in range(1, args.runs + 1):
        try:
            verdict = judge.pick(trajectories)
        except JudgeError as exc:
            # A failed call is a data point about reliability, so keep going and let
            # it show up in the tally rather than aborting the check on run 1.
            print(f"run {run}/{args.runs}  FAILED  {exc}", file=sys.stderr)
            winners["<error>"] += 1
            continue
        winners[verdict.winner] += 1
        print(f"run {run}/{args.runs}  {verdict.winner}  {verdict.reason}")

    print("\ntally: " + ", ".join(f"{w} x{n}" for w, n in winners.most_common()))
    top, count = winners.most_common(1)[0]
    if len(winners) > 1:
        print(f"INCONSISTENT across {args.runs} runs - do not prune on this judge")
        return 1
    if args.expect and top != args.expect:
        print(f"CONSISTENT on {top}, but expected {args.expect}")
        return 1
    if top == "<error>":
        print(f"every run failed ({count}/{args.runs})")
        return 1
    print(f"consistent: {count}/{args.runs} runs picked {top}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
