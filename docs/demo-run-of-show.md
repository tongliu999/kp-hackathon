# TON-24 on-stage run of show

This is a three-minute, two-pass demo. The cold pass is a recording; the warm
pass is live. Do not reverse that order, silently switch to a stub, or paraphrase
the request. The source of truth for the utterance is
[`demo/demo_config.json`](../demo/demo_config.json).

## The one line

**Why it matters:** The second request skips exploration without skipping
control: learned work becomes fast, reusable, and still requires confirmation
before a real booking.

## People, positions, and controls

```text
                             SCREEN

       Talia                   Shyam             Tong + demo laptop
     stage left               center                 stage right

                            AUDIENCE
```

- **Shyam — host and requester:** opens and closes, speaks both requests, and
  gives the final verbal confirmation. He stays center and does not touch the
  laptop.
- **Tong — sole laptop driver:** stands stage right at the demo laptop, rolls
  the cold-path video, changes to the live warm-path window, watches system
  status, and invokes only the rehearsed pivot. No one else drives.
- **Talia — system and safety explainer:** stands stage left, delivers the
  30-second pairwise-judging explanation over the cold-path video, then calls
  out the confirmation boundary during the live run.

Tong's laptop is connected to the projector and power. Notifications, sleep,
automatic updates, and screen mirroring prompts are disabled. The cold video
is preloaded and paused at frame zero; the live window is signed in, reset, and
visible in the adjacent workspace. Tong keeps hands off the trackpad while
Shyam is speaking so the audience can see that voice triggered the run.

## Request contract

Exact spoken request (use verbatim in both runs):

```text
Book a table for two at an Italian restaurant in San Francisco tomorrow evening at seven.
```

Speak at rehearsal pace, including “at seven.” After the live assistant asks
for permission to place the reservation, Shyam says exactly: **“Yes, book it.”**
That answer is not part of the initial request and must not be supplied early.

“Tested” here means the exact text and its normalized matcher tokens are locked
by the repository test. It does not claim that every microphone, room, accent,
or speech-to-text variation has been validated.

## Three-minute cue sheet

| Time | Owner | On-stage action and exact cue | Visible proof |
|---|---|---|---|
| 0:00–0:10 | Shyam | “Most assistants start from zero every time. Ours learns a safe shortcut.” | Title slide; Tong does not interact. |
| 0:10–0:20 | Shyam | Read the exact request above once. Then: “This first attempt is unfamiliar, so here is the cold path captured earlier.” | Tong starts the cold-path video only after “earlier.” |
| 0:20–1:10 | Tong | Play the cold video from start to finish with no scrubbing. | Three isolated branches, pairwise comparisons, chosen trace, synthesized runbook, and saved runbook appear in that order. |
| 0:25–0:55 | Talia | Deliver the 30-second script below while the video shows branching and selection. | Video continues silently beneath her explanation. |
| 1:10–1:20 | Shyam | “Now ask for the same outcome again.” Pause and look at the live window. | Tong switches directly from video to the reset live window. |
| 1:20–1:35 | Shyam | Repeat the exact request verbatim. Do not add “again.” | Live transcript must visibly match the fixture closely enough to identify every slot. |
| 1:35–1:55 | Tong | Hands off after starting capture. Let the warm path match and execute. | Saved runbook match, filled slots, and sequential steps are visible; no new branching animation. |
| 1:55–2:10 | Talia / Shyam | Talia: “The irreversible step has stopped at the gate.” Shyam waits for the prompt, then says “Yes, book it.” | Confirmation is requested before the booking action; approval appears once. |
| 2:10–2:30 | Tong | Let the final action finish; point to the successful step result without opening logs. | One confirmed path and the final result are visible. No retries. |
| 2:30–2:50 | Shyam | Deliver the one-line why-it-matters statement exactly. | Keep the completed warm-path result on screen. |
| 2:50–3:00 | Shyam | “Solve once. Reuse safely. Stay in control.” Stop. | Tong makes no further interaction. |

The ten-second margins around live transitions are intentional. Never speed up
the confirmation or speak over the assistant to recover time.

## Pairwise judging: 30-second script

Talia delivers this verbatim, at roughly 140 words per minute:

> For a task we have not seen, three agents try independent paths in separate
> sandboxes. We compare two traces at a time on task completion, safety, and
> clarity, then keep the stronger trace and compare again. That gives us a
> practical candidate to distill into a runbook; it is not proof that the path
> is globally best or always reliable. The confirmation gate still protects
> the irreversible step.

