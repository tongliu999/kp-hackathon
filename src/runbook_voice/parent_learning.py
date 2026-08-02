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
    runbook = Runbook.from_dict(distill(winner.to_dict()))
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
    (directory / "learning.json").write_text(
        json.dumps(learning, indent=2) + "\n", encoding="utf-8"
    )
    return LearningResult(verdict, runbook, artifact, store.path)


__all__ = ["LearningResult", "TrajectoryJudge", "learn_from_trajectories"]
