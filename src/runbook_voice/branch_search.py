"""Bounded branching search: one unknown task, distinct boxes and trajectories.

The shape is fixed by measurement rather than taste (see ``sail-notes.md``):

* **Checkpoint fan-out, not fork x3.** 3.8s vs 11.0s median over 5 runs, and the
    checkpoint is durable — the base box can die and children still start. The
    parent planner may choose a different count within its configured limit.
* **Detached branch work.** Anything tied to an in-flight ``exec()`` session is
  reaped in the child, so the agent is launched with ``setsid nohup`` and the
  orchestrator polls for a marker instead of holding the session open.
* **Nothing in flight at checkpoint time.** The base box is seeded to completion
  *before* ``checkpoint()`` is called.

**Invariant 1 is load-bearing here: branches never book.**  Structurally, this
module has no import of :mod:`.executor` — ``RunbookExecutor`` and
``ConfirmationGate``, the only code in the repo that performs a gated
irreversible step, are unreachable from a branch.  A branch's own second layer
is :func:`.branch_agent.screen_command`.

``BranchingSearch`` satisfies the ``ColdTaskWorker`` protocol from
:mod:`.cold_tasks`, so it drops into TON-14's coordinator with no new plumbing.
It does **not** pick a winner: ranking is the judge's job, and a placeholder
heuristic here would only be something the judge later has to displace.
"""

from __future__ import annotations

import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

from . import branch_agent
from .sailbox import SailboxError, boot

DEFAULT_APP = "branch-search"
DEFAULT_SIZE = "s"
BRANCH_DIR = branch_agent.BRANCH_DIR
CHECKPOINT_TTL_SECONDS = 3600

# python3 is not guaranteed in the Debian base image. Installing it on the base
# box means every selected child inherits it — which is what a checkpoint is for.
SEED_COMMAND = (
    f"mkdir -p {BRANCH_DIR} && "
    "(command -v python3 >/dev/null 2>&1 || "
    "(apt-get update -qq && apt-get install -y -qq python3))"
)


@dataclass(frozen=True, slots=True)
class Angle:
    """One branch's assigned approach.

    ``angle`` is recorded verbatim in the trajectory so the judge can name what
    it is comparing; ``directive`` is the prompt text that makes the attempts
    actually diverge.  Identical prompts produce identical trajectories and the
    judge has nothing to compare — so these must genuinely differ.
    """

    branch_id: str
    angle: str
    directive: str


DEFAULT_ANGLES: tuple[Angle, ...] = (
    Angle(
        branch_id="b0",
        angle="Go straight to the single most obvious primary source and take the first result that satisfies every stated constraint",
        directive=(
            "Go directly to the one service most people would use for this and drive "
            "it the intended way. Treat every constraint in the request as hard. Take "
            "the first candidate that satisfies all of them and stop. Do not survey "
            "alternatives — depth on the obvious path is your job."
        ),
    ),
    Angle(
        branch_id="b1",
        angle="Build a candidate list from an independent source first, then cross-check each candidate against the primary source",
        directive=(
            "Do not trust the default ranking of whatever service handles this. Build "
            "your own shortlist first from an independent source — editorial lists, "
            "reviews, community recommendations — and only then check each candidate "
            "against the primary service one at a time. Quality of the shortlist is "
            "what you are contributing; say so when a candidate fails the check."
        ),
    ),
    Angle(
        branch_id="b2",
        angle="Identify the constraint the user is likeliest to flex on, relax it, and optimise a different axis instead",
        directive=(
            "Assume the request is over-specified. Work out which single constraint a "
            "person would most likely bend on, relax exactly that one, and optimise "
            "hard on a different axis instead. State plainly which constraint you "
            "relaxed and what you bought with it — a better option that misses one "
            "detail is a real answer, and the judge needs the trade named."
        ),
    ),
)


@dataclass(frozen=True, slots=True)
class Step:
    """One recorded step, mirroring ``schema/trajectory.schema.json``."""

    i: int
    t: float
    action: str
    outcome: str
    kind: str | None = None
    args: Mapping[str, Any] | None = None
    url: str | None = None
    observation_excerpt: str | None = None
    note: str | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Step":
        return cls(
            i=int(data["i"]),
            t=float(data["t"]),
            action=str(data["action"]),
            outcome=str(data["outcome"]),
            kind=data.get("kind"),
            args=data.get("args"),
            url=data.get("url"),
            observation_excerpt=data.get("observation_excerpt"),
            note=data.get("note"),
        )

    def to_dict(self) -> dict[str, Any]:
        step: dict[str, Any] = {"i": self.i, "t": self.t}
        if self.kind:
            step["kind"] = self.kind
        step["action"] = self.action
        if self.args:
            step["args"] = dict(self.args)
        if self.url:
            step["url"] = self.url
        if self.observation_excerpt is not None:
            step["observation_excerpt"] = branch_agent.truncate(self.observation_excerpt)
        step["outcome"] = self.outcome
        if self.note:
            step["note"] = self.note
        return step


