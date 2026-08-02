from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
import sys
from typing import Any

import pytest

from runbook_voice import branch_agent
from runbook_voice.branch_search import (
    BRANCH_DIR,
    DEFAULT_ANGLES,
    Angle,
    BranchingSearch,
    InBoxAgentLauncher,
    Step,
    Trajectory,
    agent_source,
    checkpoint_fanout,
)
from runbook_voice.cold_tasks import ColdTaskCoordinator, JobStatus, NotificationKind

ROOT = Path(__file__).parents[1]
SCHEMA_PATH = ROOT / "schema" / "trajectory.schema.json"
FIXTURE_DIR = ROOT / "fixtures" / "trajectories"

TASK = "book a table for two on friday at seven, somewhere italian"


def a_trajectory(branch_id: str = "b0", **overrides: Any) -> dict[str, Any]:
    trajectory = {
        "branch_id": branch_id,
        "angle": f"angle for {branch_id}",
        "task": TASK,
        "steps": [
            {"i": 0, "t": 0.0, "kind": "think", "action": "plan", "outcome": "ok"},
            {
                "i": 1,
                "t": 1.5,
                "kind": "shell",
                "action": "run",
                "args": {"command": "curl -s https://example.test"},
                "observation_excerpt": "14 results",
                "outcome": "ok",
            },
        ],
        "final_answer": f"{branch_id} found something",
        "success_signal": True,
        "wall_ms": 1500,
    }
    trajectory.update(overrides)
    return trajectory


# --- fakes ---------------------------------------------------------------------


class FakeExec:
    def __init__(self, stdout: str = "", exit_code: int = 0) -> None:
        self.stdout = stdout
        self.stderr = ""
        self.exit_code = exit_code


class FakeFs:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    def write(self, path: str, content: str) -> None:
        self.files[path] = content

    def read(self, path: str) -> bytes:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path].encode()


class FakeBox:
    """A Sailbox that records what it was asked to do.

    ``result`` is what the in-box agent would have written; ``never_finishes``
    models a box whose agent died without writing DONE.
    """

    def __init__(
        self,
        sailbox_id: str,
        *,
        log: list[tuple[str, str]] | None = None,
        result: dict[str, Any] | None = None,
        never_finishes: bool = False,
        partial_steps: list[dict[str, Any]] | None = None,
    ) -> None:
        self.sailbox_id = sailbox_id
        self.fs = FakeFs()
        self.commands: list[str] = []
        self.envs: list[dict[str, str] | None] = []
        self.terminated = 0
        self.log = log if log is not None else []
        self.result = result
        self.never_finishes = never_finishes
        self.partial_steps = partial_steps or []
        self._launched = False

    def run(self, command: str, *, env: Any = None, check: bool = False, **_: Any) -> FakeExec:
        self.commands.append(command)
        self.envs.append(env)
        self.log.append((self.sailbox_id, command))

        if "branch_agent.py" in command and "setsid" in command:
            self._launched = True
            if self.result is not None and not self.never_finishes:
                self.fs.files[f"{BRANCH_DIR}/{branch_agent.TRAJECTORY_FILE}"] = json.dumps(
                    self.result
                )
            return FakeExec("launched\n")
        if branch_agent.DONE_FILE in command:
            done = self._launched and not self.never_finishes and self.result is not None
            return FakeExec("done\n" if done else "")
        if branch_agent.STEPS_FILE in command:
            return FakeExec("\n".join(json.dumps(s) for s in self.partial_steps))
        return FakeExec("")

    def checkpoint(self, *, name: str | None = None, ttl_seconds: int | None = None):
        self.log.append((self.sailbox_id, f"checkpoint ttl={ttl_seconds}"))
        return FakeCheckpoint(f"ckpt-{self.sailbox_id}")

    def terminate(self) -> None:
        self.terminated += 1


class FakeCheckpoint:
    """Mirrors ``SailboxCheckpoint``, which has ``checkpoint_id`` and **no** ``id``."""

    def __init__(self, checkpoint_id: str) -> None:
        self.checkpoint_id = checkpoint_id
        self.sailbox_id = "sb-base"
        self.checkpoint_generation = 1
        self.status = "ready"


