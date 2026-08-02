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

## M0 runbook contract

The executor consumes a versioned, JSON-compatible runbook. Action names and
arguments are data, so the executor does not contain demo-specific ordering:

```json
{
  "id": "book-dinner",
  "name": "Book dinner",
  "version": "1",
  "slots": [
    {"name": "city", "type": "string", "required": true},
    {"name": "party_size", "type": "integer", "required": true}
  ],
  "steps": [
    {
      "id": "find",
      "action": "restaurant.search",
      "arguments": {"city": "{{city}}", "party": "{{party_size}}"},
      "irreversible": false
    },
    {
      "id": "reserve",
      "action": "restaurant.reserve",
      "arguments": {"party": "{{party_size}}"},
      "irreversible": true,
      "confirmation_prompt": "Book this table?"
    }
  ]
}
```

Supported slot types are `string`, `integer`, `number`, `boolean`, `object`,
and `array`. A full expression such as `"{{party_size}}"` preserves its value's
type; expressions embedded in text are stringified. Substitution recurses into
objects and arrays. Missing, unknown, or mistyped slots fail before dispatch.

`RunbookExecutor` is constructed with a `PersistentSailboxRunner`. The runner
represents an already-created box and exposes only
`execute(action, arguments)`; box creation and teardown belong to the calling
session. Steps execute sequentially and once. The first failure stops replay,
and the result includes every attempted step and its resolved arguments.

An irreversible step is handed to the configured `ConfirmationGate` immediately
before dispatch. Only a literal `True` permits execution. Rejection, a missing
gate, or a gate error stops the runbook without calling the irreversible action.
The executor deliberately provides no retry behavior.

## Demo operations

The contract-tested request, three-minute stage cues, presenter roles, safety
language, failure pivots, and rehearsal checklist live in
[`docs/demo-run-of-show.md`](docs/demo-run-of-show.md). The machine-readable
request fixture is [`demo/demo_config.json`](demo/demo_config.json); edit both
only together and run the test suite to catch phrasing or normalization drift.
