"""Settle the two questions TON-13's architecture depends on.

  1. Do live processes survive fork()/from_checkpoint()? The docs page and the SDK
     docstring flatly contradict each other, so measure it.
  2. Is fork x3 or checkpoint->from_checkpoint x3 the better 3-way fan-out?

Run:  .venv/bin/python research/fanout_bakeoff.py --runs 3
Needs SAIL_API_KEY or `sail auth login`. Boxes are namespaced app=branch-research so
this never touches the TON-7 session's boxes (app=spine).
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Pick up SAIL_API_KEY from a gitignored .env, if that's how the key was dropped off.

    Must run before `import sail` — the SDK resolves config once per process.
    """
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_dotenv()

import sail  # noqa: E402  - must follow _load_dotenv()

APP = "branch-research"
N_CHILDREN = 3
MARKER = "/tmp/branch-marker.txt"
PROC_TAG = "sail-liveness-probe"


def out(result) -> str:
    """ExecResult's payload attribute isn't stable across versions; be defensive."""
    for attr in ("stdout", "stdout_text", "output"):
        val = getattr(result, attr, None)
        if val is None:
            continue
        return val.decode() if isinstance(val, bytes) else str(val)
    return ""


@dataclass
class RunResult:
    strategy: str
    seconds: float
    disk_survived: int = 0
    process_survived: int = 0
    errors: list[str] = field(default_factory=list)


def seed_parent(sb) -> None:
    """Write a disk marker and start a long-lived background process."""
    sb.run(f"echo branch-marker > {MARKER}", check=True)
    # setsid + nohup so it outlives the exec session that started it
    sb.run(
        f"setsid nohup sleep 900 --{PROC_TAG} >/dev/null 2>&1 < /dev/null & echo ok",
    )
    # Confirm it is actually running in the parent, or the whole probe is meaningless.
    probe = out(sb.run(f"pgrep -fa 'sleep 900' | grep -c {PROC_TAG} || echo 0")).strip()
    if probe == "0":
        print("  !! background process failed to start in PARENT - liveness result is void")


def inspect_child(sb) -> tuple[bool, bool]:
    """Return (disk_survived, process_survived)."""
    disk = out(sb.run(f"cat {MARKER} 2>/dev/null || echo MISSING")).strip()
    proc = out(sb.run(f"pgrep -fa 'sleep 900' | grep -c {PROC_TAG} || echo 0")).strip()
    return disk == "branch-marker", proc not in ("0", "")


def time_to_ready(children: list) -> None:
    """Block until every child accepts an exec. This is the number that matters."""
    with ThreadPoolExecutor(max_workers=len(children)) as pool:
        list(pool.map(lambda c: c.run("true"), children))


def strategy_fork(app, run_idx: int) -> RunResult:
    parent = sail.Sailbox.create(app=app, name=f"bakeoff-fork-parent-{run_idx}")
    children: list = []
    try:
        seed_parent(parent)
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=N_CHILDREN) as pool:
            children = list(
                pool.map(
                    lambda i: parent.fork(name=f"bakeoff-fork-{run_idx}-{i}"),
                    range(N_CHILDREN),
                )
            )
        time_to_ready(children)
        elapsed = time.perf_counter() - t0

        res = RunResult("fork x3", elapsed)
        for c in children:
            disk, proc = inspect_child(c)
            res.disk_survived += disk
            res.process_survived += proc
        return res
    finally:
        cleanup([parent, *children])


