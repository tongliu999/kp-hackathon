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
