from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import dataclass, field

import pytest

from runbook_voice.audio import AudioClip
from runbook_voice.cold_tasks import (
    ColdTaskCoordinator,
    CoordinatorClosedError,
    DelayedEchoWorker,
    JobNotFoundError,
    JobStatus,
    NotificationError,
    NotificationKind,
    SynthesizedVoiceNotifier,
)


@dataclass
class RecordingNotifier:
    events: list[tuple[str, str, NotificationKind]] = field(default_factory=list)
    fail_kind: NotificationKind | None = None
    acknowledgement_gate: asyncio.Event | None = None

    async def notify(self, job_id, text, kind):
        if kind is NotificationKind.ACKNOWLEDGEMENT and self.acknowledgement_gate:
            await self.acknowledgement_gate.wait()
        self.events.append((job_id, text, kind))
        if kind is self.fail_kind:
            raise RuntimeError("speaker unavailable")


@dataclass
class ControlledWorker:
    release: asyncio.Event = field(default_factory=asyncio.Event)
    started: list[tuple[str, str]] = field(default_factory=list)
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)

    async def run(self, request, job_id):
        self.started.append((job_id, request))
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        return f"answer for {request}"


class FailingWorker:
    async def run(self, request, job_id):
        raise RuntimeError(f"agent failed for {request} ({job_id})")


def ids(*values: str):
    iterator: Iterator[str] = iter(values)
    return lambda: next(iterator)


@pytest.mark.asyncio
async def test_no_match_acknowledges_then_releases_while_job_runs() -> None:
    worker = ControlledWorker()
    notifier = RecordingNotifier()
    coordinator = ColdTaskCoordinator(worker, notifier, id_factory=ids("job-1"))

    submitted = await coordinator.submit_no_match("find a hard answer")

    assert submitted.id == "job-1"
    assert submitted.status is JobStatus.PENDING
    assert notifier.events == [
        ("job-1", "I'll get back to you.", NotificationKind.ACKNOWLEDGEMENT)
    ]
    await asyncio.sleep(0)
    assert worker.started == [("job-1", "find a hard answer")]
    assert coordinator.get("job-1").status is JobStatus.RUNNING

    worker.release.set()
    finished = await coordinator.wait("job-1")

    assert finished.status is JobStatus.SUCCEEDED
    assert finished.result == "answer for find a hard answer"
    assert finished.error is None
    assert notifier.events[-1] == (
        "job-1",
        "Your result is ready: answer for find a hard answer",
        NotificationKind.RESULT,
    )


@pytest.mark.asyncio
async def test_pending_job_survives_other_utterances() -> None:
    worker = ControlledWorker()
    notifier = RecordingNotifier()
    coordinator = ColdTaskCoordinator(
        worker, notifier, id_factory=ids("job-a", "job-b")
    )

    first = await coordinator.submit_no_match("first utterance")
    second = await coordinator.submit_no_match("other utterance")
    await asyncio.sleep(0)

    assert [job.id for job in coordinator.list_jobs()] == ["job-a", "job-b"]
    assert coordinator.get(first.id).status is JobStatus.RUNNING
    assert coordinator.get(second.id).status is JobStatus.RUNNING
    worker.release.set()
    final = await asyncio.gather(coordinator.wait(first.id), coordinator.wait(second.id))

    assert [job.status for job in final] == [JobStatus.SUCCEEDED, JobStatus.SUCCEEDED]
    assert [event[2] for event in notifier.events].count(NotificationKind.RESULT) == 2


@pytest.mark.asyncio
async def test_worker_failure_is_retained_and_not_spoken() -> None:
    notifier = RecordingNotifier()
    coordinator = ColdTaskCoordinator(
        FailingWorker(), notifier, id_factory=ids("failed-job")
    )

    job = await coordinator.submit_no_match("impossible")
    failed = await coordinator.wait(job.id)

    assert failed.status is JobStatus.FAILED
    assert "agent failed for impossible" in failed.error
    assert failed.result is None
    assert [event[2] for event in notifier.events] == [NotificationKind.ACKNOWLEDGEMENT]


@pytest.mark.asyncio
async def test_empty_worker_result_fails_explicitly() -> None:
    class EmptyWorker:
        async def run(self, request, job_id):
            return "  "

    coordinator = ColdTaskCoordinator(
        EmptyWorker(), RecordingNotifier(), id_factory=ids("empty-job")
    )
    job = await coordinator.submit_no_match("request")

    failed = await coordinator.wait(job.id)

    assert failed.status is JobStatus.FAILED
    assert failed.error == "cold-task worker returned an empty result"


@pytest.mark.asyncio
async def test_acknowledgement_failure_raises_with_inspectable_job() -> None:
    notifier = RecordingNotifier(fail_kind=NotificationKind.ACKNOWLEDGEMENT)
    coordinator = ColdTaskCoordinator(
        ControlledWorker(), notifier, id_factory=ids("ack-failed")
    )

    with pytest.raises(NotificationError) as error:
        await coordinator.submit_no_match("request")

    assert error.value.job_id == "ack-failed"
    assert error.value.kind is NotificationKind.ACKNOWLEDGEMENT
    failed = coordinator.get("ack-failed")
    assert failed.status is JobStatus.FAILED
    assert failed.started_at is None
    assert "speaker unavailable" in failed.error


