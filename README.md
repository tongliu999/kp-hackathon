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

## Runbook storage

`JSONRunbookStore` provides the warm-path persistence seam. It accepts either
the M0 `Runbook` object or its `to_dict()` result, stores the resulting JSON
unchanged in one file, uses a process-safe sidecar lock and
atomic replacement, and returns `None` when no stored intent matches:

```python
from runbook_voice import RunbookStore

store = RunbookStore("var/runbooks.json")
store.save(runbook)

matched = store.lookup("Could you arrange that dinner booking again?")
if matched is None:
    # Start branching/cold-path search.
    ...
```

The built-in matcher is deterministic and offline, which keeps development and
tests credential-free. A matcher with an LLM or embedding backend can be
injected by implementing `RunbookMatcher.match(utterance, runbooks)`; it must
return one of its candidate objects or `None`.

Malformed JSON, incompatible store versions, and invalid stored records raise
`RunbookStoreCorruptionError`. They are never silently treated as cache misses,
and `save` will not overwrite a corrupted file. The persistent file uses this
store-owned envelope while each object inside `runbooks` remains governed by
the M0 schema:

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
