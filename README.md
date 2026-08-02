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
