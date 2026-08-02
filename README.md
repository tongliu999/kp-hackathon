# Runbook Voice Assistant

A voice assistant that solves an unfamiliar task once, distills the successful
trajectory into a JSON runbook, and replays that runbook on later requests.

The implementation is organized as a small Python package under
`src/runbook_voice`. External services are accessed through narrow adapters so
the safety-critical orchestration can be tested without credentials or real
bookings.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

Service credentials belong in environment variables and must never be
committed. Irreversible side effects are always executed on a single confirmed
path; branching search must not call them.

## Cartesia voice echo (TON-6)

The echo command records one utterance, transcribes it with OpenAI, asks
Cartesia to synthesize the transcript, and plays the resulting WAV. Capture,
transcription, synthesis, and playback use narrow Python protocols, so the
orchestration and latency accounting can be tested without network access or
audio hardware.

Set the required service configuration:

```bash
export OPENAI_API_KEY=...
export CARTESIA_API_KEY=...
export CARTESIA_VOICE_ID=...
```

`OPENAI_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`) and
`CARTESIA_TTS_MODEL` (default `sonic-3.5`) are optional. For microphone and
speaker support, install the audio extra and run:

```bash
pip install -e '.[voice]'
runbook-voice-echo --duration 4
```

For a hardware-free smoke test, provide a 16-bit PCM WAV and write the response
instead of playing it:

```bash
runbook-voice-echo --input-wav request.wav --output-wav response.wav
```

The command prints the transcript followed by JSON latency metrics. `perceived_ms`
is measured from the end of capture to the handoff to the output device;
`end_to_end_ms` includes blocking playback. `met_target` compares perceived
latency to the configurable 1,000 ms target. This instrumentation reports an
observed run—it does not establish sub-second live performance until exercised
with valid credentials, the target network, and real audio hardware.

## Asynchronous cold tasks (TON-14)

`ColdTaskCoordinator` handles requests that do not match a learned runbook. It
speaks “I'll get back to you.” first, assigns an explicit job ID, and starts the
long worker in a tracked `asyncio` task. The submit call then returns, so the
conversation can accept unrelated utterances while any number of cold jobs
remain pending. When a worker finishes, the coordinator proactively sends the
result through a `VoiceNotifier`.

`SynthesizedVoiceNotifier` connects that callback to the existing
`Synthesizer` and `AudioOutput` protocols. Both calls are moved off the event
loop, and voice output is serialized to prevent overlapping speech. A notifier
could instead place a callback using the same narrow interface.

Jobs expose `pending`, `running`, `succeeded`, `failed`, and `cancelled` states,
timestamps, result, and error. Cancellation is idempotent; unknown IDs raise
`JobNotFoundError`; a failed acknowledgement raises `NotificationError` and
leaves an inspectable failed job. `wait()` is shielded so cancelling an observer
does not cancel owned work. `close()` rejects new submissions and either
cancels active work (default) or drains it with `cancel_pending=False`.

The side-effect-free demo uses a configurable fake delay—180 seconds by default
to model the cold path, but a short value is useful locally:

```bash
runbook-cold-task-demo --delay 0.2 \
  "research an unfamiliar task" \
  "another utterance while that is pending"
```

This coordinator intentionally performs no bookings or other irreversible side
effects. A real agent runner can implement `ColdTaskWorker` later while keeping
the same lifecycle and callback contract.