@dataclass(frozen=True, slots=True)
class Trajectory:
    """What one branch did.  ``to_dict`` emits exactly the locked schema.

    ``sailbox_id`` is deliberately *not* serialized: the schema sets
    ``additionalProperties: false``, so an extra key would make every emitted
    trajectory invalid.  It exists so the demo can name which box produced what.
    """

    branch_id: str
    angle: str
    task: str
    steps: tuple[Step, ...]
    success_signal: bool
    wall_ms: int
    final_answer: str | None = None
    error: str | None = None
    sailbox_id: str | None = field(default=None, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], *, sailbox_id: str | None = None) -> "Trajectory":
        return cls(
            branch_id=str(data["branch_id"]),
            angle=str(data["angle"]),
            task=str(data["task"]),
            steps=tuple(Step.from_dict(step) for step in data["steps"]),
            success_signal=bool(data["success_signal"]),
            wall_ms=int(data["wall_ms"]),
            final_answer=data.get("final_answer"),
            error=data.get("error"),
            sailbox_id=sailbox_id,
        )

    def to_dict(self) -> dict[str, Any]:
        trajectory: dict[str, Any] = {
            "branch_id": self.branch_id,
            "angle": self.angle,
            "task": self.task,
            "steps": [step.to_dict() for step in self.steps],
        }
        if self.final_answer is not None:
            trajectory["final_answer"] = self.final_answer
        trajectory["success_signal"] = self.success_signal
        trajectory["wall_ms"] = self.wall_ms
        if self.error:
            trajectory["error"] = self.error
        return trajectory

    @property
    def abandoned_steps(self) -> int:
        return sum(1 for step in self.steps if step.outcome == "abandoned")


class BranchLauncher(Protocol):
    """Run one branch in one already-created box and bring back its trajectory.

    Like ``PersistentSailboxRunner`` in :mod:`.executor`, this owns no lifecycle:
    the box is handed in.  That keeps the fan-out testable without Sail and keeps
    box ownership in one place.
    """

    async def launch(self, box: Any, angle: Angle, task: str) -> Trajectory: ...


@dataclass(frozen=True, slots=True)
class InBoxAgentLauncher:
    """Run :mod:`.branch_agent` detached inside a box and poll for its result."""

    api_key: str
    model: str = branch_agent.DEFAULT_MODEL
    completion_window: str = branch_agent.DEFAULT_COMPLETION_WINDOW
    max_steps: int = branch_agent.DEFAULT_MAX_STEPS
    deadline_seconds: float = branch_agent.DEFAULT_DEADLINE_SECONDS
    poll_interval_seconds: float = 3.0
    # Slack over the branch's own deadline: the agent should stop itself first,
    # and this only fires if the box or the process died without writing DONE.
    poll_slack_seconds: float = 120.0

    async def launch(self, box: Any, angle: Angle, task: str) -> Trajectory:
        started = time.monotonic()
        job = {
            "branch_id": angle.branch_id,
            "angle": angle.angle,
            "directive": angle.directive,
            "task": task,
            "model": self.model,
            "completion_window": self.completion_window,
            "max_steps": self.max_steps,
            "deadline_seconds": self.deadline_seconds,
        }
        await asyncio.to_thread(
            box.fs.write, f"{BRANCH_DIR}/{branch_agent.JOB_FILE}", json.dumps(job)
        )

        # Detached, or it is reaped with the exec session that started it.
        # The key rides in the environment rather than the job file so it is
        # never written to the box's disk.
        await asyncio.to_thread(
            box.run,
            f"setsid nohup python3 {BRANCH_DIR}/branch_agent.py --dir {BRANCH_DIR} "
            f"> {BRANCH_DIR}/agent.log 2>&1 < /dev/null & echo launched",
            env={"SAIL_API_KEY": self.api_key},
        )

        if await self._wait_for_done(box, started):
            raw = await asyncio.to_thread(
                box.fs.read, f"{BRANCH_DIR}/{branch_agent.TRAJECTORY_FILE}"
            )
            text = raw.decode() if isinstance(raw, bytes) else str(raw)
            return Trajectory.from_dict(json.loads(text), sailbox_id=_box_id(box))

        return await self._salvage(box, angle, task, started)

    async def _wait_for_done(self, box: Any, started: float) -> bool:
        limit = self.deadline_seconds + self.poll_slack_seconds
        while time.monotonic() - started < limit:
            result = await asyncio.to_thread(
                box.run, f"cat {BRANCH_DIR}/{branch_agent.DONE_FILE} 2>/dev/null || true"
            )
            if "done" in _stdout(result):
                return True
            await asyncio.sleep(self.poll_interval_seconds)
        return False

    async def _salvage(
        self, box: Any, angle: Angle, task: str, started: float
    ) -> Trajectory:
        """Build a trajectory from whatever the branch managed to write.

        ``steps.jsonl`` is appended as work happens precisely so a branch that
        never finishes still contributes evidence.  A partial trajectory is
        useful to the judge; a missing one is a hole in the comparison.
        """
        steps: list[Step] = []
        try:
            result = await asyncio.to_thread(
                box.run, f"cat {BRANCH_DIR}/{branch_agent.STEPS_FILE} 2>/dev/null || true"
            )
            for line in _stdout(result).splitlines():
                line = line.strip()
                if line:
                    steps.append(Step.from_dict(json.loads(line)))
        except Exception:  # salvage is best-effort; never mask the timeout itself
            steps = []

        if not steps:
            steps = [
                Step(
                    i=0,
                    t=0.0,
                    kind="think",
                    action="start",
                    outcome="error",
                    observation_excerpt="Branch never reported; no steps recovered.",
                )
            ]
        return Trajectory(
            branch_id=angle.branch_id,
            angle=angle.angle,
            task=task,
            steps=tuple(steps),
            success_signal=False,
            wall_ms=int((time.monotonic() - started) * 1000),
            error="branch_timeout",
            sailbox_id=_box_id(box),
        )


