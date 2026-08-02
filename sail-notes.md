# Sail notes

Every claim is tagged **[VERIFIED]** (checked against the installed `sail==0.5.6` SDK on this
machine), **[DOC]** (read from docs.sailresearch.com, not executed), or **[OPEN]** (unknown,
needs an API key to settle).

Authenticated and **run against real Sail infrastructure** (prod, `~/.sail/auth.toml`).
Numbers below are measured, n=5 runs × 3 children unless stated.

## Setup (done)

- `sail==0.5.6` installed into `.venv` (Python 3.12; system Python is 3.14 and was avoided) [VERIFIED]
- CLI installed to `~/.sail/bin/sail` — **not on PATH yet**: `export PATH="$HOME/.sail/bin:$PATH"` [VERIFIED]
- Docs MCP wired at **user scope**, so every Claude Code session on this machine gets it: [VERIFIED]
  ```
  claude mcp add --transport http sail-docs https://docs.sailresearch.com/mcp
  ```
- **No API key.** Self-serve signup at https://app.sailresearch.com, then `sail auth login`. [DOC]

## API surface [VERIFIED — read off the installed SDK]

```python
sail.App.find(name: str, *, mint_if_missing: bool = False) -> App
sail.Sailbox.create(*, app, name, image=None, size=None, memory_gib=None, disk_gib=None,
                    ingress_ports=None, volumes=None, ssh=False, private=False,
                    timeout=600, image_build_timeout=1800) -> Sailbox
sb.run(command, *, timeout=None, cwd=None, env=None, check=False) -> ExecResult
sb.fork(*, name=None, timeout=None) -> Sailbox
sb.checkpoint(*, name=None, ttl_seconds=None) -> SailboxCheckpoint
sail.Sailbox.from_checkpoint(checkpoint_id, *, name=None, timeout=None) -> Sailbox
sb.pause() / sb.resume() / sb.sleep() / sb.terminate()
sb.expose() / sb.unexpose() / sb.listener() / sb.wait_for_listener()
sb.fs   # SailboxFs — file ops
```

An `app` is **required** on every `create`. Use `App.find(name=..., mint_if_missing=True)`.

## Process survival across a fork — RESOLVED [VERIFIED]

The docs page and the SDK docstring appear to contradict each other. They don't — they describe
different things, and the distinction is operationally important.

- Docs page: *"processes the parent was running carry on in the child."*
- SDK `fork()`: *"commands still running in the parent do not continue in the child."*
- SDK `from_checkpoint()`: *"In-flight `Sailbox.exec()` sessions are reaped in the child."*

Measured directly (`sleep 901` launched via `setsid nohup`, `sleep 902` left running inside a live
`sb.exec()` session, then forked):

| | parent | child |
|---|---|---|
| **Detached** (`setsid nohup`) | present | **present — survived** |
| **Bound to a live `exec()` session** | present | **gone — reaped** |

**The rule: detached daemons survive a fork; anything tied to an in-flight `exec()` session does
not.** Both sources are correct about different process types.

Confirmed across the bake-off: **30/30 children** kept both the disk marker and the detached
process, on fork and on checkpoint alike. No intermittency observed.

### What this means for the team

**Talia (TON-8):** a browser launched **detached** inside the box does survive a fork. Still use a
persistent on-disk `user-data-dir` rather than relying on that:

> **Auth lives in an on-disk browser profile. Every branch relaunches the browser from that
> profile directory.**

Disk survival is unconditional; process survival is empirical (30/30 here, but [DOC] warns a child
*"sometimes comes up cold"* and **always** does when it mounts a volume). The on-disk profile works
in both worlds and costs nothing.

**Tong (TON-13):** branch agents must launch anything long-running **detached**, and must not fork
while an `exec()` they care about is in flight — it will be reaped in the child.

Also: [DOC] *"open TCP connections are reset in the child, and it starts with no inherited
ingress ports"* — a forked child needs `expose()` re-called if it serves anything.

## fork vs checkpoint — the TON-13 decision

| | `fork()` | `checkpoint()` → `from_checkpoint()` |
|---|---|---|
| Durability | [VERIFIED] *"The copy is transient: no durable checkpoint is taken"* | [VERIFIED] durable handle, `ttl_seconds` |
| Parent needed | Must be alive | [VERIFIED] *"works even after the parent is gone"* |
| Fan-out cost | One call per child | [DOC] *"Starting multiple children from the same checkpoint reuses the same checkpoint artifacts, so the second and later children avoid re-checkpointing the parent"* |
| Live processes | [VERIFIED] not carried | [VERIFIED] not carried |

