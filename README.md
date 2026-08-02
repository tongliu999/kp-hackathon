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

The development extra installs the libraries needed for both testing and the
live voice loop:

- `pytest`
- `pytest-asyncio`
- `sounddevice` — microphone capture and speaker playback

If you installed the project before `sounddevice` was added, rerun
`pip install -e '.[dev]'` inside the activated virtual environment.

## Intent and slot-filling dialogue

`SlotFillingDialogue` connects the store to a deliberately narrow voice-text
boundary. The input only needs `listen() -> str`, and the output only needs
`say(text)`. This keeps the policy testable without microphones or service
credentials while real transcription and speech adapters remain separate:

```python
from runbook_voice import DialogueStatus, SlotFillingDialogue

dialogue = SlotFillingDialogue(store, transcribed_input, spoken_output)
outcome = dialogue.run(
    "Make a dinner reservation",
    prefilled_slots={"date": "tomorrow"},
)

if outcome.status is DialogueStatus.READY:
    invocation = outcome.invocation
    # await executor.execute(invocation.runbook, invocation.slot_values)
elif outcome.status is DialogueStatus.NO_MATCH:
    # TON-14 replaces this explicit seam with cold-path search.
    assert outcome.message == "I don't know how to do that yet"
```

Missing required slots are requested one at a time in schema declaration order.
Empty or type-invalid replies receive only `I didn't catch that`, with a bounded
number of attempts. Defaults and prefilled values are retained, and all resolved
values are spoken back before a ready invocation is returned. The async
`AsyncSlotFillingDialogue` follows the same policy for event-loop based voice
adapters.

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
`CARTESIA_TTS_MODEL` (default `sonic-3.5`) are optional. The standard
development install above includes microphone and speaker support. For a
minimal non-development installation, install the audio extra explicitly:

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

## Runbook storage

`JSONRunbookStore` provides the warm-path persistence seam. It accepts either
the M0 `Runbook` object or its `to_dict()` result, stores the resulting JSON
unchanged in one file, uses a process-safe sidecar lock and atomic replacement,
and returns `None` when no stored intent matches:

```python
from runbook_voice import RunbookStore

store = RunbookStore("var/runbooks.json")
store.save(runbook)

matched = store.lookup("Could you arrange that dinner booking again?")
if matched is None:
    # Start branching/cold-path search.
    ...
```

The built-in matcher is deterministic and offline. An LLM or embedding matcher
can be injected by implementing `RunbookMatcher.match(utterance, runbooks)`.
Malformed JSON, incompatible store versions, and invalid records raise
`RunbookStoreCorruptionError`; corrupted data is never silently treated as a
cache miss or overwritten by `save`.

```json
{
  "format_version": 1,
  "runbooks": [
    {
      "id": "restaurant-reservation",
      "name": "Reserve a restaurant table",
      "version": "1.0",
      "description": "Book a table for dinner at a restaurant",
      "slots": [],
      "steps": []
    }
  ]
}
```
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

## Repeatable booking rehearsal

Run three timed, consecutive booking rehearsals in explicitly labeled stub mode:

```bash
npm run rehearse
```

Every pass uses the exact request in `demo/demo_config.json`, exercises the
confirmation gate, creates one stub booking, runs the automated reset, and
fails unless the booking store is clean afterward. To include the M4 offline
video check, point the command at the local cold-path recording:

```bash
npm run rehearse -- --cold-video /absolute/path/to/cold-path.mp4
```

This command never contacts a booking provider. The three-person stage
rehearsal and a real book/cancel cycle remain manual acceptance checks.

This coordinator intentionally performs no bookings or other irreversible side
effects. A real agent runner can implement `ColdTaskWorker` later while keeping
the same lifecycle and callback contract.

## Demo operations

The contract-tested request, three-minute stage cues, presenter roles, safety
language, failure pivots, and rehearsal checklist live in
[`docs/demo-run-of-show.md`](docs/demo-run-of-show.md). The machine-readable
request fixture is [`demo/demo_config.json`](demo/demo_config.json); edit both
only together and run the test suite to catch phrasing or normalization drift.

## Warm replay

[`WarmReplayJoin`](docs/warm-replay.md) validates untrusted synthesized M0
payloads, persists the canonical runbook, and joins a later semantic match to
the safety-gated executor. Its typed outcomes keep no-match, schema, storage,
slot, confirmation, and execution failures distinct for the voice/UI layer.

## M1 warm-path proof (TON-18)

`M1WarmPath` joins the real store, slot dialogue, and executor with no cold
component in the path. Tests use a recording booking adapter and a fake-only
confirmation ID; they never perform a network request or booking. See
[`docs/m1-live-proof.md`](docs/m1-live-proof.md) for the fail-closed live handoff
and outstanding TON-11/TON-12 operational requirements.