@pytest.mark.asyncio
async def test_callback_failure_preserves_result_and_marks_failure() -> None:
    notifier = RecordingNotifier(fail_kind=NotificationKind.RESULT)
    coordinator = ColdTaskCoordinator(
        DelayedEchoWorker(delay_seconds=0), notifier, id_factory=ids("callback-failed")
    )

    job = await coordinator.submit_no_match("request")
    failed = await coordinator.wait(job.id)

    assert failed.status is JobStatus.FAILED
    assert failed.result == "Completed cold task: request"
    assert failed.error == "result notification failed: speaker unavailable"


@pytest.mark.asyncio
async def test_cancel_is_immediate_and_idempotent_before_task_starts() -> None:
    coordinator = ColdTaskCoordinator(
        ControlledWorker(), RecordingNotifier(), id_factory=ids("cancel-now")
    )
    job = await coordinator.submit_no_match("request")

    cancelled = await coordinator.cancel(job.id)
    again = await coordinator.cancel(job.id)

    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.error == "cancelled"
    assert again == cancelled


@pytest.mark.asyncio
async def test_cancel_propagates_to_running_worker() -> None:
    worker = ControlledWorker()
    coordinator = ColdTaskCoordinator(
        worker, RecordingNotifier(), id_factory=ids("cancel-running")
    )
    job = await coordinator.submit_no_match("request")
    await asyncio.sleep(0)

    cancelled = await coordinator.cancel(job.id)

    assert cancelled.status is JobStatus.CANCELLED
    assert worker.cancelled.is_set()


@pytest.mark.asyncio
async def test_cancelling_waiter_does_not_cancel_owned_job() -> None:
    worker = ControlledWorker()
    coordinator = ColdTaskCoordinator(
        worker, RecordingNotifier(), id_factory=ids("still-running")
    )
    job = await coordinator.submit_no_match("request")
    observer = asyncio.create_task(coordinator.wait(job.id))
    await asyncio.sleep(0)
    observer.cancel()
    await asyncio.gather(observer, return_exceptions=True)

    assert coordinator.get(job.id).status is JobStatus.RUNNING
    worker.release.set()
    assert (await coordinator.wait(job.id)).status is JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_close_cancels_active_jobs_and_rejects_new_work() -> None:
    worker = ControlledWorker()
    coordinator = ColdTaskCoordinator(
        worker, RecordingNotifier(), id_factory=ids("during-shutdown")
    )
    job = await coordinator.submit_no_match("request")
    await asyncio.sleep(0)

    await coordinator.close()

    assert coordinator.closed is True
    assert coordinator.get(job.id).status is JobStatus.CANCELLED
    assert worker.cancelled.is_set()
    with pytest.raises(CoordinatorClosedError):
        await coordinator.submit_no_match("too late")
    await coordinator.close()  # idempotent


@pytest.mark.asyncio
async def test_close_can_drain_jobs_without_cancelling() -> None:
    coordinator = ColdTaskCoordinator(
        DelayedEchoWorker(delay_seconds=0.001),
        RecordingNotifier(),
        id_factory=ids("drained"),
    )
    job = await coordinator.submit_no_match("request")

    await coordinator.close(cancel_pending=False)

    assert coordinator.get(job.id).status is JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_shutdown_waits_for_acknowledgement_in_flight() -> None:
    gate = asyncio.Event()
    notifier = RecordingNotifier(acknowledgement_gate=gate)
    coordinator = ColdTaskCoordinator(
        ControlledWorker(), notifier, id_factory=ids("racing-submit")
    )
    submission = asyncio.create_task(coordinator.submit_no_match("request"))
    await asyncio.sleep(0)
    shutdown = asyncio.create_task(coordinator.close())
    await asyncio.sleep(0)
    assert not shutdown.done()

    gate.set()
    submitted = await submission
    await shutdown

    assert coordinator.get(submitted.id).status is JobStatus.CANCELLED


def test_unknown_job_and_duplicate_or_empty_ids_are_explicit() -> None:
    coordinator = ColdTaskCoordinator(ControlledWorker(), RecordingNotifier())
    with pytest.raises(JobNotFoundError, match="missing"):
        coordinator.get("missing")

    empty = ColdTaskCoordinator(
        ControlledWorker(), RecordingNotifier(), id_factory=lambda: ""
    )
    with pytest.raises(ValueError, match="empty job ID"):
        asyncio.run(empty.submit_no_match("request"))


@pytest.mark.asyncio
async def test_synthesized_notifier_uses_existing_voice_abstractions() -> None:
    clip = AudioClip(b"\x00\x00", 16_000)
    events = []

    class Synthesizer:
        def synthesize(self, text):
            events.append(("synthesize", text))
            return clip

    class Output:
        def play(self, audio):
            events.append(("play", audio))

    notifier = SynthesizedVoiceNotifier(Synthesizer(), Output())

    await notifier.notify("job", "spoken message", NotificationKind.RESULT)

    assert events == [("synthesize", "spoken message"), ("play", clip)]


@pytest.mark.asyncio
async def test_delayed_worker_supports_near_zero_test_delay() -> None:
    worker = DelayedEchoWorker(delay_seconds=0.001, prefix="done: ")

    assert await worker.run("request", "job") == "done: request"


def test_configuration_validation() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        DelayedEchoWorker(delay_seconds=-1)
    with pytest.raises(ValueError, match="acknowledgement"):
        ColdTaskCoordinator(ControlledWorker(), RecordingNotifier(), acknowledgement=" ")
    with pytest.raises(ValueError, match="include"):
        ColdTaskCoordinator(
            ControlledWorker(), RecordingNotifier(), completion_template="missing token"
        )