class FakeSail:
    def __init__(self, children: list[FakeBox] | None = None) -> None:
        self.base = FakeBox("sb-base")
        self.children = children if children is not None else []
        self.from_checkpoint_ids: list[str] = []
        self.child_names: list[str] = []
        self.created: list[dict[str, Any]] = []
        self.found_app: dict[str, Any] = {}
        sail = self

        class App:
            @staticmethod
            def find(*, name: str, mint_if_missing: bool = False) -> str:
                sail.found_app = {"name": name, "mint_if_missing": mint_if_missing}
                return f"app::{name}"

        class Sailbox:
            @staticmethod
            def create(*, app: Any, name: str, size: str) -> FakeBox:
                sail.created.append({"app": app, "name": name, "size": size})
                return sail.base

            @staticmethod
            def from_checkpoint(checkpoint_id: str, *, name: str | None = None) -> FakeBox:
                sail.from_checkpoint_ids.append(checkpoint_id)
                sail.child_names.append(name or "")
                index = len(sail.from_checkpoint_ids) - 1
                if index < len(sail.children):
                    return sail.children[index]
                child = FakeBox(f"sb-child-{index}", log=sail.base.log)
                sail.children.append(child)
                return child

        class Config:
            @staticmethod
            def from_env() -> Any:
                return type("Resolved", (), {"api_key": "sk-fake"})()

        self.App = App
        self.Sailbox = Sailbox
        self.Config = Config


@pytest.fixture
def fake_sail(monkeypatch: pytest.MonkeyPatch):
    def install(children: list[FakeBox] | None = None) -> FakeSail:
        sail = FakeSail(children)
        monkeypatch.setitem(sys.modules, "sail", sail)
        return sail

    return install


class ScriptedLauncher:
    """Stands in for the in-box agent so fan-out can be tested without Sail."""

    def __init__(self, *, fail: set[str] | None = None) -> None:
        self.fail = fail or set()
        self.seen: list[tuple[str, str, str]] = []

    async def launch(self, box: Any, angle: Angle, task: str) -> Trajectory:
        self.seen.append((box.sailbox_id, angle.branch_id, task))
        if angle.branch_id in self.fail:
            raise RuntimeError(f"{angle.branch_id} exploded")
        return Trajectory.from_dict(
            a_trajectory(angle.branch_id, angle=angle.angle, task=task),
            sailbox_id=box.sailbox_id,
        )


# --- the trajectory model ------------------------------------------------------


@pytest.mark.parametrize("fixture", sorted(FIXTURE_DIR.glob("*.json")), ids=lambda p: p.name)
def test_the_locked_fixtures_survive_a_round_trip_unchanged(fixture: Path) -> None:
    # The judge's contract is the JSON on disk, not this dataclass. If parsing
    # and re-emitting a known-good trajectory changes it, this producer has
    # drifted from the schema and every branch it writes is suspect.
    original = json.loads(fixture.read_text())

    assert Trajectory.from_dict(original).to_dict() == original


def test_absent_optional_fields_are_omitted_not_nulled() -> None:
    # The schema sets additionalProperties false and types every field it
    # declares, so a null final_answer would fail validation.
    emitted = Trajectory(
        branch_id="b0",
        angle="an angle",
        task=TASK,
        steps=(Step(i=0, t=0.0, action="plan", outcome="ok"),),
        success_signal=False,
        wall_ms=10,
    ).to_dict()

    assert "final_answer" not in emitted
    assert "error" not in emitted
    assert set(emitted["steps"][0]) == {"i", "t", "action", "outcome"}


def test_the_box_id_never_leaks_into_the_emitted_json() -> None:
    emitted = Trajectory.from_dict(a_trajectory(), sailbox_id="sb-123").to_dict()

    assert "sailbox_id" not in emitted


def test_emitted_trajectories_validate_against_the_locked_schema() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    validator = jsonschema.Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))

    emitted = Trajectory.from_dict(a_trajectory()).to_dict()

    assert list(validator.iter_errors(emitted)) == []


# --- fan-out -------------------------------------------------------------------


