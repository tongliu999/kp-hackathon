# TON-23 — cold-path capture notes

First end-to-end cold run against real Sail infrastructure, job `6afd7d775249`.
Artifacts (gitignored, per the repo's rule that live runs stay out of
`fixtures/`): `runs/ton23/cold-run.log`, `runs/ton23/judge.log`,
`runs/ton23/6afd7d775249/b{0,1,2}.json`.

Request used — verbatim from `demo/demo_config.json`, as the run of show requires:

> Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven.

## Status: the full chain now runs

`docs/demo-run-of-show.md` says the cold video must show, in order:

> Three isolated branches, pairwise comparisons, chosen trace, **synthesized
> runbook, and saved runbook**.

All five now happen. The last two were blocked by a vocabulary mismatch between
the branch agent and the distiller — described under "The M2 → M3 break" below,
and since fixed. Reproduce the whole chain with:

```
PYTHONPATH=src .venv/bin/python -m runbook_voice.branch_search_demo "<request>" --out runs/ton23
PYTHONPATH=src .venv/bin/python -m runbook_voice.judge_check --fixtures runs/ton23/<job>  --runs 3
PYTHONPATH=src .venv/bin/python -m runbook_voice.distiller runs/ton23/<job>/b1.json -o runs/ton23/synthesized_runbook.json
```

**M3's exit criterion is met:** the same request that took ~4.5 minutes cold is
served from the synthesized runbook in **0.1s** — retrieved by the matcher and
replayed through the real executor and confirm gate. Booking is stubbed only
because TON-8's provider login is still outstanding.

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

### How it was fixed

`_lift_from_request` handles research trajectories; browser trajectories keep the
strict path unchanged. Which one applies is decided by the trajectory's shape,
not by falling back when the first one returns nothing.

**What was deliberately not done:** per-slot corroboration was not faked.
Substring-searching commands for each value looks rigorous and is noise — on the
real trajectory `\b2\b` matches the `<h2` inside a grep pattern, which would
"prove" a party size of two from an HTML tag. A check that can be passed by
accident is worse than an absent one, because it reads as evidence. Observations
and final answers are excluded for the same reason: they restate the task in the
agent's own words, so finding a value there proves only that the agent was told
it.

Two properties hold instead, and they are what keep it honest:

- **Only values the request mentioned become slots**, so the "Ristorante
  Adriatico" failure remains impossible — that refusal still fires, and is
  still tested.
- **The run must have pursued this request** — at least one request value has to
  appear in what the branch actually executed. Otherwise a trajectory that
  solved a different task could donate its slots.

Concrete values still cannot reach the document by any path: `_arguments` emits
only `{{slot}}` templates and `_verify` rejects leaked mechanics.

### Two things the first real trajectory exposed

- **The vocabulary had no `city` slot**, so the distilled runbook declared four
  slots while the dialogue collects five. The executor fail-closes on unknown
  slots, so replay died on `unknown slots: city` — M3's output was not drivable
  by M1's dialogue. Added, captured positionally after "in" rather than from a
  list of known cities.
- **The readback said "at a {{cuisine}} restaurant"**, which speaks as "a
  Italian restaurant". The article cannot be chosen at distill time because the
  value is a template, so it was dropped rather than guessed.

## Still to do before this can be recorded

- TON-20 (M2 proof) formally closed — this run is its evidence.
- The callback-speaking beat, which this capture did not exercise.
- The recording itself: a human with a screen recorder, cut to under a minute.
- Optionally re-run the cold path once more for a visually clean take; the
  chain is now repeatable end to end.
