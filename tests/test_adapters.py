import json
from pathlib import Path

import pytest

from runbook_voice.adapters import (
    AdapterError,
    CartesiaSynthesizer,
    HttpResponse,
    OpenAITranscriber,
    WavFileInput,
    WavFileOutput,
)
from runbook_voice.audio import AudioClip


CLIP = AudioClip(b"\x01\x02\x03\x04", 16_000)


class FakeHttp:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.calls = []

    def request(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        return self.response


def test_openai_transcriber_builds_multipart_request() -> None:
    http = FakeHttp(HttpResponse(200, b'{"text":"testing one two"}'))
    adapter = OpenAITranscriber(
        "openai-secret", base_url="https://openai.test/v1/", http=http
    )

    assert adapter.transcribe(CLIP) == "testing one two"

    method, url, headers, body = http.calls[0]
    assert method == "POST"
    assert url == "https://openai.test/v1/audio/transcriptions"
    assert headers["Authorization"] == "Bearer openai-secret"
    assert headers["Content-Type"].startswith("multipart/form-data; boundary=")
    assert b'gpt-4o-mini-transcribe' in body
    assert b'filename="capture.wav"' in body
    assert CLIP.to_wav() in body


@pytest.mark.parametrize("body", [b"{}", b"not-json", b'{"text":3}'])
def test_openai_transcriber_rejects_malformed_response(body) -> None:
    adapter = OpenAITranscriber("key", http=FakeHttp(HttpResponse(200, body)))

    with pytest.raises(AdapterError, match="transcription"):
        adapter.transcribe(CLIP)


def test_cartesia_synthesizer_builds_request_and_decodes_wav() -> None:
    http = FakeHttp(HttpResponse(200, CLIP.to_wav()))
    adapter = CartesiaSynthesizer(
        "cartesia-secret",
        "voice-123",
        base_url="https://cartesia.test/",
        http=http,
    )

    result = adapter.synthesize("repeat me")

    assert result == CLIP
    method, url, headers, body = http.calls[0]
    assert method == "POST"
    assert url == "https://cartesia.test/tts/bytes"
    assert headers["Authorization"] == "Bearer cartesia-secret"
    assert headers["Cartesia-Version"] == "2026-03-01"
    payload = json.loads(body)
    assert payload["model_id"] == "sonic-3.5"
    assert payload["transcript"] == "repeat me"
    assert payload["voice"] == {"mode": "id", "id": "voice-123"}
    assert payload["output_format"]["container"] == "wav"


def test_cartesia_rejects_invalid_wav_response() -> None:
    adapter = CartesiaSynthesizer(
        "key", "voice", http=FakeHttp(HttpResponse(200, b"not-wav"))
    )

    with pytest.raises(AdapterError, match="invalid WAV"):
        adapter.synthesize("hello")


def test_http_failure_has_bounded_service_detail() -> None:
    adapter = CartesiaSynthesizer(
        "key", "voice", http=FakeHttp(HttpResponse(429, b"rate limited"))
    )

    with pytest.raises(AdapterError, match="HTTP 429: rate limited"):
        adapter.synthesize("hello")


def test_wav_file_adapters_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "echo.wav"

    WavFileOutput(path).play(CLIP)

    assert WavFileInput(path).capture() == CLIP


def test_wav_input_explains_missing_file(tmp_path: Path) -> None:
    with pytest.raises(AdapterError, match="could not read input WAV"):
        WavFileInput(tmp_path / "missing.wav").capture()
