# TON-23 — cold-path capture notes

First end-to-end cold run against real Sail infrastructure, job `6afd7d775249`.
Artifacts (gitignored, per the repo's rule that live runs stay out of
`fixtures/`): `runs/ton23/cold-run.log`, `runs/ton23/judge.log`,
`runs/ton23/6afd7d775249/b{0,1,2}.json`.

Request used — verbatim from `demo/demo_config.json`, as the run of show requires:

> Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven.

## The capture is not yet completable

`docs/demo-run-of-show.md` says the cold video must show, in order:

> Three isolated branches, pairwise comparisons, chosen trace, **synthesized
> runbook, and saved runbook**.

The first three happen. The last two **cannot currently be produced from a real
cold run** — see "The M2 → M3 break" below. Recording now would capture a clip
that stops two beats short of the point the demo is making.

## Timings, for the voiceover

The number that makes the warm replay land is the cold path's wall clock:

| phase | wall |
|---|---|
| base box up | 0.9s |
| base seeded | 0.5s |
| checkpoint fan-out, 3 children | 3.1s |
| branch b0 | 205.8s (11 steps) |
| branch b1 | 170.2s (11 steps) |
| branch b2 | 263.3s (12 steps) |
| judge, 3 runs | ~40s |

Branches run concurrently, so end to end is **~4.5 minutes**, of which
**infrastructure is 4.5 seconds**. Everything else is agents thinking — which is
exactly the contrast the warm replay inverts. Quote ~4.5 minutes, not the sum.

## What the run proved

**Three genuinely different angles**, which is the precondition for the judge
having anything to compare:

- b0 — go straight to the most obvious primary source and take the first result
- b1 — build a candidate list from an independent source, then cross-check
- b2 — identify the constraint the caller will flex on, relax it, optimise elsewhere

**The judge is consistent: 3/3 for b1**, with reasons that turn on substance
rather than length — b1 held every stated constraint, b2 explicitly relaxed
"at seven", b0 never identified a restaurant at all. That is the pairwise
judging story Talia narrates over the video, and it is real.

**Invariant 1 held under live conditions.** Every branch stopped at the
reservable page and said so. b1: *"Not booked — I stopped at the reservable
booking pages, as the actual reservation is an irreversible step that must be
performed by a human after confirmation."* No branch attempted the commit.

**b0 independently rediscovered the OpenTable block** — *"every request to
www.opentable.com completes the TLS handshake and then is dropped"* — from a
different box, on a different IP, with no knowledge of TON-8. Useful
corroboration that the block is infrastructure-wide, not an artifact of one
session.

## The M2 → M3 break

`distiller.py` refuses every branch of a real cold run:

```
refused b0.json: branch b0 did not complete the task        <- correct, success_signal=False
refused b1.json: no request value was lifted into a slot
refused b2.json: no request value was lifted into a slot
```

b0's refusal is right. b1 and b2's is a **vocabulary mismatch between the two
halves of the pipeline**:

| | steps |
|---|---|
| distiller fixtures (`fixtures/trajectories/`) | `goto`, `fill{selector,value}`, `submit` |
| real branch agent output | `run{command}`, `note` |

`_lift_slots` builds slots from values the trajectory **wrote into form fields**.
A shell branch never writes one — `branch_agent.py` offers exactly three tools,
`shell`, `note` and `finish`, so it **cannot** emit `fill` or `goto`. The
distiller was developed against hand-written browser-shaped fixtures; the branch
agent produces curl-shaped trajectories. Both pass their own tests.

This is not a tuning problem and no amount of re-running the cold path changes
it. Until it is resolved, **M3's exit criterion — the same request being slow
then instant — cannot be met from a real cold run**, because the synthesized
runbook at the middle of it never gets produced.

### Options, for whoever owns TON-21

1. **Teach the distiller the shell vocabulary** — lift slots from the request
   text, corroborated by their appearance in commands/URLs rather than in form
   writes. Keeps branches as they are. Note this weakens the property the
   distiller deliberately protects: it currently refuses to invent a slot that
   no written value can trace back to the request, precisely so a runbook cannot
   be built that books one hardcoded restaurant forever. Any change here should
   preserve that refusal, not delete it.
2. **Give branches browser tools** so they emit `goto`/`fill`. Truer to the
   fixtures, but branch boxes have no browser today, and it enlarges the surface
   Invariant 1 has to guard.
3. **Accept a hand-written runbook for the demo** and do not claim the cold run
   synthesized it. Cheapest, and honest only if nobody says "and it wrote this".

This is a design call, not a bug fix, which is why it is written up rather than
patched here.

## Still to do before this can be recorded

- Resolve the break above so a synthesized + saved runbook actually appears.
- TON-20 (M2 proof) formally closed — this run is its evidence.
- The callback-speaking beat, which this capture did not exercise.
- The recording itself: a human with a screen recorder, cut to under a minute.