def test_fanout_branches_from_the_checkpoint_id(fake_sail) -> None:
    sail = fake_sail()

    children = checkpoint_fanout(sail.base, ["branch-0", "branch-1", "branch-2"])

    # It is `.checkpoint_id`. SailboxCheckpoint has no `.id`, and reaching for
    # one raises AttributeError - so a regression here fails on the fake too.
    assert sail.from_checkpoint_ids == ["ckpt-sb-base"] * 3
    assert not hasattr(FakeCheckpoint("x"), "id")
    assert sail.child_names == ["branch-0", "branch-1", "branch-2"]
    assert len({child.sailbox_id for child in children}) == 3


def test_fanout_takes_a_durable_checkpoint(fake_sail) -> None:
    sail = fake_sail()

    checkpoint_fanout(sail.base, ["a"], ttl_seconds=1800)

    assert ("sb-base", "checkpoint ttl=1800") in sail.base.log


async def test_the_base_is_fully_seeded_before_it_is_checkpointed(fake_sail) -> None:
    sail = fake_sail()
    search = BranchingSearch(api_key="sk-test", launcher=ScriptedLauncher())

    await search.search(TASK, "job1234")

    # Checkpointing with an exec in flight loses it in the children, so the seed
    # must have completed first.
    base_actions = [action for box, action in sail.base.log if box == "sb-base"]
    seed = next(i for i, a in enumerate(base_actions) if "python3" in a)
    checkpoint = next(i for i, a in enumerate(base_actions) if a.startswith("checkpoint"))
    assert seed < checkpoint
    assert f"{BRANCH_DIR}/branch_agent.py" in sail.base.fs.files


async def test_one_request_yields_three_trajectories_from_three_boxes(fake_sail) -> None:
    fake_sail()
    launcher = ScriptedLauncher()
    search = BranchingSearch(api_key="sk-test", launcher=launcher)

    trajectories = await search.search(TASK, "job1234")

    assert len(trajectories) == 3
    assert len({t.sailbox_id for t in trajectories}) == 3
    assert [t.branch_id for t in trajectories] == ["b0", "b1", "b2"]
    assert all(len(t.steps) >= 2 for t in trajectories)


async def test_every_box_is_terminated_including_the_base(fake_sail) -> None:
    sail = fake_sail()
    search = BranchingSearch(api_key="sk-test", launcher=ScriptedLauncher())

    await search.search(TASK, "job1234")

    assert sail.base.terminated == 1
    assert [child.terminated for child in sail.children] == [1, 1, 1]


async def test_boxes_are_terminated_even_when_a_branch_explodes(fake_sail) -> None:
    sail = fake_sail()
    search = BranchingSearch(
        api_key="sk-test", launcher=ScriptedLauncher(fail={"b0", "b1", "b2"})
    )

    await search.search(TASK, "job1234")

    assert sail.base.terminated == 1
    assert all(child.terminated == 1 for child in sail.children)


async def test_one_dead_branch_does_not_cost_the_other_two(fake_sail) -> None:
    fake_sail()
    search = BranchingSearch(api_key="sk-test", launcher=ScriptedLauncher(fail={"b1"}))

    trajectories = await search.search(TASK, "job1234")

    by_id = {t.branch_id: t for t in trajectories}
    assert by_id["b0"].success_signal is True
    assert by_id["b2"].success_signal is True
    # The failure is still a comparable trajectory rather than a hole.
    assert by_id["b1"].error == "RuntimeError: b1 exploded"
    assert by_id["b1"].steps


async def test_branches_are_namespaced_by_app_so_sessions_cannot_collide(fake_sail) -> None:
    sail = fake_sail()
    search = BranchingSearch(
        api_key="sk-test", app="branch-search", launcher=ScriptedLauncher()
    )

    await search.search(TASK, "job1234")

    assert sail.found_app == {"name": "branch-search", "mint_if_missing": True}


async def test_an_empty_request_is_refused_before_any_box_is_booted(fake_sail) -> None:
    sail = fake_sail()
    search = BranchingSearch(api_key="sk-test", launcher=ScriptedLauncher())

    with pytest.raises(ValueError, match="must not be empty"):
        await search.search("   ", "job1234")

    assert sail.created == []


# --- angles --------------------------------------------------------------------