### Measured [VERIFIED] — n=5, wall-clock from "base ready" to "all 3 children accepting exec"

| strategy | median | min | max | disk | detached proc |
|---|---|---|---|---|---|
| `fork()` ×3 | **11.0s** | 10.9 | 11.3 | 30/30 | 30/30 |
| `checkpoint()` → `from_checkpoint()` ×3 | **3.8s** | 3.7 | 4.0 | 30/30 | 30/30 |

**Recommendation for TON-13: checkpoint fan-out.** ~3× faster, variance is tiny on both, and the
checkpoint is durable — the base box can die and you can still branch. Reproduce with
`.venv/bin/python research/fanout_bakeoff.py --runs 5`.

### Other measured facts

- **`Sailbox.create()` takes ~1.0s**, not the *"few minutes"* the docs warn about. The cold-path
  demo will be dominated by agent work, not infrastructure — this substantially de-risks the
  stage-time concern that argued for pre-creating boxes.
- **3 concurrent boxes are fine** — 5 consecutive runs, no quota or rate-limit error. Concurrency
  ceiling above 3 is still [OPEN], but N=3 is proven and that's all TON-13 needs.
- `terminate()` ~0.9s.

## Voyages cannot be exported [VERIFIED] — this settles the trajectory format question

`sail.Voyage` methods, read off the SDK:

```
agent, cancel, child_env, complete, error, event, fail, flush, headers, span
```

**Every one is write-side.** No `get`, `from_id`, `list`, `export`, `fetch`, `trace`. There is no
programmatic path to pull a trace back out of the SDK.

**Conclusion: Voyages is dashboard-only observability, not a data source.** Hand-roll the
trajectory format. Do not build M3's distiller on top of Voyages.

Minimum viable schema, so nobody designs one at hour 12:

```python
{"branch_id": str, "angle": str,
 "steps": [{"t": float, "action": str, "args": dict, "observation_excerpt": str, "url": str}],
 "final_answer": str, "success_signal": bool, "wall_ms": int}
```

`steps` is what M3 distills into a runbook. **Final answers alone make M3 impossible.**

Keep Voyages as a demo visual if it's free to add. Nothing depends on it.

## Credential injection — possibly relevant to TON-8 [VERIFIED api, [OPEN] fit]

Sail ships a first-class secret/credential-injection system:

```python
sail.Credential.set_secret("TOKEN", value)          # write-only, never readable back
sail.Credential.create_policy("name", [
    sail.Credential.header_rule(host="api.example.com", ...),
    sail.Credential.query_param_rule(...),
])
sb.set_credential_policy(...) / sb.clear_credential_policy()
```

SDK docstring: *"inject secret values into HTTPS requests your Sailboxes send to matching hosts,
so code running in a Sailbox can call authenticated APIs without ever holding the credential."*

**This is for API auth, not browser-cookie auth.** It does not help a logged-in browser session.
But if the chosen booking provider has an HTTP API, this is dramatically cleaner than browser
automation and would simplify TON-8 substantially. Worth 10 minutes of Talia's time when picking
the provider.

## Persistence across a real disconnect — TON-7 [VERIFIED]

Settles the *generic* half of the pause/resume question. Measured against prod with `demo.py`
(worktree `effervescent-soaring-truffle`): phase 1 boots a box, writes state, sleeps it and
exits; **phase 2 is a separate OS process** handed nothing but the sailbox id. A handle going
out of scope inside one process would have proved nothing.

Three things had to hold, and all three did on every run:

| check | how |
|---|---|
| **same box** | `created_at` from the control-plane snapshot is unchanged |
| **disk survived** | a token written via `fs.write` **and** a second written by a shell *inside* the box |
| **plumbing** | `exit 7`, with stdout and stderr split correctly |

`created_at` is the load-bearing one — without it "reconnect" could quietly be a brand-new box
and every other check would still pass. The two write paths matter because they fail
independently, and downstream the writes that count are the *agent's* own.

