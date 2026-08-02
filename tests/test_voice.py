from dataclasses import dataclass, field

import pytest

from runbook_voice.audio import AudioClip
from runbook_voice.voice import LatencyReport, VoiceEchoLoop


CLIP = AudioClip(b"\x00\x00", 16_000)


@dataclass
class ScriptedClock:
    values: list[float]

    def monotonic(self) -> float:
        return self.values.pop(0)


@dataclass
class FakeInput:
    events: list[str]

    def capture(self) -> AudioClip:
        self.events.append("capture")
        return CLIP


@dataclass
class FakeTranscriber:
    events: list[str]
    text: str = " hello world "

    def transcribe(self, audio: AudioClip) -> str:
        assert audio is CLIP
        self.events.append("transcribe")
        return self.text


@dataclass
class FakeSynthesizer:
    events: list[str]
    received: list[str] = field(default_factory=list)

    def synthesize(self, text: str) -> AudioClip:
        self.events.append("synthesize")
        self.received.append(text)
        return CLIP


@dataclass
class FakeOutput:
    events: list[str]
    played: list[AudioClip] = field(default_factory=list)

    def play(self, audio: AudioClip) -> None:
        self.events.append("play")
        self.played.append(audio)


def test_loop_runs_adapters_in_order_and_reports_latency() -> None:
    events: list[str] = []
    synth = FakeSynthesizer(events)
    output = FakeOutput(events)
    loop = VoiceEchoLoop(
        FakeInput(events),
        FakeTranscriber(events),
        synth,
        output,
        clock=ScriptedClock([10.0, 10.2, 10.65, 10.67, 11.47]),
    )

    turn = loop.run_once()

    assert events == ["capture", "transcribe", "synthesize", "play"]
    assert synth.received == ["hello world"]
    assert output.played == [CLIP]
    assert turn.transcript == "hello world"
    assert turn.latency.transcription_ms == pytest.approx(200)
    assert turn.latency.synthesis_ms == pytest.approx(450)
    assert turn.latency.perceived_ms == pytest.approx(670)
    assert turn.latency.playback_ms == pytest.approx(800)
    assert turn.latency.end_to_end_ms == pytest.approx(1_470)
    assert turn.latency.met_target is True


def test_empty_transcript_stops_before_synthesis() -> None:
    events: list[str] = []
    loop = VoiceEchoLoop(
        FakeInput(events),
        FakeTranscriber(events, text="  "),
        FakeSynthesizer(events),
        FakeOutput(events),
        clock=ScriptedClock([1.0, 1.1]),
    )

    with pytest.raises(ValueError, match="no speech"):
        loop.run_once()

    assert events == ["capture", "transcribe"]


def test_latency_report_rounds_serialized_metrics() -> None:
    report = LatencyReport(1.234, 2.345, 1_000.0, 4.567, 5.678)

    assert report.as_dict() == {
        "transcription_ms": 1.23,
        "synthesis_ms": 2.35,
        "perceived_ms": 1_000.0,
        "playback_ms": 4.57,
        "end_to_end_ms": 5.68,
        "target_ms": 1_000.0,
        "met_target": False,
    }


def test_loop_rejects_nonpositive_target() -> None:
    with pytest.raises(ValueError, match="target_ms"):
        VoiceEchoLoop(None, None, None, None, target_ms=0)  # type: ignore[arg-type]
