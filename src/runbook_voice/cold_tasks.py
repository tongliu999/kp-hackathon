"""Asynchronous coordination for cold tasks that outlive a voice turn."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from enum import Enum
import time
from typing import Callable, Protocol
from uuid import uuid4

from .voice import AudioOutput, Synthesizer


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in {self.SUCCEEDED, self.FAILED, self.CANCELLED}


class NotificationKind(str, Enum):
    ACKNOWLEDGEMENT = "acknowledgement"
    RESULT = "result"


class ColdTaskError(RuntimeError):
    """Base class for coordinator-facing errors."""


class CoordinatorClosedError(ColdTaskError):
    pass


class JobNotFoundError(ColdTaskError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"cold-task job not found: {job_id}")
        self.job_id = job_id


class NotificationError(ColdTaskError):
    def __init__(self, job_id: str, kind: NotificationKind, detail: str) -> None:
        super().__init__(f"{kind.value} notification failed for {job_id}: {detail}")
        self.job_id = job_id
        self.kind = kind


@dataclass(frozen=True, slots=True)
class JobSnapshot:
    id: str
    request: str
    status: JobStatus
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    result: str | None = None
    error: str | None = None


class ColdTaskWorker(Protocol):
    async def run(self, request: str, job_id: str) -> str: ...


class VoiceNotifier(Protocol):
    async def notify(
        self, job_id: str, text: str, kind: NotificationKind
    ) -> None: ...


class SynthesizedVoiceNotifier:
    """Adapt TON-6's synchronous voice interfaces to async notifications."""

    def __init__(self, synthesizer: Synthesizer, audio_output: AudioOutput) -> None:
        self._synthesizer = synthesizer
        self._output = audio_output
        # Most speaker/call adapters are single-channel. Keep synthesis and
        # playback paired so concurrent callbacks cannot interleave audio.
        self._voice_lock = asyncio.Lock()

    async def notify(self, job_id: str, text: str, kind: NotificationKind) -> None:
        del job_id, kind
        async with self._voice_lock:
            audio = await asyncio.to_thread(self._synthesizer.synthesize, text)
            await asyncio.to_thread(self._output.play, audio)


@dataclass(frozen=True, slots=True)
class DelayedEchoWorker:
    """Side-effect-free stand-in for a long cold-task agent run."""

    delay_seconds: float = 180.0
    prefix: str = "Completed cold task: "

    def __post_init__(self) -> None:
        if self.delay_seconds < 0:
            raise ValueError("delay_seconds must be non-negative")

    async def run(self, request: str, job_id: str) -> str:
        del job_id
        await asyncio.sleep(self.delay_seconds)
        return f"{self.prefix}{request}"


