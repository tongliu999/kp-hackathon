"""Command-line entry point for the Cartesia echo demo."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence

from .adapters import (
    AdapterError,
    CartesiaSynthesizer,
    OpenAITranscriber,
    SoundDeviceInput,
    SoundDeviceOutput,
    WavFileInput,
    WavFileOutput,
)
from .voice import VoiceEchoLoop


class ConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    openai_api_key: str
    cartesia_api_key: str
    cartesia_voice_id: str
    openai_model: str = "gpt-4o-mini-transcribe"
    cartesia_model: str = "sonic-3.5"

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "ServiceConfig":
        names = ("OPENAI_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID")
        missing = [name for name in names if not env.get(name, "").strip()]
        if missing:
            raise ConfigurationError(
                "missing required environment variable(s): " + ", ".join(missing)
            )
        return cls(
            openai_api_key=env["OPENAI_API_KEY"],
            cartesia_api_key=env["CARTESIA_API_KEY"],
            cartesia_voice_id=env["CARTESIA_VOICE_ID"],
            openai_model=env.get("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
            cartesia_model=env.get("CARTESIA_TTS_MODEL", "sonic-3.5"),
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture speech, transcribe it, and echo it with Cartesia."
    )
    parser.add_argument("--input-wav", type=Path, help="read WAV instead of the microphone")
    parser.add_argument("--output-wav", type=Path, help="write WAV instead of using speakers")
    parser.add_argument(
        "--duration", type=float, default=4.0, help="microphone capture seconds (default: 4)"
    )
    parser.add_argument(
        "--target-ms", type=float, default=1_000.0, help="perceived-latency target"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = ServiceConfig.from_env()
        audio_input = (
            WavFileInput(args.input_wav)
            if args.input_wav
            else SoundDeviceInput(duration_seconds=args.duration)
        )
        audio_output = WavFileOutput(args.output_wav) if args.output_wav else SoundDeviceOutput()
        echo = VoiceEchoLoop(
            audio_input,
            OpenAITranscriber(config.openai_api_key, model=config.openai_model),
            CartesiaSynthesizer(
                config.cartesia_api_key,
                config.cartesia_voice_id,
                model=config.cartesia_model,
            ),
            audio_output,
            target_ms=args.target_ms,
        )
        turn = echo.run_once()
    except (ConfigurationError, AdapterError, ValueError) as exc:
        print(f"voice echo failed: {exc}", file=sys.stderr)
        return 2

    print(f"transcript: {turn.transcript}")
    print(json.dumps(turn.latency.as_dict(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
