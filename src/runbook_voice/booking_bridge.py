"""The Track A <-> Track C seam: dispatch runbook steps to the JS booking modules.

``RunbookExecutor`` drives steps through ``PersistentSailboxRunner.execute``.
Every implementation of that protocol until now has been a test fake, so
``restaurant.book`` resolved to nothing and the warm path could not run end to
end. ``NodeBookingRunner`` is the production implementation.

One subprocess per step, talking JSON over stdin/stdout to
``scripts/booking_bridge.mjs``. A subprocess rather than a long-lived server
because a step is infrequent and slow (a human is speaking between them), and a
server would add a lifecycle to own and a port to collide on for no gain.

Confirmation: ``RunbookExecutor`` gates irreversible steps *before* dispatching
them, so by the time this runner is called for ``restaurant.book`` the spoken
confirmation has already succeeded. The bridge still refuses to book unless
told so explicitly, so that fact must be asserted at construction with
``confirmation_is_upstream=True``. It defaults to False: a runner built without
thinking about it cannot book.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

_BRIDGE = Path(__file__).resolve().parents[2] / "scripts" / "booking_bridge.mjs"
_IRREVERSIBLE = frozenset({"restaurant.book"})


class BookingBridgeError(RuntimeError):
    """The bridge refused, failed, or returned something unusable.

    Raised rather than returned so ``RunbookExecutor`` records it as a failed
    step and stops - a booking action that half-worked must never look like
    success to the voice layer.
    """


class NodeBookingRunner:
    """Dispatch runbook actions to the JavaScript booking modules."""

    def __init__(
        self,
        *,
        stub: bool = False,
        confirmation_is_upstream: bool = False,
        store_path: str | os.PathLike[str] | None = None,
        node: str = "node",
        script: str | os.PathLike[str] | None = None,
        timeout: float = 180.0,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._node = node
        self._script = Path(script) if script else _BRIDGE
        self._timeout = timeout
        self._confirmation_is_upstream = confirmation_is_upstream

        base = dict(env if env is not None else os.environ)
        if stub:
            base["BOOKING_STUB_MODE"] = "1"
        else:
            # Never inherit a stray stub flag into what is meant to be a real
            # run: a stub booking mistaken for a real one is the single most
            # damaging failure this component has.
            base.pop("BOOKING_STUB_MODE", None)
        if store_path is not None:
            base["BOOKING_STORE_PATH"] = str(store_path)
        self._env = base

    @property
    def stub(self) -> bool:
        return self._env.get("BOOKING_STUB_MODE") in {"1", "true"}

    async def execute(self, action: str, arguments: Mapping[str, Any]) -> Any:
        """Run one runbook step. Signature matches PersistentSailboxRunner."""
        request = {
            "action": action,
            "arguments": dict(arguments),
            # Only ever true for steps the executor already gated by voice.
            "confirmed": action in _IRREVERSIBLE and self._confirmation_is_upstream,
        }

        try:
            process = await asyncio.create_subprocess_exec(
                self._node,
                str(self._script),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._env,
            )
        except FileNotFoundError as exc:
            raise BookingBridgeError(
                f"cannot launch the booking bridge: {self._node!r} not found"
            ) from exc

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps(request).encode()), self._timeout
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            raise BookingBridgeError(
                f"booking bridge timed out after {self._timeout}s on {action!r}"
            ) from None

        return self._parse(action, stdout, stderr)

    def _parse(self, action: str, stdout: bytes, stderr: bytes) -> Any:
        text = stdout.decode().strip()
        if not text:
            detail = stderr.decode().strip() or "no output"
            raise BookingBridgeError(f"booking bridge produced no response: {detail}")

        try:
            payload = json.loads(text.splitlines()[-1])
        except json.JSONDecodeError as exc:
            raise BookingBridgeError(
                f"booking bridge returned non-JSON: {text[:200]}"
            ) from exc

        if not payload.get("ok"):
            raise BookingBridgeError(
                f"{action}: {payload.get('error', 'unknown bridge error')}"
            )
        return payload.get("result")
