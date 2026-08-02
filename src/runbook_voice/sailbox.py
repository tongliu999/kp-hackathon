"""Sailbox lifecycle: boot a box, or reconnect to one that already exists.

``PersistentSailboxRunner`` in :mod:`.executor` deliberately owns no lifecycle —
replay must never be able to create a box between steps.  Ownership lives here
instead, which is the other half of that split.

Two functions, and callers use the returned SDK handle directly for ``run()``
and ``fs`` rather than going through a wrapper.  The Sail SDK is an optional
dependency, imported lazily, so importing this package never requires it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

DEFAULT_APP = "spine"
DEFAULT_SIZE = "s"

# Sailbox states that no longer refer to a usable machine.
_DEAD_STATES = frozenset({"terminated", "failed"})


class SailboxError(RuntimeError):
    """A Sailbox could not be booted or reconnected to."""


@dataclass(frozen=True, slots=True)
class BoxHandle:
    """A live Sailbox plus how long it took to get there.

    ``prior_status`` is the state the box was found in, or ``None`` for a fresh
    boot.  It is what makes ``elapsed_seconds`` interpretable: reconnecting to a
    running box and waking a sleeping one are different measurements.
    """

    box: Any
    elapsed_seconds: float
    prior_status: str | None = None

    @property
    def sailbox_id(self) -> str:
        return self.box.sailbox_id


def boot(
    name: str, *, app: str = DEFAULT_APP, size: str = DEFAULT_SIZE
) -> BoxHandle:
    """Create a fresh Sailbox and time the cold start.

    Boxes are namespaced by ``app`` so concurrent sessions cannot terminate each
    other's work — branch searches should pass their own app rather than sharing
    the default.
    """
    sail = _sail()
    started = time.perf_counter()
    application = sail.App.find(name=app, mint_if_missing=True)
    box = sail.Sailbox.create(app=application, name=name, size=size)
    return BoxHandle(box, time.perf_counter() - started)


def connect(sailbox_id: str) -> BoxHandle:
    """Bind to an existing Sailbox, waking it if needed.

    ``get`` validates the id and returns a fresh snapshot but never wakes
    anything, so a paused or sleeping box needs an explicit resume — which is
    also the number worth measuring.  Letting the first command wake it
    implicitly would hide the wake cost inside that command.
    """
    sail = _sail()
    started = time.perf_counter()
    box = sail.Sailbox.get(sailbox_id)
    prior = box.status
    if prior in _DEAD_STATES:
        raise SailboxError(f"sailbox {sailbox_id} is {prior}; nothing to reconnect to")
    if prior != "running":
        box = box.resume()
    return BoxHandle(box, time.perf_counter() - started, prior)


def _sail():
    try:
        import sail
    except ImportError as exc:
        raise SailboxError(
            "Sailbox support is not installed; run `pip install -e '.[sailbox]'`"
        ) from exc
    return sail
