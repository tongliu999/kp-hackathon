from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from runbook_voice.branch_search import Trajectory
from runbook_voice.judge import JudgeVerdict
from runbook_voice.parent_learning import learn_from_trajectories
from runbook_voice.runbook_store import JSONRunbookStore

ROOT = Path(__file__).parents[1]


class WinnerJudge:
    def pick(self, trajectories: Sequence[Mapping[str, Any]]) -> JudgeVerdict:
        assert {trajectory["branch_id"] for trajectory in trajectories} == {"b0", "b1"}
        return JudgeVerdict(
            "b0",
            "b0 satisfied the requested time while b1 returned a later alternative.",
        )


def fixture(name: str) -> Trajectory:
    payload = json.loads((ROOT / "fixtures" / "trajectories" / name).read_text())
    return Trajectory.from_dict(payload)


def test_parent_judges_distills_validates_and_updates_its_store(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    store = JSONRunbookStore(tmp_path / "parent-memory.json")

    result = learn_from_trajectories(
        [fixture("branch-0.json"), fixture("branch-1.json")],
        directory=run_dir,
        judge=WinnerJudge(),
        store=store,
    )

    assert result.verdict.winner == "b0"
    assert result.runbook.id == "restaurant-reservation"
    persisted = json.loads(store.path.read_text())
    assert [runbook["id"] for runbook in persisted["runbooks"]] == [
        "restaurant-reservation"
    ]
    artifact = json.loads((run_dir / "synthesized_runbook.json").read_text())
    assert artifact["id"] == result.runbook.id
    learning = json.loads((run_dir / "learning.json").read_text())
    assert learning["winner"] == "b0"
    assert learning["runbook_id"] == result.runbook.id
    assert "tally: b0 x1" in (run_dir / "judge.log").read_text()


def test_learning_replaces_the_same_runbook_instead_of_duplicating_it(tmp_path: Path) -> None:
    store = JSONRunbookStore(tmp_path / "parent-memory.json")
    trajectories = [fixture("branch-0.json"), fixture("branch-1.json")]

    learn_from_trajectories(
        trajectories, directory=tmp_path / "one", judge=WinnerJudge(), store=store
    )
    learn_from_trajectories(
        trajectories, directory=tmp_path / "two", judge=WinnerJudge(), store=store
    )

    assert len(json.loads(store.path.read_text())["runbooks"]) == 1
