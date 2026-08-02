"""Console proof that Sailbox state survives a full disconnect (TON-7).

``boot`` and ``check`` run as separate OS processes, so the disconnect is real:
a fresh interpreter, a fresh SDK client, nothing carried across but the id
string.  A handle going out of scope inside one process would prove nothing.

They also stand alone, so the same box can be re-checked hours later — the
pattern in-box auth and branch searches both depend on.
"""

from __future__ import annotations

import argparse
import json
import secrets
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence

from .sailbox import DEFAULT_SIZE, boot, connect

PROOF_DIR = "/root/spine"
MARKER = f"{PROOF_DIR}/marker.txt"  # written through the control plane
SHELL_MARKER = f"{PROOF_DIR}/shell-marker.txt"  # written by a shell inside the box

# What boot saw, so check can hold it to account.  Not config — the demo's own
# notes, so `check <id>` is just as strict when run by hand days later.
STATE_FILENAME = ".sailbox-demo.json"

_MODULE = "runbook_voice.sailbox_demo"


def state_path() -> Path:
    return Path.cwd() / STATE_FILENAME


def _timing(label: str, seconds: float, note: str = "") -> None:
    print(f"  {label:<22} {seconds * 1000:7.0f} ms {note}")


def _verify(failures: list[str], label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'   ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def cmd_boot() -> int:
    token = secrets.token_hex(8)
    handle = boot(f"spine-{token[:6]}")
    box = handle.box
    print(f"booted {handle.sailbox_id}  (name {box.name}, size {DEFAULT_SIZE})")
    _timing("cold start", handle.elapsed_seconds)

    # boot_id is per-boot, not per-box, so it cannot prove identity — but
    # comparing it after the resume says whether the box came back warm (memory
    # restored) or cold (rebooted, disk intact), the caveat the docs warn about.
    boot_id = box.run("cat /proc/sys/kernel/random/boot_id", check=True).stdout.strip()

    # A control-plane fact, independent of anything written to disk.  The base
    # image has no machine-id and reports hostname `(none)`, so this is the one
    # identity signal the box itself cannot fake.  create() returns a bare
    # handle — snapshot fields like created_at only come back from get().
    created_at = str(connect(handle.sailbox_id).box.created_at)

    # Two write paths, because they fail independently: the control plane, and a
    # shell running inside the box.  Downstream the writes that matter are the
    # agent's own, so proving only fs.write survives would prove the wrong half.
    # /root over /tmp: tmp semantics across a cold resume are undocumented.
    box.fs.write(MARKER, token)
    box.run(f"mkdir -p {PROOF_DIR} && printf %s {token} > {SHELL_MARKER}", check=True)

    round_trips = []
    for _ in range(5):
        started = time.perf_counter()
        box.run("true", check=True)
        round_trips.append(time.perf_counter() - started)
    _timing("command round-trip", statistics.median(round_trips), "(median of 5)")

    started = time.perf_counter()
    box.sleep()  # checkpoints on the way down; free to park here
    _timing("sleep", time.perf_counter() - started)

    state_path().write_text(
        json.dumps(
            {
                "sailbox_id": handle.sailbox_id,
                "token": token,
                "boot_id": boot_id,
                "created_at": created_at,
            }
        )
    )
    print(f"\nSAILBOX_ID={handle.sailbox_id}")
    return 0


def cmd_check(sailbox_id: str) -> int:
    handle = connect(sailbox_id)
    box = handle.box
    print(f"reconnected to {handle.sailbox_id}  (found it {handle.prior_status})")
    _timing(
        "reconnect",
        handle.elapsed_seconds,
        "(woke it)" if handle.prior_status != "running" else "(already running)",
    )

    expected = _recorded_boot(sailbox_id)
    boot_id = box.run("cat /proc/sys/kernel/random/boot_id", check=True).stdout.strip()
    marker = box.fs.read(MARKER).decode().strip()
    shell_marker = box.run(f"cat {SHELL_MARKER}", check=True).stdout.strip()

    failures: list[str] = []
    print("\nstate:")
    if expected:
        # The load-bearing one.  Without it a "reconnect" could quietly be a
        # brand-new box and every other check below would still pass.
        _verify(
            failures,
            "same box — created_at unchanged",
            str(box.created_at) == expected["created_at"],
            expected["created_at"],
        )
        _verify(failures, "control-plane write survived", marker == expected["token"], marker)
        _verify(
            failures, "in-box shell write survived", shell_marker == expected["token"], shell_marker
        )
        warm = boot_id == expected["boot_id"]
        print(
            "  note  came back "
            + ("warm — same boot, memory restored" if warm else "cold — rebooted, disk intact")
        )
    else:
        print("  note  no boot record for this id — can't check identity")
        _verify(
            failures,
            "both markers present and agree",
            marker == shell_marker and bool(marker),
            marker,
        )

    print("\ncommand plumbing:")
    result = box.run("echo out; echo err >&2; exit 7")
    _verify(failures, "exit code", result.exit_code == 7, f"got {result.exit_code}")
    _verify(failures, "stdout", result.stdout.strip() == "out", repr(result.stdout))
    _verify(failures, "stderr", result.stderr.strip() == "err", repr(result.stderr))

    if failures:
        print(f"\nFAILED: {', '.join(failures)}")
        return 1

    # Park it rather than leave it billing.  Sleeping costs nothing and keeps
    # the state — which is the whole point of what was just proved.
    box.sleep()
    print("\nOK — box parked asleep at $0, state intact.")
    print(f"     python -m {_MODULE} check {sailbox_id}   # verify again, any time")
    print(f"     python -m {_MODULE} kill  {sailbox_id}   # remove it")
    return 0


def cmd_kill(sailbox_id: str) -> int:
    started = time.perf_counter()
    connect(sailbox_id).box.terminate()
    _timing("terminate", time.perf_counter() - started)
    return 0


def cmd_all() -> int:
    # flush: our stdout is buffered but the child writes straight to the
    # terminal, so without this the headers land after the output they announce.
    print("=== phase 1: boot, write state, disconnect ===", flush=True)
    if subprocess.run([sys.executable, "-m", _MODULE, "boot"]).returncode != 0:
        return 1
    sailbox_id = json.loads(state_path().read_text())["sailbox_id"]

    print("\n=== phase 2: fresh process, nothing but the id ===", flush=True)
    return subprocess.run([sys.executable, "-m", _MODULE, "check", sailbox_id]).returncode


def _recorded_boot(sailbox_id: str) -> dict[str, Any] | None:
    path = state_path()
    if not path.exists():
        return None
    recorded = json.loads(path.read_text())
    return recorded if recorded.get("sailbox_id") == sailbox_id else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prove Sailbox state survives boot -> command -> disconnect -> reconnect."
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("all", help="full cycle across two processes (default)")
    sub.add_parser("boot", help="create a box, leave it asleep, print its id")
    for name, help_text in (("check", "reconnect and verify state"), ("kill", "terminate a box")):
        child = sub.add_parser(name, help=help_text)
        child.add_argument("sailbox_id")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    command = args.command or "all"
    try:
        if command == "all":
            return cmd_all()
        if command == "boot":
            return cmd_boot()
        if command == "check":
            return cmd_check(args.sailbox_id)
        return cmd_kill(args.sailbox_id)
    except Exception as exc:  # a failed demo should report, not traceback
        print(f"sailbox demo failed: {type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
