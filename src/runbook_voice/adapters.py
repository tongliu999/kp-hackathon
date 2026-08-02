"""Production adapters for HTTP services, files, and local audio devices."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import secrets
from typing import Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .audio import AudioClip


class AdapterError(RuntimeError):
    """An external adapter could not complete its operation."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes


class HttpClient(Protocol):
    def request(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes
    ) -> HttpResponse: ...


class UrllibHttpClient:
    def request(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes
    ) -> HttpResponse:
        request = Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urlopen(request, timeout=30) as response:  # noqa: S310
                return HttpResponse(status=response.status, body=response.read())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise AdapterError(f"HTTP {exc.code} from {url}: {detail}") from exc
        except URLError as exc:
            raise AdapterError(f"could not reach {url}: {exc.reason}") from exc


class OpenAITranscriber:
    """Transcribe WAV input with OpenAI's audio transcription endpoint."""

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "gpt-4o-mini-transcribe",
        base_url: str = "https://api.openai.com/v1",
        http: HttpClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("OpenAI API key is required")
        self._api_key = api_key
        self._model = model
        self._url = f"{base_url.rstrip('/')}/audio/transcriptions"
        self._http = http or UrllibHttpClient()

    def transcribe(self, audio: AudioClip) -> str:
        boundary = f"runbook-voice-{secrets.token_hex(12)}"
        body = _multipart(
            boundary,
            fields={"model": self._model},
            file_field=("file", "capture.wav", "audio/wav", audio.to_wav()),
        )
        response = self._http.request(
            "POST",
            self._url,
            {
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            body,
        )
        _require_success(response, "OpenAI transcription")
        try:
            text = json.loads(response.body)["text"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise AdapterError("OpenAI transcription returned invalid JSON") from exc
        if not isinstance(text, str):
            raise AdapterError("OpenAI transcription response had no text")
        return text


class CartesiaSynthesizer:
    """Synthesize a complete WAV response with Cartesia's bytes endpoint."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        *,
        model: str = "sonic-3.5",
        api_version: str = "2026-03-01",
        base_url: str = "https://api.cartesia.ai",
        sample_rate: int = 44_100,
        http: HttpClient | None = None,
    ) -> None:
        missing = [name for name, value in (("API key", api_key), ("voice ID", voice_id)) if not value]
        if missing:
            raise ValueError(f"Cartesia {' and '.join(missing)} required")
        self._api_key = api_key
        self._voice_id = voice_id
        self._model = model
        self._api_version = api_version
        self._url = f"{base_url.rstrip('/')}/tts/bytes"
        self._sample_rate = sample_rate
        self._http = http or UrllibHttpClient()

    def synthesize(self, text: str) -> AudioClip:
        if not text.strip():
            raise ValueError("text to synthesize must not be empty")
        body = json.dumps(
            {
                "model_id": self._model,
                "transcript": text,
                "voice": {"mode": "id", "id": self._voice_id},
                "output_format": {
                    "container": "wav",
                    "encoding": "pcm_s16le",
                    "sample_rate": self._sample_rate,
                },
            }
        ).encode()
        response = self._http.request(
            "POST",
            self._url,
            {
                "Authorization": f"Bearer {self._api_key}",
                "Cartesia-Version": self._api_version,
                "Content-Type": "application/json",
            },
            body,
        )
        _require_success(response, "Cartesia synthesis")
        try:
            return AudioClip.from_wav(response.body)
        except ValueError as exc:
            raise AdapterError(f"Cartesia synthesis returned invalid WAV: {exc}") from exc


@dataclass(frozen=True, slots=True)
class WavFileInput:
    path: Path

    def capture(self) -> AudioClip:
        try:
            return AudioClip.from_wav(self.path.read_bytes())
        except OSError as exc:
            raise AdapterError(f"could not read input WAV {self.path}: {exc}") from exc


@dataclass(frozen=True, slots=True)
class WavFileOutput:
    path: Path

    def play(self, audio: AudioClip) -> None:
        try:
            self.path.write_bytes(audio.to_wav())
        except OSError as exc:
            raise AdapterError(f"could not write output WAV {self.path}: {exc}") from exc


@dataclass(frozen=True, slots=True)
class SoundDeviceInput:
    duration_seconds: float = 4.0
    sample_rate: int = 16_000
    channels: int = 1

    def capture(self) -> AudioClip:
        if self.duration_seconds <= 0:
            raise ValueError("capture duration must be positive")
        sounddevice = _sounddevice()
        frames = round(self.duration_seconds * self.sample_rate)
        try:
            with sounddevice.RawInputStream(
                samplerate=self.sample_rate, channels=self.channels, dtype="int16"
            ) as stream:
                pcm, overflowed = stream.read(frames)
        except Exception as exc:
            raise AdapterError(f"microphone capture failed: {exc}") from exc
        if overflowed:
            raise AdapterError("microphone input overflowed; capture is incomplete")
        return AudioClip(bytes(pcm), self.sample_rate, self.channels)


class SoundDeviceOutput:
    def play(self, audio: AudioClip) -> None:
        sounddevice = _sounddevice()
        try:
            with sounddevice.RawOutputStream(
                samplerate=audio.sample_rate,
                channels=audio.channels,
                dtype="int16",
            ) as stream:
                stream.write(audio.pcm)
        except Exception as exc:
            raise AdapterError(f"speaker playback failed: {exc}") from exc


def _sounddevice():
    try:
        import sounddevice
    except ImportError as exc:
        raise AdapterError(
            "microphone/speaker support is not installed; run "
            "`pip install -e '.[voice]'` or use WAV input/output"
        ) from exc
    return sounddevice


def _require_success(response: HttpResponse, operation: str) -> None:
    if not 200 <= response.status < 300:
        detail = response.body.decode("utf-8", errors="replace")[:500]
        raise AdapterError(f"{operation} failed with HTTP {response.status}: {detail}")


def _multipart(
    boundary: str,
    *,
    fields: Mapping[str, str],
    file_field: tuple[str, str, str, bytes],
) -> bytes:
    delimiter = f"--{boundary}\r\n".encode()
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                delimiter,
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode(),
                b"\r\n",
            ]
        )
    name, filename, content_type, content = file_field
    chunks.extend(
        [
            delimiter,
            (
                f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\n'
            ).encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            content,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return b"".join(chunks)
