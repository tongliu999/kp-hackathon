from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from runbook_voice.sailbox import (
    DEFAULT_APP,
    DEFAULT_SIZE,
    BoxHandle,
    SailboxError,
    boot,
    connect,
)


class FakeBox:
    def __init__(self, sailbox_id: str = "sb_test", status: str = "running") -> None:
        self.sailbox_id = sailbox_id
        self.status = status
        self.resumed = 0

    def resume(self) -> FakeBox:
        self.resumed += 1
        resumed = FakeBox(self.sailbox_id, "running")
        resumed.resumed = self.resumed
        return resumed


class FakeSail:
    """Stands in for the `sail` module, which tests never talk to for real."""

    def __init__(self, box: FakeBox | None = None) -> None:
        self.box = box or FakeBox()
        self.created: dict[str, Any] = {}
        self.found_app: dict[str, Any] = {}
        sail = self

        class App:
            @staticmethod
            def find(*, name: str, mint_if_missing: bool = False) -> str:
                sail.found_app = {"name": name, "mint_if_missing": mint_if_missing}
                return f"app::{name}"

        class Sailbox:
            @staticmethod
            def create(*, app: Any, name: str, size: str) -> FakeBox:
                sail.created = {"app": app, "name": name, "size": size}
                return sail.box

            @staticmethod
            def get(sailbox_id: str) -> FakeBox:
                return sail.box

        self.App = App
        self.Sailbox = Sailbox


@pytest.fixture
def fake_sail(monkeypatch: pytest.MonkeyPatch):
    def install(box: FakeBox | None = None) -> FakeSail:
        sail = FakeSail(box)
        monkeypatch.setitem(sys.modules, "sail", sail)
        return sail

    return install


def test_boot_namespaces_by_app_and_reports_elapsed(fake_sail) -> None:
    sail = fake_sail()

    handle = boot("worker-1")

    assert sail.found_app == {"name": DEFAULT_APP, "mint_if_missing": True}
    assert sail.created == {"app": f"app::{DEFAULT_APP}", "name": "worker-1", "size": DEFAULT_SIZE}
    assert handle.elapsed_seconds >= 0
    # A fresh boot has no prior state to have been found in.
    assert handle.prior_status is None


def test_boot_accepts_an_explicit_app_so_branches_do_not_collide(fake_sail) -> None:
    sail = fake_sail()

    boot("child-0", app="branch-search", size="m")

    assert sail.found_app["name"] == "branch-search"
    assert sail.created["app"] == "app::branch-search"
    assert sail.created["size"] == "m"


def test_connect_to_a_running_box_does_not_resume_it(fake_sail) -> None:
    sail = fake_sail(FakeBox(status="running"))

    handle = connect("sb_test")

    assert handle.prior_status == "running"
    assert sail.box.resumed == 0


@pytest.mark.parametrize("status", ["sleeping", "paused"])
def test_connect_wakes_a_parked_box(fake_sail, status: str) -> None:
    sail = fake_sail(FakeBox(status=status))

    handle = connect("sb_test")

    # prior_status is what makes the elapsed time interpretable: waking a parked
    # box and reattaching to a live one are different measurements.
    assert handle.prior_status == status
    assert sail.box.resumed == 1
    assert handle.box.status == "running"


@pytest.mark.parametrize("status", ["terminated", "failed"])
def test_connect_refuses_a_dead_box_instead_of_resuming(fake_sail, status: str) -> None:
    sail = fake_sail(FakeBox(status=status))

    with pytest.raises(SailboxError, match=status):
        connect("sb_test")

    assert sail.box.resumed == 0


def test_missing_sdk_reports_how_to_install_it(monkeypatch: pytest.MonkeyPatch) -> None:
    # Importing the package must not require the optional Sail SDK, so the
    # failure has to surface at call time with an actionable message.
    monkeypatch.setitem(sys.modules, "sail", None)
    monkeypatch.delitem(sys.modules, "sail")

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __import__

    def blocked(name: str, *args: Any, **kwargs: Any):
        if name == "sail":
            raise ImportError("no module named sail")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", blocked)

    with pytest.raises(SailboxError, match=r"\[sailbox\]"):
        boot("worker-1")


def test_box_handle_exposes_the_id_of_the_box_it_wraps() -> None:
    handle = BoxHandle(FakeBox("sb_abc"), 0.5)

    assert handle.sailbox_id == "sb_abc"


def test_package_imports_without_the_sail_sdk() -> None:
    # The lazy import is the point: `import runbook_voice` is used by every
    # other module and must not drag in an optional dependency.
    module = types.ModuleType("probe")
    exec("import runbook_voice; result = runbook_voice.boot", module.__dict__)

    assert callable(module.__dict__["result"])