def test_the_shipped_angles_are_genuinely_different() -> None:
    assert len(DEFAULT_ANGLES) == 3
    assert len({angle.directive for angle in DEFAULT_ANGLES}) == 3
    assert len({angle.angle for angle in DEFAULT_ANGLES}) == 3
    assert len({angle.branch_id for angle in DEFAULT_ANGLES}) == 3


def test_duplicate_directives_are_refused_up_front() -> None:
    same = Angle(branch_id="b0", angle="one", directive="identical")
    # Identical prompts produce identical trajectories and the judge has nothing
    # to compare. Cheaper to catch here than after three real box runs.
    with pytest.raises(ValueError, match="distinct directive"):
        BranchingSearch(
            api_key="sk-test",
            angles=[same, Angle(branch_id="b1", angle="two", directive="identical")],
        )


async def test_each_branch_is_given_its_own_angle(fake_sail) -> None:
    fake_sail()
    launcher = ScriptedLauncher()
    search = BranchingSearch(api_key="sk-test", launcher=launcher)

    trajectories = await search.search(TASK, "job1234")

    assert [angle.branch_id for _, angle, _ in _seen(launcher)] == ["b0", "b1", "b2"]
    assert len({t.angle for t in trajectories}) == 3


def _seen(launcher: ScriptedLauncher) -> list[tuple[str, Angle, str]]:
    by_id = {angle.branch_id: angle for angle in DEFAULT_ANGLES}
    return [(box, by_id[branch], task) for box, branch, task in launcher.seen]


# --- the in-box launcher -------------------------------------------------------


async def test_the_launcher_hands_the_box_its_own_angle_and_the_task() -> None:
    box = FakeBox("sb-0", result=a_trajectory("b0"))
    launcher = InBoxAgentLauncher(api_key="sk-test", poll_interval_seconds=0)

    await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    job = json.loads(box.fs.files[f"{BRANCH_DIR}/{branch_agent.JOB_FILE}"])
    assert job["branch_id"] == "b0"
    assert job["task"] == TASK
    assert job["directive"] == DEFAULT_ANGLES[0].directive
    assert job["completion_window"] == branch_agent.DEFAULT_COMPLETION_WINDOW


async def test_the_agent_is_launched_detached() -> None:
    box = FakeBox("sb-0", result=a_trajectory("b0"))
    launcher = InBoxAgentLauncher(api_key="sk-test", poll_interval_seconds=0)

    await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    launch = next(c for c in box.commands if "branch_agent.py" in c)
    # Anything tied to an in-flight exec() session is reaped in a branched box.
    assert "setsid nohup" in launch
    assert launch.rstrip().endswith("& echo launched")


async def test_the_credential_rides_in_the_environment_not_the_job_file() -> None:
    box = FakeBox("sb-0", result=a_trajectory("b0"))
    launcher = InBoxAgentLauncher(api_key="sk-secret", poll_interval_seconds=0)

    await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    launch_index = next(i for i, c in enumerate(box.commands) if "branch_agent.py" in c)
    assert box.envs[launch_index] == {"SAIL_API_KEY": "sk-secret"}
    assert "sk-secret" not in json.dumps(box.fs.files)


async def test_the_launcher_reads_back_what_the_branch_wrote() -> None:
    box = FakeBox("sb-0", result=a_trajectory("b0", final_answer="Trattoria Nove"))
    launcher = InBoxAgentLauncher(api_key="sk-test", poll_interval_seconds=0)

    trajectory = await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    assert trajectory.final_answer == "Trattoria Nove"
    assert trajectory.sailbox_id == "sb-0"
    assert len(trajectory.steps) == 2


async def test_a_branch_that_never_reports_is_salvaged_from_its_step_log() -> None:
    partial = [
        {"i": 0, "t": 0.0, "kind": "think", "action": "plan", "outcome": "ok"},
        {"i": 1, "t": 4.0, "kind": "shell", "action": "run", "outcome": "error"},
    ]
    box = FakeBox("sb-0", result=a_trajectory("b0"), never_finishes=True, partial_steps=partial)
    launcher = InBoxAgentLauncher(
        api_key="sk-test",
        poll_interval_seconds=0,
        deadline_seconds=0,
        poll_slack_seconds=0,
    )

    trajectory = await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    # steps.jsonl is appended as work happens precisely so this is possible: a
    # partial trajectory is evidence, a missing one is a hole in the comparison.
    assert trajectory.error == "branch_timeout"
    assert trajectory.success_signal is False
    assert [step.i for step in trajectory.steps] == [0, 1]