Do not say that pairwise judging guarantees the best trajectory, proves
correctness, or measures production reliability. It ranks the available demo
traces using stated criteria; it can still choose poorly.

## Failure and stub pivots

Tong owns the pivot decision. Talia continues narrating only after Tong says
“pivot” quietly to the team. Never imply that prerecorded or stubbed output is
live.

| Failure signal | Tong's immediate action | Shyam's disclosure and continuation |
|---|---|---|
| Cold video will not start within 5 seconds | Switch to the pre-opened backup copy, paused at frame zero. If that also fails, show the final trajectory/runbook still and skip to 1:10. | “The recorded cold run is unavailable, so this is the saved artifact it produced.” Talia gives the judging script; do not describe unseen motion. |
| Microphone or transcription misses any required slot | Stop; do not paraphrase repeatedly. Paste `exact_spoken_request` from `demo/demo_config.json` into the live input once. | “The room audio missed the request; we are using the exact tested text fixture.” Continue the warm run as a text-input demo. |
| Warm matcher returns no runbook | Do not wait for cold branching. Select the known `restaurant-reservation` fixture only if the rehearsed UI exposes an explicit saved-runbook control. Otherwise go to the stub pivot. | “The live matcher missed, so we are selecting the saved runbook explicitly.” This demonstrates execution, not matching. |
| External service or Sailbox is red before the irreversible step | Enable the rehearsed local stub only if the UI displays a persistent **STUB** badge; rerun the same fixture. If no labeled stub exists, stop the live run and keep the cold artifact on screen. | “External execution is unavailable. This labeled stub preserves the control flow but is not a live booking.” Continue through confirmation only to show the gate. |
| Confirmation control is absent, pre-approved, or bypassed | Abort the live path immediately. Do not click or call the irreversible action manually. | “The safety gate is not healthy, so we will not execute the final action.” Close with the one-line why; never simulate approval invisibly. |
| Any step errors after a dispatch | Leave the first error visible. Do not retry. | “The executor stopped on the first failure; it does not retry a possibly irreversible action.” Close without claiming success. |

If the demo uses a stub, the final line changes from “learned work becomes” to
“the design makes learned work,” avoiding a claim that the observed run was
live end to end.

## Rehearsal checklist

### Day before

- [ ] Shyam, Tong, and Talia each read this file and agree on the exact claims.
- [ ] Run the complete cold capture with the exact request; verify three
  branches, pairwise selection, synthesis, and persistence are all legible.
- [ ] Run the same request through the warm path twice from a reset state.
- [ ] Verify the live transcript contains `two`, `Italian`, `San Francisco`,
  `tomorrow evening`, and `seven` before proceeding.
- [ ] Reject confirmation once and verify the final action is never dispatched.
- [ ] Approve once and verify exactly one final dispatch and no retry.
- [ ] Rehearse each pivot, including the spoken disclosure, once.
- [ ] Time Talia's judging script between 27 and 33 seconds without rushing.
- [ ] Run `python -m pytest` and keep the commit hash with the demo notes.

### Thirty minutes before stage

- [ ] Use power, wired networking if available, and the actual projector/audio
  path; disable notifications, sleep, automatic updates, and screen savers.
- [ ] Confirm environment and service health without exposing credentials.
- [ ] Preload the primary and backup cold video at frame zero.
- [ ] Open the clean warm UI and verify the saved `restaurant-reservation`
  runbook exists; reset any prior confirmation or result state.
- [ ] Open `demo/demo_config.json` locally for the text-input pivot.
- [ ] Verify any stub mode has a persistent, audience-visible **STUB** label.
- [ ] Put all other windows on a different desktop and enlarge demo text.

### Two minutes before stage

- [ ] Tong is stage right on the only laptop; Talia is stage left; Shyam is
  center. Each person confirms their first cue.
- [ ] Tong checks primary video, live window, backup video, then returns to the
  title slide. No terminals or secrets remain visible.
- [ ] Shyam says the exact request once off-mic; nobody suggests synonyms.
- [ ] Talia has the pairwise script on a confidence monitor or printed card.
- [ ] Start a visible three-minute timer only if it was used in rehearsal.

### After the demo

- [ ] Do not place a second booking while answering questions.
- [ ] If the final action was real, Tong verifies its recorded result and uses
  the team's rehearsed cleanup/cancellation process off stage.