def strategy_checkpoint(app, run_idx: int) -> RunResult:
    parent = sail.Sailbox.create(app=app, name=f"bakeoff-ckpt-parent-{run_idx}")
    children: list = []
    try:
        seed_parent(parent)
        t0 = time.perf_counter()
        ckpt = parent.checkpoint(name=f"bakeoff-ckpt-{run_idx}", ttl_seconds=3600)
        ckpt_id = ckpt.checkpoint_id  # NB: it is .checkpoint_id — there is no .id
        with ThreadPoolExecutor(max_workers=N_CHILDREN) as pool:
            children = list(
                pool.map(
                    lambda i: sail.Sailbox.from_checkpoint(
                        ckpt_id, name=f"bakeoff-ckpt-{run_idx}-{i}"
                    ),
                    range(N_CHILDREN),
                )
            )
        time_to_ready(children)
        elapsed = time.perf_counter() - t0

        res = RunResult("checkpoint x3", elapsed)
        for c in children:
            disk, proc = inspect_child(c)
            res.disk_survived += disk
            res.process_survived += proc
        return res
    finally:
        cleanup([parent, *children])


def cleanup(boxes: list) -> None:
    for b in boxes:
        try:
            b.terminate()
        except Exception as exc:  # cleanup must never mask a real result
            print(f"  (cleanup warning: {exc})", file=sys.stderr)


def report(results: list[RunResult]) -> None:
    print("\n" + "=" * 66)
    print("FAN-OUT BAKE-OFF")
    print("=" * 66)
    by_strategy: dict[str, list[RunResult]] = {}
    for r in results:
        by_strategy.setdefault(r.strategy, []).append(r)

    print(f"\n{'strategy':<16} {'runs':>5} {'median s':>10} {'min':>8} {'max':>8}")
    print("-" * 66)
    for name, rs in by_strategy.items():
        secs = [r.seconds for r in rs]
        print(
            f"{name:<16} {len(rs):>5} {statistics.median(secs):>10.1f} "
            f"{min(secs):>8.1f} {max(secs):>8.1f}"
        )

    print(f"\n{'strategy':<16} {'disk survived':>16} {'PROCESS survived':>18}")
    print("-" * 66)
    for name, rs in by_strategy.items():
        total = len(rs) * N_CHILDREN
        print(
            f"{name:<16} {sum(r.disk_survived for r in rs):>12}/{total:<3} "
            f"{sum(r.process_survived for r in rs):>14}/{total:<3}"
        )

    proc_total = sum(r.process_survived for r in results)
    print("\n" + "-" * 66)
    if proc_total == 0:
        print("VERDICT: live processes do NOT survive branching. The SDK docstring is")
        print("right and the docs page is wrong. Auth MUST live in an on-disk browser")
        print("profile; every branch relaunches its browser. Tell Talia.")
    elif proc_total == len(results) * N_CHILDREN:
        print("VERDICT: live processes always survived. The docs page is right.")
        print("Still use an on-disk profile - 'always' here is a sample, not a guarantee.")
    else:
        print(f"VERDICT: processes survived {proc_total}/{len(results) * N_CHILDREN} times.")
        print("INTERMITTENT is the worst case: it will pass testing and fail on stage.")
        print("Treat live processes as unavailable. On-disk profile, no exceptions.")
    print("-" * 66)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3, help="repetitions per strategy")
    ap.add_argument("--only", choices=["fork", "checkpoint"], help="run one strategy")
    args = ap.parse_args()

    app = sail.App.find(name=APP, mint_if_missing=True)
    print(f"app={APP}  runs={args.runs}  children={N_CHILDREN}")

    strategies = {"fork": strategy_fork, "checkpoint": strategy_checkpoint}
    if args.only:
        strategies = {args.only: strategies[args.only]}

    results: list[RunResult] = []
    for i in range(args.runs):
        for name, fn in strategies.items():
            print(f"\n[run {i + 1}/{args.runs}] {name} ...", flush=True)
            try:
                r = fn(app, i)
                print(f"  {r.seconds:.1f}s  disk {r.disk_survived}/{N_CHILDREN}"
                      f"  proc {r.process_survived}/{N_CHILDREN}")
                results.append(r)
            except Exception as exc:
                print(f"  FAILED: {type(exc).__name__}: {exc}")

    if not results:
        print("\nNo successful runs - check auth (`sail auth login`) and quota.")
        return 1
    report(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
