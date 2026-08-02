import pytest

from runbook_voice.audio import AudioClip


def test_wav_round_trip_preserves_pcm_metadata() -> None:
    original = AudioClip(b"\x00\x01\x02\x03", sample_rate=16_000)

    decoded = AudioClip.from_wav(original.to_wav())

    assert decoded == original
    assert decoded.duration_seconds == pytest.approx(2 / 16_000)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"sample_rate": 0}, "sample_rate"),
        ({"sample_rate": 16_000, "channels": 0}, "channels"),
        ({"sample_rate": 16_000, "sample_width": 1}, "16-bit"),
    ],
)
def test_audio_clip_rejects_unsupported_metadata(kwargs, message) -> None:
    with pytest.raises(ValueError, match=message):
        AudioClip(b"", **kwargs)


def test_audio_clip_rejects_partial_frame() -> None:
    with pytest.raises(ValueError, match="complete audio frames"):
        AudioClip(b"\x00", sample_rate=16_000)


def test_from_wav_rejects_non_wav() -> None:
    with pytest.raises(ValueError, match="invalid WAV"):
        AudioClip.from_wav(b"not a wav")
