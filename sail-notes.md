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

## Branching search — what TON-13 shipped [VERIFIED]

Lives in `src/runbook_voice/branch_search.py` (orchestration) and
`src/runbook_voice/branch_agent.py` (the program that runs *inside* each box).
`BranchingSearch` satisfies `ColdTaskWorker`, so it drops into TON-14's coordinator.

### Sail serves inference too — this changes what a branch can be

The Voyages finding above is right (write-only, not a data source) but it left the
impression Sail is only infrastructure. It is not: **Sail serves models**, OpenAI-compatible
at `https://api.sailresearch.com/v1`, on the same credential. So a branch runs a *real* agent
loop **inside its own box** with no third-party API key.

- `sail.Config.from_env().api_key` resolves a key from `SAIL_API_KEY` **or** from the
  credential `sail auth login` stored in `~/.sail/auth.toml` [VERIFIED]. That is what the
  orchestrator hands the guest — in `env=` on the launch command, never written to box disk.
- Models: `zai-org/GLM-5.2-FP8` (used here), `moonshotai/Kimi-K2.6`, `openai/gpt-oss-120b`,
  `Qwen/Qwen3.6-35B-A3B`, `google/gemma-4-31B-it`, `nvidia/*` [DOC].
- **Completion windows are the latency knob**, and the default is the wrong one for an agent
  loop: `standard` (the default) targets ~5 min/turn, `priority` ~1 min, `asap` immediate
  [DOC]. Branches set `metadata.completion_window = "priority"` — each turn feeds the next, so
  8 steps at `standard` would be a ~40-minute branch. Measured single trivial turn at
  `priority`: **8.4s** [VERIFIED].
- *"You are not charged while a Sailbox is … cold-starting"*, and Sailboxes
  *"automatically sleep while waiting on Sail inference calls"* [DOC] — branch idle is cheap.

### The base image has what a branch needs [VERIFIED — probed on prod]

`python3` **3.11.2** and `curl` are both already in the Debian base image, the guest reaches
`api.sailresearch.com` (HTTP 200) and the open web (HTTP 200), and the shipped agent
byte-compiles in the box. So there is **no `pip install` and no `apt-get` on the hot path** —
the seed step is 0.3s. The agent program is stdlib-only for exactly this reason, and is
shipped by writing its own source into the box with `fs.write`.

### Shape, and why

1. boot one base box (`app=branch-search`) → 2. seed it **synchronously** → 3. `checkpoint()`
→ 4. three `from_checkpoint()` children concurrently → 5. each child launches the agent
**detached** and the orchestrator polls for a `DONE` marker → 6. read back, validate, persist
→ 7. terminate everything in a `finally`.

Steps 2 and 3 are ordered that way on purpose: an `exec()` in flight is reaped in the
children, so the seed must finish first. Step 5 is detached for the same reason. The base box
exists so python3 and the agent are inherited once rather than installed three times.

`DONE` is written *after* `trajectory.json`, so a poller never reads a half-written file, and
steps are appended to `steps.jsonl` as they happen — a branch that dies is salvaged from its
step log rather than lost. A partial trajectory is evidence; a missing one is a hole in the
comparison.

### Invariant 1, in code

Branches research and do in-box work. **Branches never book.** Three layers:

1. **Structural** — `branch_search.py` does not import `executor.py`. `RunbookExecutor` and
   `ConfirmationGate`, the only code that performs a gated irreversible step, are unreachable
   from a branch. A test parses the module's AST to assert it, rather than grepping.
2. **Capability** — a branch's tools are in-box shell and HTTP reads. It holds no
   confirmation gate, and `RunbookExecutor` denies when the gate is missing.
3. **Guard** — `branch_agent.screen_command` refuses write-shaped requests (`-X POST/PUT/
   PATCH/DELETE`, a request body, or a committing path like `/checkout`) *before* they run. A
   blocked attempt is recorded as `outcome: "abandoned"` with a note rather than dropped, so
   the judge can see that a branch reached for the irreversible step and was stopped. It
   fired on a real run, exactly as intended.

   **The guard screens for write shape, not for booking vocabulary** [VERIFIED the hard way].
   The first version also refused any URL containing `book`/`reserv`, and a branch reported in
   its own final answer that *"the environment's guard blocked all my live-availability
   fetches"*. That rule was wrong twice over: a GET is not irreversible, and reaching the page
   that offers the booking is the branch's **success condition**, not a violation. The
   irreversible step is the submission.