class ColdTaskCoordinator:
    """Own background jobs and proactively notify when each one completes.

    ``submit_no_match`` awaits only the acknowledgement. The worker is started
    in a tracked asyncio task before the method returns, leaving the caller free
    to release the conversation and accept another utterance.
    """

    def __init__(
        self,
        worker: ColdTaskWorker,
        notifier: VoiceNotifier,
        *,
        acknowledgement: str = "I'll get back to you.",
        completion_template: str = "Your result is ready: {result}",
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not acknowledgement.strip():
            raise ValueError("acknowledgement must not be empty")
        if "{result}" not in completion_template:
            raise ValueError("completion_template must include {result}")
        self._worker = worker
        self._notifier = notifier
        self._acknowledgement = acknowledgement
        self._completion_template = completion_template
        self._id_factory = id_factory or (lambda: uuid4().hex)
        self._clock = clock
        self._jobs: dict[str, JobSnapshot] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._submissions: set[asyncio.Task[object]] = set()
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def submit_no_match(self, request: str) -> JobSnapshot:
        request = request.strip()
        if not request:
            raise ValueError("cold-task request must not be empty")
        if self._closed:
            raise CoordinatorClosedError("cold-task coordinator is closed")

        submission = asyncio.current_task()
        if submission is not None:
            self._submissions.add(submission)
        try:
            job_id = self._new_job_id()
            job = JobSnapshot(
                id=job_id,
                request=request,
                status=JobStatus.PENDING,
                created_at=self._clock(),
            )
            self._jobs[job_id] = job
            try:
                await self._notifier.notify(
                    job_id, self._acknowledgement, NotificationKind.ACKNOWLEDGEMENT
                )
            except asyncio.CancelledError:
                self._mark_cancelled(job_id)
                raise
            except Exception as exc:
                detail = _error_detail(exc)
                self._jobs[job_id] = replace(
                    job,
                    status=JobStatus.FAILED,
                    finished_at=self._clock(),
                    error=f"acknowledgement notification failed: {detail}",
                )
                raise NotificationError(
                    job_id, NotificationKind.ACKNOWLEDGEMENT, detail
                ) from exc

            # A concurrent shutdown waits for in-flight submissions before it
            # collects tasks, so this job cannot escape lifecycle management.
            task = asyncio.create_task(self._execute(job_id), name=f"cold-task:{job_id}")
            self._tasks[job_id] = task
            return self._jobs[job_id]
        finally:
            if submission is not None:
                self._submissions.discard(submission)

    def get(self, job_id: str) -> JobSnapshot:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise JobNotFoundError(job_id) from exc

    def list_jobs(self) -> tuple[JobSnapshot, ...]:
        return tuple(self._jobs.values())

    async def wait(self, job_id: str) -> JobSnapshot:
        job = self.get(job_id)
        task = self._tasks.get(job_id)
        if task is not None and not job.status.terminal:
            # Cancelling a caller that is merely observing a job must not cancel
            # the independently owned background task.
            await asyncio.shield(task)
        return self.get(job_id)

    async def cancel(self, job_id: str) -> JobSnapshot:
        job = self.get(job_id)
        if job.status.terminal:
            return job
        task = self._tasks.get(job_id)
        if task is None:
            self._mark_cancelled(job_id)
            return self.get(job_id)
        task.cancel()
        # A task cancelled before its coroutine first runs never reaches the
        # CancelledError handler in _execute, so record cancellation here too.
        self._mark_cancelled(job_id)
        await asyncio.gather(task, return_exceptions=True)
        return self.get(job_id)

    async def close(self, *, cancel_pending: bool = True) -> None:
        if self._closed and not self._submissions and not self._active_tasks():
            return
        self._closed = True

        current = asyncio.current_task()
        submissions = [task for task in self._submissions if task is not current]
        if submissions:
            await asyncio.gather(*submissions, return_exceptions=True)

        tasks = self._active_tasks()
        if cancel_pending:
            for job_id, task in self._tasks.items():
                if task not in tasks:
                    continue
                task.cancel()
                self._mark_cancelled(job_id)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def __aenter__(self) -> "ColdTaskCoordinator":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.close(cancel_pending=True)

    async def _execute(self, job_id: str) -> None:
        job = self._jobs[job_id]
        self._jobs[job_id] = replace(
            job, status=JobStatus.RUNNING, started_at=self._clock()
        )
        try:
            result = await self._worker.run(job.request, job_id)
            result = result.strip()
            if not result:
                raise ValueError("cold-task worker returned an empty result")
        except asyncio.CancelledError:
            self._mark_cancelled(job_id)
            return
        except Exception as exc:
            self._jobs[job_id] = replace(
                self._jobs[job_id],
                status=JobStatus.FAILED,
                finished_at=self._clock(),
                error=_error_detail(exc),
            )
            return
        self._jobs[job_id] = replace(self._jobs[job_id], result=result)
        message = self._completion_template.format(result=result)
        try:
            await self._notifier.notify(job_id, message, NotificationKind.RESULT)
        except asyncio.CancelledError:
            self._mark_cancelled(job_id)
            return
        except Exception as exc:
            self._jobs[job_id] = replace(
                self._jobs[job_id],
                status=JobStatus.FAILED,
                finished_at=self._clock(),
                error=f"result notification failed: {_error_detail(exc)}",
            )
            return
        self._jobs[job_id] = replace(
            self._jobs[job_id],
            status=JobStatus.SUCCEEDED,
            finished_at=self._clock(),
        )

    def _mark_cancelled(self, job_id: str) -> None:
        job = self._jobs[job_id]
        if job.status.terminal:
            return
        self._jobs[job_id] = replace(
            job,
            status=JobStatus.CANCELLED,
            finished_at=self._clock(),
            error="cancelled",
        )

    def _new_job_id(self) -> str:
        job_id = self._id_factory().strip()
        if not job_id:
            raise ValueError("id_factory returned an empty job ID")
        if job_id in self._jobs:
            raise ValueError(f"id_factory returned duplicate job ID: {job_id}")
        return job_id

    def _active_tasks(self) -> list[asyncio.Task[None]]:
        return [task for task in self._tasks.values() if not task.done()]


def _error_detail(error: BaseException) -> str:
    detail = str(error).strip()
    return detail or type(error).__name__