def checkpoint_fanout(
    base: Any,
    names: Sequence[str],
    *,
    ttl_seconds: int = CHECKPOINT_TTL_SECONDS,
) -> list[Any]:
    """Branch ``base`` into one child per name, concurrently.

    Checkpoint fan-out rather than ``fork()`` per child: the original three-child
    measurement was 3.8s vs 11.0s median, and the checkpoint outlives the parent.

    The caller must have finished seeding the base box first — an ``exec()``
    still in flight is reaped in the children.
    """
    checkpoint = base.checkpoint(ttl_seconds=ttl_seconds)
    # It is `.checkpoint_id`. `SailboxCheckpoint` has no `.id`, and reaching for
    # one raises AttributeError.
    checkpoint_id = checkpoint.checkpoint_id
    sail = _sail()

    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        return list(
            pool.map(
                lambda name: sail.Sailbox.from_checkpoint(checkpoint_id, name=name),
                names,
            )
        )


class BranchingSearch:
    """Attempt an unknown request through distinct angles and collect evidence.

    Satisfies ``ColdTaskWorker``: ``await search.run(request, job_id)`` returns a
    short spoken summary, and the trajectories land under ``output_dir/job_id``.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        app: str = DEFAULT_APP,
        size: str = DEFAULT_SIZE,
        angles: Sequence[Angle] = DEFAULT_ANGLES,
        launcher: BranchLauncher | None = None,
        output_dir: Path | str = "runs",
        keep_boxes: bool = False,
        progress: Callable[[str], None] | None = None,
    ) -> None:
        if not angles:
            raise ValueError("branching search needs at least one angle")
        distinct = {angle.directive for angle in angles}
        if len(distinct) != len(angles):
            # Identical prompts produce identical trajectories and the judge has
            # nothing to compare. Catch it here rather than after three box runs.
            raise ValueError("every branch angle must have a distinct directive")

        self._app = app
        self._size = size
        self._angles = tuple(angles)
        self._launcher = launcher or InBoxAgentLauncher(
            api_key=api_key or resolve_api_key()
        )
        self._output_dir = Path(output_dir)
        self._keep_boxes = keep_boxes
        self._progress = progress or (lambda _message: None)
        self.last_boxes: tuple[str | None, ...] = ()

    @property
    def angles(self) -> tuple[Angle, ...]:
        return self._angles

    async def run(self, request: str, job_id: str) -> str:
        trajectories = await self.search(request, job_id)
        paths = self.persist(trajectories, job_id)
        completed = sum(1 for t in trajectories if t.success_signal)
        return (
            f"Tried {len(trajectories)} approaches to \"{request}\". "
            f"{completed} reported success. "
            f"Trajectories written to {paths[0].parent if paths else self._output_dir / job_id}."
        )

    async def search(self, request: str, job_id: str) -> tuple[Trajectory, ...]:
        """Boot, fan out, run every branch concurrently, and clean up."""
        request = request.strip()
        if not request:
            raise ValueError("branching search request must not be empty")

        base_handle = await asyncio.to_thread(
            boot, f"base-{job_id[:8]}", app=self._app, size=self._size
        )
        children: list[Any] = []
        try:
            self._progress(
                f"base box {base_handle.sailbox_id} up in "
                f"{base_handle.elapsed_seconds:.1f}s (app={self._app})"
            )
            started = time.monotonic()
            await asyncio.to_thread(self._seed, base_handle.box)
            self._progress(f"base seeded in {time.monotonic() - started:.1f}s")

            started = time.monotonic()
            children = await asyncio.to_thread(
                checkpoint_fanout,
                base_handle.box,
                [f"branch-{angle.branch_id}-{job_id[:8]}" for angle in self._angles],
            )
            self.last_boxes = tuple(_box_id(child) for child in children)
            self._progress(
                f"checkpoint fan-out: {len(children)} children in "
                f"{time.monotonic() - started:.1f}s "
                f"({', '.join(str(box) for box in self.last_boxes)})"
            )

            results = await asyncio.gather(
                *(
                    self._launcher.launch(child, angle, request)
                    for child, angle in zip(children, self._angles)
                ),
                return_exceptions=True,
            )
            trajectories = tuple(
                self._as_trajectory(result, angle, request, child)
                for result, angle, child in zip(results, self._angles, children)
            )
            for trajectory in trajectories:
                self._progress(
                    f"{trajectory.branch_id}: {len(trajectory.steps)} steps in "
                    f"{trajectory.wall_ms / 1000:.1f}s, "
                    f"success_signal={trajectory.success_signal}"
                    + (f", error={trajectory.error}" if trajectory.error else "")
                )
            return trajectories
        finally:
            if not self._keep_boxes:
                await asyncio.to_thread(_terminate, [*children, base_handle.box])
                self._progress(f"terminated {len(children) + 1} boxes")

    def persist(self, trajectories: Sequence[Trajectory], job_id: str) -> list[Path]:
        directory = self._output_dir / job_id
        directory.mkdir(parents=True, exist_ok=True)
        paths = []
        for trajectory in trajectories:
            path = directory / f"{trajectory.branch_id}.json"
            path.write_text(json.dumps(trajectory.to_dict(), indent=2), encoding="utf-8")
            paths.append(path)
        return paths

    def _seed(self, base: Any) -> None:
        """Install python3 and the agent program on the base box.

        Both finish before the caller checkpoints. Seeding after the fan-out
        would mean doing it once per branch; seeding *during* one would mean
        checkpointing with an exec in flight, which the child would not inherit.
        """
        base.run(SEED_COMMAND, check=True)
        base.fs.write(f"{BRANCH_DIR}/branch_agent.py", agent_source())

    @staticmethod
    def _as_trajectory(
        result: Any, angle: Angle, request: str, box: Any
    ) -> Trajectory:
        if isinstance(result, Trajectory):
            return result
        # gather(return_exceptions=True): one branch blowing up must not cost the
        # other two, and the failure itself is comparable evidence.
        detail = f"{type(result).__name__}: {result}" if isinstance(result, BaseException) else str(result)
        return Trajectory(
            branch_id=angle.branch_id,
            angle=angle.angle,
            task=request,
            steps=(
                Step(
                    i=0,
                    t=0.0,
                    kind="think",
                    action="start",
                    outcome="error",
                    observation_excerpt=detail,
                ),
            ),
            success_signal=False,
            wall_ms=0,
            error=detail,
            sailbox_id=_box_id(box),
        )


def agent_source() -> str:
    """The in-box program's own source, to be written into a box verbatim."""
    return Path(branch_agent.__file__).read_text(encoding="utf-8")


