#!/usr/bin/env python3
"""TON-7: boot -> command -> disconnect -> reconnect -> state intact.

    python demo.py              full cycle (default)
    python demo.py boot         create a box, leave it asleep, print its id
    python demo.py check <id>   reconnect to a box and verify its state
    python demo.py kill <id>    terminate a box

`boot` and `check` run as separate OS processes, so the disconnect is real: a
fresh interpreter, a fresh SDK client, nothing carried across but the id string.
A handle going out of scope inside one process would prove nothing.

They also stand alone, so the same box can be re-checked hours later — which is
the pattern TON-8's auth and TON-13's branches actually depend on.
"""

import json
import pathlib
import secrets
import statistics
import subprocess
import sys
import time

import sail

import spine

DIR = "/root/spine"
MARKER = f"{DIR}/marker.txt"  # written through the control plane
SHELL_MARKER = f"{DIR}/shell-marker.txt"  # written by a shell inside the box

# What boot saw, so check can hold it to account. Not config — the demo's own
# notes, so `check <id>` is just as strict when run by hand days later.
STATE = pathlib.Path(__file__).parent / ".spine-last.json"

failures = []


def verify(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'   ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def timing(label, seconds, note=""):
    print(f"  {label:<22} {seconds * 1000:7.0f} ms {note}")


def cmd_boot():
    token = secrets.token_hex(8)
    sb, cold = spine.boot(f"spine-{token[:6]}")
    print(f"booted {sb.sailbox_id}  (name {sb.name}, size {spine.SIZE})")
    timing("cold start", cold)

    # boot_id is per-boot, not per-box, so it can't prove identity — but comparing
    # it after the resume says whether the box came back warm (memory restored) or
    # cold (rebooted, disk intact), which is the caveat the docs warn about.
    boot_id = sb.run("cat /proc/sys/kernel/random/boot_id", check=True).stdout.strip()

    # A control-plane fact, independent of anything we write to disk. The base
    # image has no machine-id and reports hostname `(none)`, so this is the one
    # identity signal the box itself can't fake. create() returns a bare handle —
    # snapshot fields like created_at only come back from get().
    created_at = str(sail.Sailbox.get(sb.sailbox_id).created_at)

    # Two write paths, because they can fail independently: the control plane,
    # and a shell running inside the box. Downstream, the writes that matter are
    # the agent's own — so proving only fs.write survives would prove the wrong
    # half. /root over /tmp: tmp semantics across a cold resume are undocumented.
    sb.fs.write(MARKER, token)
    sb.run(f"mkdir -p {DIR} && printf %s {token} > {SHELL_MARKER}", check=True)

    round_trips = []
    for _ in range(5):
        t0 = time.perf_counter()
        sb.run("true", check=True)
        round_trips.append(time.perf_counter() - t0)
    timing("command round-trip", statistics.median(round_trips), "(median of 5)")

    t0 = time.perf_counter()
    sb.sleep()  # checkpoints on the way down; free to park here
    timing("sleep", time.perf_counter() - t0)

    STATE.write_text(
        json.dumps(
            {
                "sailbox_id": sb.sailbox_id,
                "token": token,
                "boot_id": boot_id,
                "created_at": created_at,
            }
        )
    )
    print(f"\nSAILBOX_ID={sb.sailbox_id}")
    return 0


def cmd_check(sailbox_id):
    sb, reconnect, prior = spine.connect(sailbox_id)
    print(f"reconnected to {sb.sailbox_id}  (found it {prior})")
    timing("reconnect", reconnect, f"({'woke it' if prior != 'running' else 'already running'})")

    expected = None
    if STATE.exists():
        recorded = json.loads(STATE.read_text())
        if recorded["sailbox_id"] == sailbox_id:
            expected = recorded

    boot_id = sb.run("cat /proc/sys/kernel/random/boot_id", check=True).stdout.strip()
    marker = sb.fs.read(MARKER).decode().strip()
    shell_marker = sb.run(f"cat {SHELL_MARKER}", check=True).stdout.strip()

    print("\nstate:")
    if expected:
        # The load-bearing one. Without it "reconnect" could quietly be a brand
        # new box and every other check below would still pass.
        verify(
            "same box — created_at unchanged",
            str(sb.created_at) == expected["created_at"],
            expected["created_at"],
        )
        verify("control-plane write survived", marker == expected["token"], marker)
        verify("in-box shell write survived", shell_marker == expected["token"], shell_marker)
        warm = boot_id == expected["boot_id"]
        print(f"  note  came back {'warm — same boot, memory restored' if warm else 'cold — rebooted, disk intact'}")
    else:
        print("  note  no boot record for this id — can't check identity")
        verify("both markers present and agree", marker == shell_marker and bool(marker), marker)

    print("\ncommand plumbing:")
    result = sb.run("echo out; echo err >&2; exit 7")
    verify("exit code", result.exit_code == 7, f"got {result.exit_code}")
    verify("stdout", result.stdout.strip() == "out", repr(result.stdout))
    verify("stderr", result.stderr.strip() == "err", repr(result.stderr))

    if failures:
        print(f"\nFAILED: {', '.join(failures)}")
        return 1

    # Park it rather than leave it billing. Sleeping costs nothing and keeps the
    # state — which is the whole point of what we just proved.
    sb.sleep()
    print("\nOK — box parked asleep at $0, state intact.")
    print(f"     python demo.py check {sailbox_id}   # verify again, any time")
    print(f"     python demo.py kill  {sailbox_id}   # remove it")
    return 0


def cmd_kill(sailbox_id):
    t0 = time.perf_counter()
    spine.connect(sailbox_id)[0].terminate()
    timing("terminate", time.perf_counter() - t0)
    return 0


def cmd_all():
    # flush: our stdout is buffered but the child writes straight to the terminal,
    # so without this the headers land after the output they introduce.
    print("=== phase 1: boot, write state, disconnect ===", flush=True)
    if subprocess.run([sys.executable, __file__, "boot"]).returncode != 0:
        return 1
    sailbox_id = json.loads(STATE.read_text())["sailbox_id"]

    print("\n=== phase 2: fresh process, nothing but the id ===", flush=True)
    return subprocess.run([sys.executable, __file__, "check", sailbox_id]).returncode


if __name__ == "__main__":
    argv = sys.argv[1:] or ["all"]
    command, args = argv[0], argv[1:]
    if command in ("check", "kill") and not args:
        sys.exit(f"usage: python demo.py {command} <sailbox_id>")
    handler = {"all": cmd_all, "boot": cmd_boot, "check": cmd_check, "kill": cmd_kill}.get(command)
    if not handler:
        sys.exit(__doc__)
    sys.exit(handler(*args))