**A bare `sleep()` → `resume()` needs no explicit `checkpoint()`.** State came back *warm* —
same `/proc/sys/kernel/random/boot_id`, so memory was restored, not just disk. The `sleep()`
docstring explains why: it checkpoints on the way down. The [DOC] *"may come back cold"* caveat
never fired here.

### Measured [VERIFIED] — n=5 each

| | median | min | max |
|---|---|---|---|
| `create()` — first box in a **fresh process** | 937 ms | 779 | 1587 |
| `create()` — later boxes, **warm process** | **498 ms** | 417 | 762 |
| wake from `sleep()` | **509 ms** | 461 | 576 |
| `run()` round-trip | **95 ms** | 94 | 99 |
| `terminate()` | ~900 ms | 888 | 980 |

**Wake costs about the same as a cold create (~0.5s).** Parking a box asleep is therefore free
*and* fast — no reason to keep one hot between rehearsals.

**~400ms of the first boot is one-time SDK transport setup** — boot #1 836ms, then 409 / 442 /
588 / 527 in the same process. A long-running orchestrator pays that once, so budget **~0.5s
per box**, not ~1s.

### What this means for the team

**Infrastructure is not what makes "give me a few minutes" take minutes.** At 95ms per command,
a 20-step warm replay is ~2s of Sail time. The cold path's minutes are all agent work.

**Talia (TON-8):** the layer *under* your auth is solid — disk and memory both survive a
sleep/resume from a fully dead client. What remains unproven is only whether the **provider**
still accepts the session, which is the half that needs a real provider to test.

## Still open

Answered above: process survival, fork-vs-checkpoint, N=3 concurrency, create timing, and
disk/memory survival across a disconnect (TON-7).

Remaining, and all of it is the **auth** half — it needs a chosen booking provider, so it belongs
with Talia's TON-8 rather than here:

- **[OPEN]** Does a real browser login survive `pause()` → `resume()`? *This is the half that sits
  on the critical path* — it's the warm-replay story and the reason for choosing Sail.
  **Narrowed by TON-7:** the box layer is settled — disk *and* memory survive sleep/resume from a
  dead client. What's left is purely whether the provider re-accepts the session, so this is now a
  provider question, not a Sail question.
- **[OPEN]** Does a login survive a fork, and **does the child get a different egress IP?** Not
  stated anywhere in the docs. Only matters if the provider pins sessions to IP or fingerprints
  the device.
- **[OPEN]** Concurrency ceiling above 3.

Test the first two against the *actual* provider, not a generic site — success means "the provider
still accepts the session", not "the cookie file is present."

## Cost [DOC]

$0.015/vCPU-hr · $0.008/GiB-RAM-hr · $0.0007/GiB-hr disk · create charge $0.005 (S) / $0.01 (M) /
$0.012 (L). Free-tier amount is **not stated** on the pricing page.

Useful: *"You are not charged while a Sailbox is sleeping, paused, checkpointing, or cold-starting."*
Parking the warm box between rehearsals is free.

## Gotchas

- **It's `ckpt.checkpoint_id`, not `ckpt.id`** [VERIFIED] — `SailboxCheckpoint` has no `.id` and
  using it raises `AttributeError`. Instance fields: `checkpoint_id`, `sailbox_id`,
  `checkpoint_generation`, `expires_at`, `status`.
- [DOC] A child **always** comes up cold when it **mounts a volume** → avoid `volumes=` on boxes
  you intend to fork.
- [VERIFIED] `create(timeout=600)` defaults to 10 minutes. That's the *deadline*, not the
  expectation — measured creation is ~0.5s warm / ~0.9s on a fresh process (TON-7, n=5).
- **`create()` returns a bare handle** [VERIFIED] — `created_at`, `started_at` and `image_id` are
  all `None` on the object it hands back. Snapshot fields only populate via `Sailbox.get(id)`.
- **No `/etc/machine-id`** in the Debian 12 base image [VERIFIED], and `hostname` is literally
  `(none)`. There is no stable OS-level box identity — use the control plane's `created_at`.
  `/proc/sys/kernel/random/boot_id` exists but is per-*boot*, making it a warm-vs-cold signal
  rather than an identity one.
- `run()` with a string goes through `/bin/sh -lc`; pass a list to exec directly.
- Namespace boxes by app so concurrent sessions don't terminate each other's work:
  `app=branch-research` (research session) vs `app=spine` (TON-7 session).
