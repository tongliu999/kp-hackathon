# Warm replay join point

`WarmReplayJoin` connects the cold path's synthesized M0 payload to durable warm
replay without owning either synthesis or side-effect execution.

```python
from pathlib import Path

from runbook_voice import (
    JSONRunbookStore,
    RunbookExecutor,
    WarmReplayJoin,
    WarmReplayStatus,
)

# `runner` represents an already-live Sailbox. `confirmation_gate` hands every
# irreversible action to the voice/UI confirmation flow.
executor = RunbookExecutor(runner, confirmation_gate)
store_path = Path("data/runbooks.json")
warm = WarmReplayJoin(JSONRunbookStore(store_path), executor)

# TON-21's result is an untrusted Mapping[str, object]. No synthesizer object is
# imported here, and the join point does not repair or special-case its output.
admission = warm.accept_synthesized(ton21_payload)
if not admission.accepted:
    report(admission.status, admission.error)

# This can happen in a later process using a new JSONRunbookStore instance.
warm = WarmReplayJoin(JSONRunbookStore(store_path), executor)
outcome = await warm.replay(
    "Could you arrange that dinner reservation again?",
    {"city": "San Francisco", "party_size": 2, "day": "tomorrow", "time": "seven"},
)
if outcome.status is WarmReplayStatus.NO_MATCH:
    start_cold_path()
elif not outcome.succeeded:
    report(outcome.status, outcome.error)
```

## Adapter seam and safety boundary

TON-21 has not landed. Its only required integration contract is a mapping that
claims to contain the documented M0 schema. `accept_synthesized` passes that
mapping directly to `Runbook.from_dict`; only the resulting typed model is
persisted. Invalid schema and invalid slot defaults return `invalid_schema`
without writing anything. The join point deliberately contains no synthesizer,
schema-repair prompt, or demo-specific field conversion.

On replay, `JSONRunbookStore.lookup` performs intent matching and returns a
plain JSON object. The join point deserializes it through `Runbook.from_dict`
again before handing it to `RunbookExecutor`. This second boundary protects
against old, manually edited, or otherwise invalid persisted data.

Production wiring must use `RunbookExecutor` with the session's persistent
runner and confirmation gate. `WarmReplayJoin` has no `confirmed` argument and
never calls a runner directly. Missing, rejected, or broken confirmation is
therefore handled by the executor's fail-closed gate; the join point reports
`confirmation_rejected` and does not offer a bypass.

## Outcomes

Admission returns:

- `accepted`: validated and durably stored;
- `invalid_schema`: TON-21 output failed ordinary M0 validation;
- `store_failure`: validation passed, but persistence failed.

Replay returns:

- `succeeded`: the matched runbook completed;
- `no_match`: callers should enter the cold path;
- `store_failure`: lookup failed, distinct from a semantic miss;
- `invalid_stored_schema`: matched JSON did not deserialize as M0;
- `slot_failure`: supplied slots were missing, unknown, or mistyped;
- `confirmation_rejected`: the irreversible step was not authorized;
- `executor_failure`: dispatch/substitution failed or the executor raised.

Every non-success outcome includes the known runbook id, execution result, and
error where available. No outcome causes an implicit retry.
