"""Testable orchestration for one turn of a voice echo loop."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Protocol

from .audio import AudioClip


class AudioInput(Protocol):
    def capture(self) -> AudioClip: ...


class Transcriber(Protocol):
    def transcribe(self, audio: AudioClip) -> str: ...


class Synthesizer(Protocol):
    def synthesize(self, text: str) -> AudioClip: ...


class AudioOutput(Protocol):
    def play(self, audio: AudioClip) -> None: ...


class Clock(Protocol):
    def monotonic(self) -> float: ...


@dataclass(frozen=True, slots=True)
class LatencyReport:
    """Latency measured after the user-configured capture window ends."""

    transcription_ms: float
    synthesis_ms: float
    perceived_ms: float
    playback_ms: float
    end_to_end_ms: float
    target_ms: float = 1_000.0

    @property
    def met_target(self) -> bool:
        return self.perceived_ms < self.target_ms

    def as_dict(self) -> dict[str, float | bool]:
        return {
            "transcription_ms": round(self.transcription_ms, 2),
            "synthesis_ms": round(self.synthesis_ms, 2),
            "perceived_ms": round(self.perceived_ms, 2),
            "playback_ms": round(self.playback_ms, 2),
            "end_to_end_ms": round(self.end_to_end_ms, 2),
            "target_ms": self.target_ms,
            "met_target": self.met_target,
        }


@dataclass(frozen=True, slots=True)
class VoiceTurn:
    transcript: str
    latency: LatencyReport


class VoiceEchoLoop:
    """Capture, transcribe, synthesize, and play exactly one utterance."""

    def __init__(
        self,
        audio_input: AudioInput,
        transcriber: Transcriber,
        synthesizer: Synthesizer,
        audio_output: AudioOutput,
        *,
        clock: Clock = time,
        target_ms: float = 1_000.0,
    ) -> None:
        if target_ms <= 0:
            raise ValueError("target_ms must be positive")
        self._input = audio_input
        self._transcriber = transcriber
        self._synthesizer = synthesizer
        self._output = audio_output
        self._clock = clock
        self._target_ms = target_ms

    def run_once(self) -> VoiceTurn:
        captured = self._input.capture()
        speech_ended = self._clock.monotonic()

        transcript = self._transcriber.transcribe(captured).strip()
        transcription_done = self._clock.monotonic()
        if not transcript:
            raise ValueError("transcription returned no speech")

        reply = self._synthesizer.synthesize(transcript)
        synthesis_done = self._clock.monotonic()

        # This is the closest portable proxy for perceived latency: the instant
        # immediately before handing audio to the device/output adapter.
        playback_started = self._clock.monotonic()
        self._output.play(reply)
        playback_finished = self._clock.monotonic()

        milliseconds = 1_000.0
        report = LatencyReport(
            transcription_ms=(transcription_done - speech_ended) * milliseconds,
            synthesis_ms=(synthesis_done - transcription_done) * milliseconds,
            perceived_ms=(playback_started - speech_ended) * milliseconds,
            playback_ms=(playback_finished - playback_started) * milliseconds,
            end_to_end_ms=(playback_finished - speech_ended) * milliseconds,
            target_ms=self._target_ms,
        )
        return VoiceTurn(transcript=transcript, latency=report)
