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
effects. The real worker is `BranchingSearch` below, which implements
`ColdTaskWorker` and keeps the same lifecycle and callback contract.

## Branching search (TON-13)

`BranchingSearch` is the cold path: one unknown request is attempted three ways
at once, and the three trajectories become the input to the judge (TON-19) and
the distiller (TON-21). It emits
[`schema/trajectory.schema.json`](schema/trajectory.schema.json) exactly.

```bash
runbook-branch-search-demo "Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven."
```

One base Sailbox is booted and seeded, then **checkpointed** and fanned out into
three children — measured at 3.8s median against 11.0s for `fork()` three times,
and the checkpoint outlives the parent. Each child runs `branch_agent.py`, a
stdlib-only program shipped into the box verbatim, which drives its own agent
loop against Sail's inference API and records every step it takes.

Two details are load-bearing rather than stylistic:

- The base box is seeded **to completion before** it is checkpointed, and the
  branch agent is launched **detached** (`setsid nohup`). Anything tied to an
  in-flight `exec()` session is reaped in a branched box.
- Steps are appended to `steps.jsonl` as work happens, and `DONE` is written
  *after* `trajectory.json`. A branch that dies is salvaged from its step log,
  and a poller never reads a half-written file.

Each branch is given a genuinely different approach (`DEFAULT_ANGLES`), and
duplicate directives are refused up front — identical prompts produce identical
trajectories and the judge has nothing to compare. Trajectories capture what was
tried, **including dead ends**, because final answers alone leave the distiller
with nothing to turn into steps.

**Branches never book.** They research and do in-box work; the irreversible step
happens once, later, behind the confirmation gate. That holds structurally
(nothing here can reach `RunbookExecutor`), by capability (a branch has no
confirmation gate), and by a guard that refuses write-shaped requests before they
run — recording the blocked attempt as an abandoned step rather than hiding it.

Output lands in `runs/<job_id>/` (gitignored). It is deliberately not
`fixtures/trajectories/`, which holds the locked hand-written examples that
`schema/validate.py` checks.

## Pairwise judge (TON-19)

`PairwiseJudge` takes the trajectories a fan-out produced and names a winner in one
model call, with one line saying what decided it.

```python
from runbook_voice import PairwiseJudge, SailJudgeModel

verdict = PairwiseJudge(SailJudgeModel()).pick([t0, t1, t2])
verdict.winner   # "b0"
verdict.reason   # "b0 found an exact 7:00 PM slot ... while b1 settled for 8:30 PM"
```

Input is whatever [`schema/trajectory.schema.json`](schema/trajectory.schema.json)
describes, as plain mappings — there is no second Python definition of that schema to
drift away from it.

Scope is fixed: **one comparison call**, no tournament, no second opinion, no absolute
scoring, no benchmark. Branch-and-prune is only as good as the score it prunes on, and a
noisy judge is worse than no pruning — you discard the best branch confidently and then
present a loser. Containing that means keeping the judge small, not making it clever.

Two things carry the weight:

- **Whole trajectories go in, not final answers.** `steps[].outcome` separates `ok` /
  `error` / `abandoned`, and the abandoned ones are most of what distinguishes two
  branches that both claim success.
- **`success_signal` is explicitly distrusted.** It is the branch's own claim about
  itself. Fixture `b1` reports success while booking 8:30 PM instead of 7:00 — the exact
  case a naive scorer gets wrong.

The winner is constrained to an enum of the supplied `branch_id`s, so inventing a branch
is a schema violation rather than a wrong answer. A verdict that restates the winner
instead of justifying it is rejected: observed once in five live runs, and it removes the
one signal you have for spotting a judge that is coin-flipping.

### Checking it is not picking at random

```bash
runbook-judge-check --runs 5 --expect b0
```

The recorded fixtures rank b0 > b1 > b2 deliberately. Both the winners and the reasons
are printed, and the command exits non-zero unless the runs agree.

Measured 2026-08-01 on `moonshotai/Kimi-K2.6`, effort `high`: **5/5 b0 at temperature 0,
and 5/5 b0 again at temperature 1.0.**

If it ever comes out inconsistent, the documented fallback is
`longest_successful_branch` — worse, but honest, and it keeps the demo alive. Know what
it costs: on these fixtures it picks **b1**, because b1 self-reports success and has one
more step than b0. That is the naive scoring the judge exists to beat, which is why it is
a separate function you reach for deliberately rather than an automatic degradation.

### Backend

The judge uses the Anthropic SDK pointed at Sail's Anthropic-compatible Messages
endpoint. **Sail serves open-weight models, so this is not Claude** — the default is
`moonshotai/Kimi-K2.6`. Credentials come from `SAIL_API_KEY`, falling back to
`~/.sail/auth.toml` written by `sail auth login`. Install with
`pip install -e '.[judge]'`.

## Demo operations

The contract-tested request, three-minute stage cues, presenter roles, safety
language, failure pivots, and rehearsal checklist live in
[`docs/demo-run-of-show.md`](docs/demo-run-of-show.md). The machine-readable
request fixture is [`demo/demo_config.json`](demo/demo_config.json); edit both
only together and run the test suite to catch phrasing or normalization drift.

## Distilling a runbook from a winning trajectory (TON-21)

`distill(trajectory)` turns the winning branch's trajectory into a schema-valid
runbook. It is deterministic and offline — no model call, no credentials:

```bash
runbook-distill fixtures/trajectories/branch-0.json -o fixtures/runbooks/distilled-branch-0.json
python schema/validate.py
```

The work is generalization, not transcription. The trajectory records browser
mechanics carrying one request's values; the runbook holds **abstract verbs**
(`restaurant.book`, never a click on a selector, so a provider redesign cannot
break it) over **declared slots** (so the next caller can ask for four people on
Sunday). Steps that were abandoned, errored, or were pure reasoning are dropped,
and a field written twice keeps only the last write.

Domain knowledge lives in a `TaskVocabulary` — a data table of verbs and slot
patterns. Adding a domain means adding a vocabulary, not a branch in the
pipeline.

The distiller refuses rather than emitting a runbook that cannot generalize:

```text
$ runbook-distill fixtures/trajectories/branch-1.json
refused branch-1.json: step 5 writes 'Ristorante Adriatico', which the request
does not mention. It cannot become a slot, and baking it in would build a
runbook that only ever repeats this one run.
```

Two consequences of the surrounding contracts are load-bearing. Every `{{ref}}`
must resolve to a declared slot that is `required` or has a `default`: an
optional slot with no default resolves to nothing rather than failing at the
door, so the reference raises `SlotResolutionError` mid-replay, after earlier
steps have already run. And `description` is written for the store's matcher,
which scores token coverage against `min(len(query), len(candidate))` — extra
words there dilute the score rather than sharpening it.

The terminal booking step is synthesized rather than observed. Branching search
is forbidden from running irreversible actions, so the winning trajectory stops
at "Ready to confirm" and no trajectory can ever contain the step the runbook
most needs to gate.

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