async def test_a_branch_with_nothing_to_salvage_still_produces_one_step() -> None:
    box = FakeBox("sb-0", never_finishes=True)
    launcher = InBoxAgentLauncher(
        api_key="sk-test",
        poll_interval_seconds=0,
        deadline_seconds=0,
        poll_slack_seconds=0,
    )

    trajectory = await launcher.launch(box, DEFAULT_ANGLES[0], TASK)

    assert len(trajectory.steps) == 1  # minItems is 1
    assert trajectory.steps[0].outcome == "error"


# --- what gets shipped into the box --------------------------------------------


def test_the_in_box_program_is_standalone() -> None:
    source = agent_source()

    # It is written into a box that has never heard of this package, so a
    # relative import would only fail once it is already running remotely.
    assert "from ." not in source
    assert "from runbook_voice" not in source
    assert "import sail" not in source


# --- Invariant 1 ---------------------------------------------------------------


def test_the_search_cannot_reach_the_code_that_performs_irreversible_steps() -> None:
    # Structural half of Invariant 1: RunbookExecutor and ConfirmationGate are
    # the only code in the repo that performs a gated irreversible step, and
    # nothing here imports or names them. The other half is
    # branch_agent.screen_command. Parsed rather than grepped so that saying so
    # in a docstring is not mistaken for doing so.
    tree = ast.parse((ROOT / "src" / "runbook_voice" / "branch_search.py").read_text())

    modules: set[str] = set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            modules.add(node.module or "")
        elif isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)

    assert not any("executor" in module for module in modules)
    assert {"RunbookExecutor", "ConfirmationGate", "confirm"} & names == set()


# --- dropping into TON-14's coordinator ----------------------------------------


async def test_run_persists_the_trajectories_and_summarizes_them(
    fake_sail, tmp_path: Path
) -> None:
    fake_sail()
    search = BranchingSearch(
        api_key="sk-test", launcher=ScriptedLauncher(), output_dir=tmp_path
    )

    summary = await search.run(TASK, "job1234")

    written = sorted((tmp_path / "job1234").glob("*.json"))
    assert [path.name for path in written] == ["b0.json", "b1.json", "b2.json"]
    assert json.loads(written[0].read_text())["branch_id"] == "b0"
    assert "3 approaches" in summary
    # Ranking belongs to the judge; this must not smuggle in a winner.
    assert "winner" not in summary.lower()
    assert "best" not in summary.lower()


async def test_the_search_drops_into_the_cold_task_coordinator(
    fake_sail, tmp_path: Path
) -> None:
    fake_sail()
    search = BranchingSearch(
        api_key="sk-test", launcher=ScriptedLauncher(), output_dir=tmp_path
    )
    spoken: list[tuple[str, NotificationKind]] = []

    class Notifier:
        async def notify(self, job_id: str, text: str, kind: NotificationKind) -> None:
            spoken.append((text, kind))

    async with ColdTaskCoordinator(search, Notifier()) as coordinator:
        job = await coordinator.submit_no_match(TASK)
        finished = await coordinator.wait(job.id)

    assert finished.status is JobStatus.SUCCEEDED
    assert [kind for _, kind in spoken] == [
        NotificationKind.ACKNOWLEDGEMENT,
        NotificationKind.RESULT,
    ]
    assert "3 approaches" in finished.result


async def test_branches_run_concurrently_rather_than_one_after_another(fake_sail) -> None:
    fake_sail()
    running = 0
    peak = 0

    class SlowLauncher(ScriptedLauncher):
        async def launch(self, box: Any, angle: Angle, task: str) -> Trajectory:
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0)
            running -= 1
            return await super().launch(box, angle, task)

    search = BranchingSearch(api_key="sk-test", launcher=SlowLauncher())
    await search.search(TASK, "job1234")

    # Concurrency is the entire latency argument for branching at all.
    assert peak == 3