### Two things measured on real runs that the design depends on

- **Tell the agent its step budget.** First run: all three branches spent every step
  investigating, hit `step_budget_exhausted`, and returned **no final answer at all**. The
  model cannot ration a budget it cannot see. After stating the budget in the prompt and
  appending `[N steps left.]` to every tool result (with a forced wrap-up on the last),
  all three produced real answers. Same infra, same model — the difference is entirely that
  the agent knew when to stop.
- **Tell it not to swallow exit codes.** `outcome` comes from the shell exit code, and an
  agent writing `cmd; echo EXIT $?` records five consecutive failures as `ok`. That corrupts
  precisely the field the judge ranks on.

Per-branch wall time is ~2 minutes for 10-12 steps at `priority`, and the three run
concurrently — so the cold path is ~2.5 minutes end to end, of which infrastructure is ~4.5s.

Output lands in `runs/<job_id>/b{0,1,2}.json` (gitignored) — **not** `fixtures/trajectories/`,
which holds the locked hand-written examples `schema/validate.py` checks.

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

Settles the *generic* half of the pause/resume question. Measured against prod with
`src/runbook_voice/sailbox_demo.py`: phase 1 boots a box, writes state, sleeps it and exits;
**phase 2 is a separate OS process** handed nothing but the sailbox id. A handle going out of
scope inside one process would have proved nothing.

Lifecycle lives in `src/runbook_voice/sailbox.py` — `boot()` and `connect()`, returning a
`BoxHandle`. That is the half `executor.py` deliberately omits: its `PersistentSailboxRunner`
protocol has no create/start method, so replay can never spin up a box between steps. The Sail
SDK is imported lazily behind the `[sailbox]` extra, so importing `runbook_voice` does not
require it.

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

Reproduce with `PYTHONPATH=src .venv/bin/python -m runbook_voice.sailbox_demo` (the repo `.venv`
has `sail` but not the package itself installed; `pip install -e '.[sailbox]'` gets you the
`runbook-sailbox-demo` console script instead). `… sailbox_demo check <id>` re-verifies any box
later, `kill <id>` removes it.

### What this means for the team

**Infrastructure is not what makes "give me a few minutes" take minutes.** At 95ms per command,
a 20-step warm replay is ~2s of Sail time. The cold path's minutes are all agent work.

**Talia (TON-8):** the layer *under* your auth is solid — disk and memory both survive a
sleep/resume from a fully dead client. What remains unproven is only whether the **provider**
still accepts the session, which is the half that needs a real provider to test.

## Browser auth in the box — TON-8 [VERIFIED against prod]

### Some sites block Sail's egress outright. Check this before choosing a provider.

**OpenTable is unusable from a Sailbox.** Its Akamai edge returns **403 Access Denied** for
search (`/s?term=`), city (`/<city>-restaurants`) and venue (`/r/<venue>`) pages — in a real
Chromium with a real browser fingerprint, not just curl. Only `/my/profile` (login) renders.

Measured from **three separate Sail egress IPs** — 54.202.28.162, 54.191.8.10, and a fresh
box — including a forked child, which gets its own IP. So it is an **egress-range** block,
not one poisoned address. `Sailbox.create()` exposes **no region option**, so there is no
Sail-side way around it.

Two traps that cost real time here, worth knowing for any provider:

- **Only the login page working makes a network block look like an auth problem.** It is not.
- **`/s?term=` returns HTTP 200 with an Access Denied *body*.** Status code and page title
  both lie. **Assert on rendered text**, never on `response.status()` alone.

Resy serves everything from the same box. That is why TON-8 chose it.

### You may be able to READ a site from a Sailbox and still not be able to LOG IN

The most expensive finding in TON-8, and the least obvious. Bot protection guards
**auth endpoints** far harder than content, so a provider can look completely
usable right up until someone tries to sign in.

Measured on Resy, identical request, only the source IP differing:

| request | from the Sailbox | from a residential IP |
|---|---|---|
| `OPTIONS /4/auth/mobile` | **500**, no CORS headers | **204** + full `access-control-allow-*` |
| `OPTIONS /3/auth/password` | **500** | **204** |
| `OPTIONS /4/find` | 204 | 204 |
| `GET /` | 302 | 302 |

Reading works. Searching works — the site returns 80 real bookable slots. Only
`/*/auth/*` is refused, repeatably (3/3), from Imperva's edge.

**In a browser this is invisible.** A 500 carrying no `Access-Control-Allow-Origin`
is indistinguishable to the browser from a CORS misconfiguration, so the console
says:

```
Access to XMLHttpRequest at 'https://api.resy.com/4/auth/mobile' … has been
blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

and the login button simply does nothing — no error, no spinner, nothing on
screen. It reads exactly like a broken form or bad credentials. Two people burned
significant time on "the account must be unverified" before the source-IP
comparison settled it.

**How to diagnose this in one step:** send the *exact* failing request from the
box and from a non-datacenter IP and compare. Anything else — retrying the login,
checking the password, re-reading cookies — cannot distinguish the two causes.
Note also that `x-iinfo` differed consistently (`PNNN` from the box vs `NNNN`
from residential), which is Imperva classifying the traffic before it ever
reaches the origin.

**Consequence for any in-box auth plan:** logging in *from* a Sailbox may be
impossible regardless of credentials. Verify a provider's auth endpoint from the
box **before** choosing it.

### Importing a session does not rescue it — tried, and it fails for the same reason

The obvious workaround is to authenticate on a residential IP and carry the
cookies in. It was implemented (`scripts/import-session.mjs`) and it does not
work for Resy.

All 15 cookies import cleanly, including the httpOnly `production_refresh_token`,
and the token survives in the profile. But it is a **refresh** token: on every
page load the app exchanges it for an access token via

```
POST https://api.resy.com/3/auth/refresh   ->  net::ERR_FAILED   (from the box)
GET  https://api.resy.com/3/collections    ->  200               (same page load)
```

The exchange is an auth endpoint, so it is blocked, so the session never
activates. The page renders logged-out with a perfectly valid credential sitting
in its cookie jar.

**The general shape: a session is not a cookie, it is a cookie plus the right to
refresh it.** Any provider that mints short-lived access tokens from a
long-lived refresh token cannot be smuggled into an environment whose egress the
provider blocks — you would have to import a fresh access token faster than it
expires, which is not a demo you want to run.

An access token cached in `localStorage` could in principle be imported instead
(Playwright's `storageState` carries origins as well as cookies), but it would
expire mid-demo with no way to refresh, which is worse than a stub.

**What actually fixes it** is changing the egress, not the credential: route the
box's browser through a proxy on a non-datacenter IP (`--proxy-server`, e.g. via
an `ssh -R` reverse tunnel from a laptop). Then auth and booking both work and
the session still lives in the box's on-disk profile.

### The recipe that works — TON-13 branches need this exact setup

```
user-data-dir : /root/booking/profile
chromium      : --no-sandbox --disable-gpu
                --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
                --user-data-dir=/root/booking/profile --window-size=1440,900
                --no-first-run --no-default-browser-check
tunnel        : tcp <ingress> -> scripts/cdp-proxy.js :9223 -> 127.0.0.1:9222
```

**Attach, don't launch.** `chromium.connectOverCDP()` onto the browser already running in the
box, then use `browser.contexts()[0]` — the persistent profile's own context. Two failure
modes this avoids:

- `launchPersistentContext()` against a `user-data-dir` while another chromium holds it either
  refuses to start or forks a copy of the profile, and **the login appears to have vanished**.
- `browser.newContext()` is incognito. It carries no cookies, so it passes every local test and
  is logged out on stage — the exact failure this document warned about above.

`browser.close()` on a CDP attachment **disconnects rather than killing the browser** [VERIFIED]
— the box's chromium survived it.

### Reaching CDP from outside the box needs a rewriting proxy, not a port forward

Chrome refuses any DevTools request whose `Host` header is not `localhost` or a bare IP
(anti-DNS-rebinding), and it advertises `webSocketDebuggerUrl` as `ws://127.0.0.1:9222/...`,
which is meaningless outside the box. So socat/`ssh -L` alone will not do.

