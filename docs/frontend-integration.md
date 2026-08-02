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

**Matching tolerates typing, not synonyms.** `book me a japanese resturant on
sunday for 4 pm` matches (misspellings and abbreviations are handled as of
`d4222f6`). `I want a sushi place` still does not — "sushi" is not a word the
matcher knows means restaurant. Unrelated requests correctly return `None`:
flights, hotels, haircuts, "deploy the website".

---

# Running live from your machine

Everything above works on `stub=True` with nothing but Node installed. This
section is for making it book a **real Resy table**, driven from your laptop.

## Why your machine specifically

The chain is: your process → `booking_bridge.mjs` → the `booking` Sailbox →
Chromium in that box → Resy. Resy **refuses its auth endpoints from Sail's
egress**, so the box's Chromium is pointed at a SOCKS5 proxy on `127.0.0.1:1080`
that is a reverse tunnel back out through *whoever is running the tunnel*.

So the tunnel has to originate from the same machine as your backend. If it runs
on Tong's laptop and your backend runs on yours, the box has **no working egress
at all** — every page load fails, not just auth.

## One-time setup

```bash
# 1. Sail access to the same org (the box lives there)
curl -fsSL https://cli.sailresearch.com/install.sh | sh
export PATH="$HOME/.sail/bin:$PATH"
sail auth login                       # interactive; must be the org owning `booking`
sail box list | grep booking          # should show sb_9da90990-… , not terminated

# 2. SSH shortcut to the box
sail box ssh enable sb_9da90990-368a-4352-8ec3-9c6d50d4705e
ssh booking-d4705e.sail 'echo ok'     # accept the host key once

# 3. Local deps
uv venv --python 3.12 && uv pip install -e '.[dev]'
npm install
```

You do **not** need to log into Resy. The session lives on the box's disk at
`/root/booking/profile` and persists across everything.

## Every session

```bash
# terminal 1 — leave running; it reconnects on drop
BOOKING_BOX_SSH=booking-d4705e.sail ./scripts/egress-tunnel.sh

# terminal 2
export BOOKING_SAILBOX=booking        # real mode is opt-in by naming the box
```

Then construct with `stub=False`. **It books a real table.** Cancel immediately:

```python
await NodeBookingRunner(store_path=...).execute("booking.reset", {})
```

`reset` re-reads the account afterwards and throws if the reservation is still
listed, so a silent failure to cancel is not possible.

## Verifying before you trust it

```bash
# proxy carrying traffic? expect 200
BOX=sb_9da90990-368a-4352-8ec3-9c6d50d4705e
sail box exec $BOX sh -c "curl -s --max-time 15 --socks5-hostname 127.0.0.1:1080 \
  -o /dev/null -w '%{http_code}' https://resy.com"
```

`sail box exec` passes arguments verbatim with **no shell parsing**, so anything
with a pipe or a redirect has to go through `sh -c "…"` as above.

A real `restaurant.search` returning ~50 candidates is the other good signal.

## Failure modes, in the order you will hit them

**`ERR_PROXY_CONNECTION_FAILED`, or every page blank.** The tunnel is down. This
happened twice while setting it up. Once it was a stale `sshd` still holding port
1080 in the box, so the reconnect could not rebind — the client had died without
the server side noticing:

```bash
sail box exec $BOX sh -c "ss -lntp | grep 1080"   # find the pid holding it
sail box exec $BOX sh -c "kill -9 <pid>"
```
then restart the tunnel.

**`refused: "restaurant.book" is irreversible…`** — `confirmation_is_upstream`
was not set, or you called the runner without going through `RunbookExecutor`.
Working as intended.

**`no authenticated browser session available: BOOKING_SAILBOX is unset`** —
real mode refusing rather than silently stubbing. Export the var.

**`Resy booking widget is not logged in`** — the box's profile lost its session.
Someone has to log in again through VNC on the box; nothing on your side fixes it.

## Two rules about the box

**Never terminate `booking`.** The Resy login is on its disk and cannot be
scripted back. `pause()` it between sessions — Sail bills nothing while paused.

**Keep it on `stub=True` for UI work.** The return shape is identical, so nothing
in your code changes when you flip it, and you are not putting real tables on
hold while iterating on a layout.
