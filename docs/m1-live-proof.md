# M1 real-booking proof

The repository proves the warm orchestration offline, including the irreversible
confirmation boundary. A fake confirmation reference does **not** count as
TON-18 completion.

Before attempting the real proof:

1. Finish TON-11 and inject its booking runner for the authenticated persistent
   Sailbox; it must return the provider confirmation ID.
2. Finish TON-12 and inject real spoken confirmation. Only the complete
   utterance `yes` may approve; silence and ambiguity must abort.
3. Confirm free instant cancellation and that Talia owns the reset.
4. Verify the same authenticated box ID is reused.
5. Run with `no` and verify no booking exists.
6. Run with `yes`, capture the confirmation ID, and cancel immediately.
7. Record operator, time, box ID, provider, confirmation ID, cancellation ID,
   and measured voice latency on TON-18.

`python -m runbook_voice.m1_demo --live` exits with status 2 until production
adapters are present. It cannot make or fake a booking by default.
