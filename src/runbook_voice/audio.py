"""Small, dependency-free audio value objects."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import wave


@dataclass(frozen=True, slots=True)
class AudioClip:
    """16-bit PCM audio plus the metadata required to play or serialize it."""

    pcm: bytes
    sample_rate: int
    channels: int = 1
    sample_width: int = 2

    def __post_init__(self) -> None:
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if self.channels <= 0:
            raise ValueError("channels must be positive")
        if self.sample_width != 2:
            raise ValueError("only 16-bit PCM (sample_width=2) is supported")
        frame_width = self.channels * self.sample_width
        if len(self.pcm) % frame_width:
            raise ValueError("PCM length must contain complete audio frames")

    @property
    def duration_seconds(self) -> float:
        frames = len(self.pcm) / (self.channels * self.sample_width)
        return frames / self.sample_rate

    def to_wav(self) -> bytes:
        target = BytesIO()
        with wave.open(target, "wb") as wav:
            wav.setnchannels(self.channels)
            wav.setsampwidth(self.sample_width)
            wav.setframerate(self.sample_rate)
            wav.writeframes(self.pcm)
        return target.getvalue()

    @classmethod
    def from_wav(cls, data: bytes) -> "AudioClip":
        try:
            with wave.open(BytesIO(data), "rb") as wav:
                if wav.getcomptype() != "NONE":
                    raise ValueError("compressed WAV audio is not supported")
                return cls(
                    pcm=wav.readframes(wav.getnframes()),
                    sample_rate=wav.getframerate(),
                    channels=wav.getnchannels(),
                    sample_width=wav.getsampwidth(),
                )
        except (EOFError, wave.Error) as exc:
            raise ValueError(f"invalid WAV audio: {exc}") from exc
