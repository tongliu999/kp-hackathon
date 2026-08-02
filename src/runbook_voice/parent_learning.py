"""Close the parent loop: judge, distil, validate, and remember the winner."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from .branch_search import Trajectory
from .distiller import distill
from .judge import JudgeVerdict
from .runbook_store import JSONRunbookStore
from .runbooks import Runbook


class TrajectoryJudge(Protocol):
    def pick(
        self, trajectories: Sequence[Mapping[str, Any]]
    ) -> JudgeVerdict: ...


@dataclass(frozen=True, slots=True)
class LearningResult:
    verdict: JudgeVerdict
    runbook: Runbook
    runbook_artifact: Path
    store_path: Path


def learn_from_trajectories(
    trajectories: Sequence[Trajectory],
    *,
    directory: Path,
    judge: TrajectoryJudge,
    store: JSONRunbookStore,
    guidance: Mapping[str, Any] | None = None,
) -> LearningResult:
    """Persist only a schema-valid runbook distilled from the judged winner."""
    if len(trajectories) < 2:
        raise ValueError("parent learning needs at least two trajectories")
    documents = [trajectory.to_dict() for trajectory in trajectories]
    verdict = judge.pick(documents)
    winner = next(
        (trajectory for trajectory in trajectories if trajectory.branch_id == verdict.winner),
        None,
    )
    if winner is None:
        raise ValueError(f"judge picked unknown branch {verdict.winner!r}")

    directory.mkdir(parents=True, exist_ok=True)
    (directory / "judge.log").write_text(
        f"winner: {verdict.winner}\nreason: {verdict.reason}\n"
        f"tally: {verdict.winner} x1\n",
        encoding="utf-8",
    )

    # Runbook.from_dict is the canonical admission gate. Nothing is written to
    # the parent's memory until both deterministic distillation and schema
    # validation succeed.
    runbook_document = distill(_winning_path(winner, trajectories))
    if guidance is not None:
        runbook_document["guidance"] = dict(guidance)
    runbook = Runbook.from_dict(runbook_document)
    store.save(runbook)

    artifact = directory / "synthesized_runbook.json"
    artifact.write_text(
        json.dumps(runbook.to_dict(), indent=2) + "\n", encoding="utf-8"
    )
    learning = {
        "winner": verdict.winner,
        "reason": verdict.reason,
        "runbook_id": runbook.id,
        "runbook_name": runbook.name,
        "store_path": str(store.path),
    }
    if guidance is not None:
        learning["guidance"] = dict(guidance)
    (directory / "learning.json").write_text(
        json.dumps(learning, indent=2) + "\n", encoding="utf-8"
    )
    return LearningResult(verdict, runbook, artifact, store.path)


def _winning_path(
    winner: Trajectory, trajectories: Sequence[Trajectory]
) -> dict[str, Any]:
    """Rebuild the complete root-to-leaf trace for runbook distillation."""
    by_id = {trajectory.branch_id: trajectory for trajectory in trajectories}
    chain = [winner]
    cursor = winner
    seen = {winner.branch_id}
    while cursor.parent_branch_id is not None:
        if cursor.parent_branch_id in seen:
            raise ValueError("winning trajectory ancestry contains a cycle")
        parent = by_id.get(cursor.parent_branch_id)
        if parent is None:
            raise ValueError(
                f"winning trajectory references missing parent {cursor.parent_branch_id!r}"
            )
        chain.append(parent)
        seen.add(parent.branch_id)
        cursor = parent
    steps: list[dict[str, Any]] = []
    elapsed = 0.0
    for trajectory in reversed(chain):
        for step in trajectory.steps:
            document = step.to_dict()
            document["i"] = len(steps)
            document["t"] = round(elapsed + step.t, 3)
            steps.append(document)
        elapsed += trajectory.wall_ms / 1000
    document = winner.to_dict()
    document["steps"] = steps
    return document


__all__ = ["LearningResult", "TrajectoryJudge", "learn_from_trajectories"]
