"""Sailbox spine — boot a box, reconnect to it later. TON-7.

Two functions. Everything else is called directly on the SDK handle at the call
site: sb.run(...), sb.fs.write(...), sb.sleep(), sb.terminate(). Wrapping those
would add a layer without adding anything.
"""

import time

import sail

APP = "spine"  # namespace, so this session can't clobber `branch-research` boxes
SIZE = "s"  # 1 vCPU / 16 GiB — the spine needs nothing more


def boot(name):
    """Create a fresh Sailbox. Returns (sailbox, cold_start_seconds)."""
    t0 = time.perf_counter()
    app = sail.App.find(name=APP, mint_if_missing=True)
    sb = sail.Sailbox.create(app=app, name=name, size=SIZE)
    return sb, time.perf_counter() - t0


def connect(sailbox_id):
    """Bind to an existing Sailbox, waking it if needed.

    Returns (sailbox, seconds_to_usable, prior_status). `get` validates the id
    and returns a fresh snapshot but never wakes anything, so a paused or
    sleeping box needs an explicit resume — which is also the number we want to
    measure. Waiting for the first command to wake it implicitly would hide the
    wake cost inside that command.
    """
    t0 = time.perf_counter()
    sb = sail.Sailbox.get(sailbox_id)
    prior = sb.status
    if prior in ("terminated", "failed"):
        raise RuntimeError(f"sailbox {sailbox_id} is {prior} — nothing to reconnect to")
    if prior != "running":
        sb = sb.resume()
    return sb, time.perf_counter() - t0, prior
