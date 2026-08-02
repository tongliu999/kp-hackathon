"""Console demonstration of detached cold-task coordination."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from typing import Sequence

from .cold_tasks import (
    ColdTaskCoordinator,
    DelayedEchoWorker,
    JobSnapshot,
    NotificationKind,
)


@dataclass(slots=True)
class ConsoleNotifier:
    async def notify(self, job_id: str, text: str, kind: NotificationKind) -> None:
        print(f"[{kind.value} {job_id}] {text}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Demonstrate cold tasks returning after the voice turn is released."
    )
    parser.add_argument("requests", nargs="+", help="unmatched utterance(s) to submit")
    parser.add_argument(
        "--delay",
        type=float,
        default=180.0,
        help="fake worker delay in seconds (default: 180)",
    )
    return parser


async def run_demo(requests: Sequence[str], delay: float) -> tuple[JobSnapshot, ...]:
    worker = DelayedEchoWorker(delay_seconds=delay)
    async with ColdTaskCoordinator(worker, ConsoleNotifier()) as coordinator:
        jobs = []
        for request in requests:
            job = await coordinator.submit_no_match(request)
            jobs.append(job)
            print(f"[released {job.id}] conversation is free for another utterance")
        return tuple(await asyncio.gather(*(coordinator.wait(job.id) for job in jobs)))


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        jobs = asyncio.run(run_demo(args.requests, args.delay))
    except (ValueError, RuntimeError) as exc:
        print(f"cold-task demo failed: {exc}")
        return 2
    for job in jobs:
        print(f"[{job.status.value} {job.id}] {job.result or job.error}")
    return 0 if all(job.status.value == "succeeded" for job in jobs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