**The part that will cost you an hour:** Playwright sends `Connection: keep-alive` and reuses
**one TCP connection** for both `GET /json/version` and the WebSocket upgrade that follows. A
proxy that rewrites only the first request head and then splices raw bytes lets the upgrade
through with the original Host, and Chrome answers `500 Host header is specified and is not an
IP address or localhost` — *after* the version probe already succeeded. It reads as a WebSocket
bug and is a header bug. Rewrite **every** head until a `101` is seen, then splice.

**Expose it as `protocol: "tcp"` with an `allowlist`, never as a public HTTP listener.** CDP is
unauthenticated and is arbitrary code execution in a browser holding a real login and a saved
card. Note the allowlist pins one caller IP — re-run the setup script from the machine that
will drive the demo.

### pause() → resume() with a live browser [VERIFIED]

Measured on the box running Xvfb + chromium + the proxy: **12.2s down, 5.0s up**,
`boot_id` **unchanged** (warm — memory restored, not just disk), chromium and the proxy still
running, CDP still answering, and **both ingress listeners survived with identical URLs**
— including the TCP one. A cookie planted before the pause was still present on reconnect
**from a fresh process**.

This extends TON-7's finding to a live browser: the Sail layer is not what will break warm
replay. What remains provider-specific is whether the *site* still accepts the session.

### fork() [VERIFIED]

A forked child **inherits both the running (detached) chromium and the on-disk profile** —
`/root/booking/profile/Default/Cookies` was present in the child and its chromium was already
up, with no relaunch.

### Egress IP is NOT stable — it rotates per connection [VERIFIED]

**Six consecutive `curl https://ifconfig.me` from one running box, no pause, returned four
distinct addresses:** 34.212.113.139, 35.93.154.169, 34.215.198.45, 34.217.94.94. Add
54.202.28.162 and 54.191.8.10 from other samples. All AWS us-west-2 — this is a NAT pool, not
a per-box address.

**This corrects an earlier reading in this document.** A forked child was observed with a
different egress IP from its parent and that was attributed to forking. It is not fork-specific:
the same box gives different IPs between two ordinary requests. Any parent-vs-child IP
comparison is measuring the pool, not the fork.

Two consequences:

- **"Does the child get a different egress IP?" is the wrong question.** If a provider pinned a
  session to an IP, the session would break between two consecutive page loads for *everyone*,
  forked or not. So IP pinning is either not in play or is fatal generally — it is not a
  branch-specific risk.
- **It strengthens the OpenTable finding.** Those 403s arrived across many different source
  addresses, so the block is at range/ASN level, not a reputation score on one address. Nothing
  is gained by retrying to get "a better IP".

Corollary for anything that allowlists by IP: an outbound allowlist keyed to a Sailbox's address
cannot work. (Sail *ingress* allowlists are unaffected — those key on the caller's IP.)

## Still open

Answered above: process survival, fork-vs-checkpoint, N=3 concurrency, create timing,
disk/memory survival across a disconnect (TON-7), and — new — live-browser survival across
pause/resume plus the fork egress-IP question (TON-8).

Remaining. The first two are now narrowed to a **provider** question — no Sail question is left
in them — and both are blocked on a real logged-in session, so they belong with TON-8:

- **[OPEN]** Does a real **provider session** survive `pause()` → `resume()`? *This is the half
  that sits on the critical path* — it's the warm-replay story and the reason for choosing Sail.
  **Fully settled on the Sail side** (TON-7 for disk/memory, TON-8 above for a live browser,
  its processes and its ingress listeners). What is left is only whether the *site* re-accepts
  the session.
- **[OPEN]** Does a **provider session** survive a fork? The mechanics are settled — the child
  inherits the process and the profile (TON-8 above). The egress-IP half of this question is
  **withdrawn**: IPs rotate per connection for every box, so there is no fork-specific address
  change to worry about.
- **[OPEN]** Concurrency ceiling above 3.

Test the first two against the *actual* provider, not a generic site — success means "the provider
still accepts the session", not "the cookie file is present." **And assert on rendered DOM text,
not on `response.status()`** — OpenTable serves its block page as a 200 in some paths.

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
