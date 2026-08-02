"""Adaptive parent-led branching search and runbook learning loop.

    PYTHONPATH=src .venv/bin/python -m runbook_voice.branch_search_demo "<request>"

Done means the parent chose a bounded set of different approaches, every box
produced a schema-valid trajectory, the judge selected a winner, and the parent
stored a validated runbook. Final answers alone make learning impossible,
so the summary below reports step counts and dead ends, and the exit code fails
if any branch came back without steps or without a distinct box id.

Boxes are namespaced ``app=branch-search`` so a concurrent session running
against the same Sail org cannot terminate them, and every box is terminated in
a ``finally`` — including on Ctrl-C.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
from pathlib import Path
from typing import Sequence

from . import branch_agent
from .branch_search import (
    DEFAULT_APP,
    BranchingSearch,
    InBoxAgentLauncher,
    Trajectory,
    resolve_api_key,
)
from .judge import DEFAULT_MODEL as DEFAULT_PARENT_MODEL
from .judge import PairwiseJudge, SailJudgeModel
from .parent_learning import learn_from_trajectories
from .parent_planner import (
    DEFAULT_BRANCH_LIMIT,
    MAX_BRANCH_LIMIT,
    MIN_BRANCHES,
    ParentPlanner,
    validate_branch_limit,
)
from .runbook_store import JSONRunbookStore

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "trajectory.schema.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Let a parent choose a bounded fan-out, collect trajectories, judge the "
            "winner, and save the learned runbook."
        )
    )
    parser.add_argument("request", help="the unknown task to attempt")
    parser.add_argument("--app", default=DEFAULT_APP, help="Sail app namespace")
    parser.add_argument("--model", default=branch_agent.DEFAULT_MODEL)
    parser.add_argument(
        "--parent-model",
        default=DEFAULT_PARENT_MODEL,
        help="model used by the parent to plan approaches and judge the winner",
    )
    parser.add_argument(
        "--max-branches",
        type=int,
        default=DEFAULT_BRANCH_LIMIT,
        help=(
            f"maximum children the parent may choose "
            f"({MIN_BRANCHES}–{MAX_BRANCH_LIMIT}; default: {DEFAULT_BRANCH_LIMIT})"
        ),
    )
    parser.add_argument(
        "--window",
        default=branch_agent.DEFAULT_COMPLETION_WINDOW,
        choices=["asap", "priority", "standard", "flex"],
        help="Sail completion window for the branch agent loop",
    )
    parser.add_argument(
        "--max-steps", type=int, default=branch_agent.DEFAULT_MAX_STEPS,
        help="per-branch step budget",
    )
    parser.add_argument(
        "--deadline", type=float, default=branch_agent.DEFAULT_DEADLINE_SECONDS,
        help="per-branch wall-clock budget in seconds",
    )
    parser.add_argument("--out", default="runs", help="output directory")
    parser.add_argument(
        "--runbook-store",
        default="demo/runbook-store.json",
        help="durable runbook store the parent updates after learning",
    )
    parser.add_argument(
        "--keep-boxes",
        action="store_true",
        help="leave the boxes running for inspection (they bill until terminated)",
    )
    return parser


def validate(trajectories: Sequence[Trajectory]) -> list[str]:
    """Check every emitted trajectory against the locked schema.

    Skipped rather than failed when jsonschema is absent: the demo's job is to
    prove the boxes ran, and `python schema/validate.py` is the gate that must
    have the dependency.
    """
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        print("  (jsonschema not installed — skipping schema check)")
        return []
    if not SCHEMA_PATH.exists():
        print(f"  (no schema at {SCHEMA_PATH} — skipping schema check)")
        return []

    validator = Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))
    errors: list[str] = []
    for trajectory in trajectories:
        for error in validator.iter_errors(trajectory.to_dict()):
            path = "/".join(str(part) for part in error.absolute_path) or "<root>"
            errors.append(f"{trajectory.branch_id}: {path}: {error.message}")
    return errors


def report(trajectories: Sequence[Trajectory], paths: Sequence[Path]) -> list[str]:
    print("\ntrajectories:")
    print(f"  {'branch':<8} {'box':<24} {'steps':>6} {'dead ends':>10} {'wall':>8}  success")
    print("  " + "-" * 72)
    for trajectory in trajectories:
        print(
            f"  {trajectory.branch_id:<8} {str(trajectory.sailbox_id or '?'):<24} "
            f"{len(trajectory.steps):>6} {trajectory.abandoned_steps:>10} "
            f"{trajectory.wall_ms / 1000:>7.1f}s  {trajectory.success_signal}"
        )

    print("\nangles (these must differ, or the judge has nothing to compare):")
    for trajectory in trajectories:
        print(f"  {trajectory.branch_id}  {trajectory.angle}")

    print("\nanswers:")
    for trajectory in trajectories:
        answer = trajectory.final_answer or f"(no answer — {trajectory.error})"
        print(f"  {trajectory.branch_id}  {answer}")

    failures: list[str] = []
    boxes = [t.sailbox_id for t in trajectories]
    if len(set(boxes)) != len(boxes) or None in boxes:
        failures.append(f"branches did not run in distinct boxes: {boxes}")
    for trajectory in trajectories:
        # One synthesized error step is what a branch that never ran looks like.
        if len(trajectory.steps) < 2:
            failures.append(
                f"{trajectory.branch_id} captured {len(trajectory.steps)} step(s) — "
                f"final answers alone make M3 impossible"
            )
    failures.extend(validate(trajectories))

    print("\nfiles:")
    for path in paths:
        print(f"  {path}")
    return failures


async def run_demo(args: argparse.Namespace) -> int:
    try:
        branch_limit = validate_branch_limit(args.max_branches)
    except ValueError as exc:
        print(f"invalid branch limit: {exc}")
        return 2

    job_id = secrets.token_hex(6)
    parent_model = SailJudgeModel(model=args.parent_model)
    planner = ParentPlanner(parent_model)
    print(
        f"parent planning up to {branch_limit} approaches with {args.parent_model}",
        flush=True,
    )
    plan = await asyncio.to_thread(planner.plan, args.request, branch_limit)
    print(
        "PARENT_PLAN "
        + json.dumps(
            {
                "branch_count": plan.branch_count,
                "branch_limit": plan.max_branches,
                "rationale": plan.rationale,
                "approaches": [angle.angle for angle in plan.angles],
            }
        ),
        flush=True,
    )
    search = BranchingSearch(
        app=args.app,
        angles=plan.angles,
        output_dir=args.out,
        keep_boxes=args.keep_boxes,
        launcher=InBoxAgentLauncher(
            api_key=resolve_api_key(),
            model=args.model,
            completion_window=args.window,
            max_steps=args.max_steps,
            deadline_seconds=args.deadline,
        ),
        progress=lambda message: print(f"  {message}", flush=True),
    )

    print(
        f"job {job_id}  app={args.app}  branch-model={args.model}  "
        f"parent-model={args.parent_model}  window={args.window}"
    )
    print(f"request: {args.request}\n")
    trajectories = await search.search(args.request, job_id)
    paths = search.persist(trajectories, job_id)

    failures = report(trajectories, paths)
    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    directory = paths[0].parent
    print("\nparent judging complete trajectories…", flush=True)
    learned = await asyncio.to_thread(
        learn_from_trajectories,
        trajectories,
        directory=directory,
        judge=PairwiseJudge(parent_model),
        store=JSONRunbookStore(args.runbook_store),
    )
    print(
        "PARENT_LEARNED "
        + json.dumps(
            {
                "winner": learned.verdict.winner,
                "reason": learned.verdict.reason,
                "runbook_id": learned.runbook.id,
                "runbook_name": learned.runbook.name,
                "store_path": str(learned.store_path),
            }
        ),
        flush=True,
    )
    print(
        f"\nOK — parent tried {len(trajectories)} approaches, chose "
        f"{learned.verdict.winner}, and updated runbook {learned.runbook.id!r}."
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return asyncio.run(run_demo(args))
    except KeyboardInterrupt:
        print("\ninterrupted")
        return 130
    except Exception as exc:  # a failed demo should report, not traceback
        print(f"branching search demo failed: {type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