def _terminate(boxes: Sequence[Any]) -> None:
    for box in boxes:
        try:
            box.terminate()
        except Exception:  # cleanup must never mask the result it is cleaning up after
            pass


def _box_id(box: Any) -> str | None:
    return getattr(box, "sailbox_id", None)


def _stdout(result: Any) -> str:
    """ExecResult's payload attribute is not stable across SDK versions."""
    for attribute in ("stdout", "stdout_text", "output"):
        value = getattr(result, attribute, None)
        if value is None:
            continue
        return value.decode() if isinstance(value, bytes) else str(value)
    return ""


def resolve_api_key() -> str:
    """The Sail credential the in-box agent needs to call Sail inference.

    ``Config.from_env`` reads ``SAIL_API_KEY`` first and falls back to the
    credential stored by ``sail auth login``, so a developer who has only logged
    in still gets a key to hand the guest.
    """
    sail = _sail()
    key = getattr(sail.Config.from_env(), "api_key", None)
    if not key:
        raise SailboxError(
            "no Sail credential found; run `sail auth login` or set SAIL_API_KEY"
        )
    return key


def _sail():
    try:
        import sail
    except ImportError as exc:
        raise SailboxError(
            "Sailbox support is not installed; run `pip install -e '.[sailbox]'`"
        ) from exc
    return sail


__all__ = [
    "Angle",
    "BranchLauncher",
    "BranchingSearch",
    "DEFAULT_ANGLES",
    "InBoxAgentLauncher",
    "Step",
    "Trajectory",
    "agent_source",
    "checkpoint_fanout",
    "resolve_api_key",
]
