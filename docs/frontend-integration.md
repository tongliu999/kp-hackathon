# Driving the assistant from a frontend

For Sai. This is the **prepared path**: the store is pre-seeded with a known
runbook, so every request is warm and nothing depends on the branching search.
It is the reliable demo path — no Sailbox fan-out, no judge, no minutes of
waiting.

You implement **three small interfaces** against your transport (WebSocket, SSE,
whatever). Everything else is already built and tested; nothing in this document
asks you to change library code.

## The shape

```
utterance ──► store.lookup ──► matched? ──► dialogue asks for missing slots
                                  │                     │
                                  │ no                   ▼
                                  ▼            executor runs the steps
                          (cold path — not              │
                           used on this path)           ▼
                                            confirm gate: irreversible step
                                                        │
                                                        ▼
                                              booking + confirmation id
```

## What you implement

All three are duck-typed protocols — no base class to inherit.

```python
class WsDialogueInput:           # runbook_voice.dialogue.AsyncDialogueInput
    async def listen(self) -> str:
        """Return the user's next answer. Await your socket here."""

class WsDialogueOutput:          # runbook_voice.dialogue.AsyncDialogueOutput
    async def say(self, text: str) -> None:
        """Send text to the UI (and/or to TTS)."""

class WsConfirmationGate:        # runbook_voice.executor.ConfirmationGate
    async def confirm(self, request) -> bool:
        """request.prompt is a spoken-ready readback naming the specifics.
        Return True only on an explicit yes."""
```

`request` is a `ConfirmationRequest` with `runbook_id`, `runbook_name`, `step`,
`resolved_arguments`, `prompt`. **`prompt` already names what/when/how many** —
show it verbatim; don't rebuild it from `resolved_arguments`.

## Wiring

```python
import json
from pathlib import Path

from runbook_voice.booking_bridge import NodeBookingRunner
from runbook_voice.dialogue import AsyncSlotFillingDialogue
from runbook_voice.executor import RunbookExecutor
from runbook_voice.runbook_store import JSONRunbookStore

ROOT = Path("/path/to/kp-hackathon")

# 1. Pre-seed. THIS is what makes it the prepared path — do it at startup.
store = JSONRunbookStore(ROOT / "demo" / "fe-store.json")
store.save(json.loads((ROOT / "demo" / "handwritten_runbook.json").read_text()))

# 2. Build once per session.
runner = NodeBookingRunner(
    stub=True,                       # False books for real; see below
    confirmation_is_upstream=True,   # required, and see the warning
    store_path=ROOT / "demo" / "fe-bookings.json",
)
dialogue = AsyncSlotFillingDialogue(store, WsDialogueInput(), WsDialogueOutput())
executor = RunbookExecutor(runner, WsConfirmationGate())

# 3. Per user request.
async def handle(utterance: str) -> dict:
    if store.lookup(utterance) is None:
        return {"status": "no_match"}          # cold path lives here; unused on the prepared path

    outcome = await dialogue.run(utterance)    # calls say()/listen() to fill slots
    if not outcome.ready or outcome.invocation is None:
        return {"status": "dialogue_failed", "slot": outcome.failed_slot}

    result = await executor.execute(
        outcome.invocation.runbook, outcome.invocation.slot_values
    )                                          # calls confirm() before booking
    if not result.succeeded:
        last = result.steps[-1]
        return {"status": last.status.value, "error": last.error}

    return {"status": "succeeded", **(result.steps[-1].output or {})}
```

`result.steps[-1].output` is `{"confirmation_id": ..., "provider": ..., "stub": bool}`.

## Status values worth rendering differently

| | meaning |
|---|---|
| `succeeded` | booked; show the confirmation id |
| `confirmation_rejected` | the user declined — **nothing was booked** |
| `failed` | a step errored; `last.error` says which |
| `dialogue_failed` | a slot could not be parsed after retries |
| `no_match` | no runbook — on the full product this triggers the cold search |

## Config

```bash
BOOKING_STORE_PATH   # set automatically from store_path
BOOKING_SAILBOX      # ONLY for real bookings. Unset ⇒ real mode refuses.
```

Nothing else is needed for stub mode. Node must be on `PATH` — the executor
shells out to `scripts/booking_bridge.mjs` once per step.

## Three things that will bite

**The confirm gate is not optional.** `RunbookExecutor` fails closed: no gate, or
a gate that raises, means the booking does not happen. That is deliberate
(Invariant 1) — don't route around it by auto-confirming.

**`confirmation_is_upstream=True` is a promise you are making.** It tells the
bridge that a human already approved. It is only true because `RunbookExecutor`
gates the step before dispatching. If you ever call `NodeBookingRunner` directly,
leave it `False` or you have removed the only thing standing between a bug and a
real reservation.

**Matching is literal.** `book a table` matches; `I want a sushi place` does not.
It is token overlap, not an LLM, so misspellings (`resturant`) miss. Keep demo
phrasings to "book"/"reserve" + "table"/"restaurant". *(A fix for this is in
flight — the store's matcher is being reworked, so re-check this line before
relying on it.)*

## Going live

```bash
export BOOKING_SAILBOX=booking
```
and construct with `stub=False`. Requires the `booking` Sailbox up with a
logged-in Resy profile and the egress tunnel running. **It books a real table.**
Cancel with `NodeBookingRunner(...).execute("booking.reset", {})`.

Stay on `stub=True` for frontend work — the return shape is identical, so
nothing in your code changes when you flip it.
