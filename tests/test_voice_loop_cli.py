import pytest

from runbook_voice.audio import AudioClip
import runbook_voice.voice_loop as cli
from runbook_voice.voice_loop import ConfigurationError, ServiceConfig, build_parser, main


def test_service_config_loads_required_and_optional_values() -> None:
    config = ServiceConfig.from_env(
        {
            "OPENAI_API_KEY": "openai",
            "CARTESIA_API_KEY": "cartesia",
            "CARTESIA_VOICE_ID": "voice",
            "OPENAI_TRANSCRIBE_MODEL": "custom-stt",
            "CARTESIA_TTS_MODEL": "custom-tts",
        }
    )

    assert config.openai_api_key == "openai"
    assert config.cartesia_api_key == "cartesia"
    assert config.cartesia_voice_id == "voice"
    assert config.openai_model == "custom-stt"
    assert config.cartesia_model == "custom-tts"


def test_service_config_lists_all_missing_values() -> None:
    with pytest.raises(ConfigurationError) as error:
        ServiceConfig.from_env({})

    assert "OPENAI_API_KEY" in str(error.value)
    assert "CARTESIA_API_KEY" in str(error.value)
    assert "CARTESIA_VOICE_ID" in str(error.value)


def test_parser_supports_hardware_free_wav_mode() -> None:
    args = build_parser().parse_args(
        ["--input-wav", "in.wav", "--output-wav", "out.wav", "--target-ms", "850"]
    )

    assert args.input_wav.name == "in.wav"
    assert args.output_wav.name == "out.wav"
    assert args.target_ms == 850


def test_main_fails_clearly_when_config_is_missing(monkeypatch, capsys) -> None:
    for name in ("OPENAI_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID"):
        monkeypatch.delenv(name, raising=False)

    assert main([]) == 2
    assert "missing required environment variable(s)" in capsys.readouterr().err


def test_main_wires_hardware_free_turn(monkeypatch, tmp_path, capsys) -> None:
    clip = AudioClip(b"\x00\x00", 16_000)
    input_path = tmp_path / "input.wav"
    output_path = tmp_path / "output.wav"
    input_path.write_bytes(clip.to_wav())
    monkeypatch.setenv("OPENAI_API_KEY", "openai")
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia")
    monkeypatch.setenv("CARTESIA_VOICE_ID", "voice")

    class Transcriber:
        def transcribe(self, audio):
            assert audio == clip
            return "echo this"

    class Synthesizer:
        def synthesize(self, text):
            assert text == "echo this"
            return clip

    monkeypatch.setattr(cli, "OpenAITranscriber", lambda *args, **kwargs: Transcriber())
    monkeypatch.setattr(cli, "CartesiaSynthesizer", lambda *args, **kwargs: Synthesizer())

    result = main(
        ["--input-wav", str(input_path), "--output-wav", str(output_path)]
    )

    assert result == 0
    assert output_path.read_bytes() == clip.to_wav()
    printed = capsys.readouterr().out
    assert "transcript: echo this" in printed
    assert '"perceived_ms"' in printed
