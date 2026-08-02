"""The seam is safety-critical, so these tests are mostly about refusing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from runbook_voice.booking_bridge import BookingBridgeError, NodeBookingRunner
from runbook_voice.executor import RunbookExecutor
from runbook_voice.runbooks import Runbook

ROOT = Path(__file__).parents[1]
SLOTS = {
    "party_size": 2,
    "cuisine": "Italian",
    "city": "San Francisco",
    "date": "tomorrow",
    "time": "7 pm",
}


def runner(tmp_path, **kwargs):
    kwargs.setdefault("stub", True)
    kwargs.setdefault("store_path", tmp_path / "bookings.json")
    return NodeBookingRunner(**kwargs)


@pytest.mark.asyncio
async def test_search_reaches_the_javascript_modules(tmp_path):
    result = await runner(tmp_path).execute("restaurant.search", SLOTS)
    assert result["query"] == "Italian"


@pytest.mark.asyncio
async def test_book_is_refused_without_upstream_confirmation(tmp_path):
    """The default runner cannot book. Nothing about it is configurable by accident."""
    with pytest.raises(BookingBridgeError, match="irreversible"):
        await runner(tmp_path).execute("restaurant.book", SLOTS)


@pytest.mark.asyncio
async def test_book_succeeds_once_confirmation_is_declared_upstream(tmp_path):
    result = await runner(tmp_path, confirmation_is_upstream=True).execute(
        "restaurant.book", SLOTS
    )
    assert result["confirmation_id"].startswith("STUB-")
    assert result["stub"] is True


@pytest.mark.asyncio
async def test_real_mode_never_silently_degrades_to_stub(tmp_path):
    """Real mode must fail loudly when it cannot reach the box, never fake a booking.

    Asserts the property, not the message: the reason real mode is unavailable
    changes as TON-8 evolves (it has already gone from "no authenticated page"
    to a Sailbox delegation error), but "refuses rather than stubs" must not.
    """
    store = tmp_path / "bookings.json"
    # Short timeout: real mode reaches into the Sailbox, and this suite must not
    # depend on the network or spend 3 minutes proving a refusal. What is being
    # asserted is the refusal itself, not the reason for it.
    live = runner(
        tmp_path, stub=False, store_path=store, confirmation_is_upstream=True, timeout=5
    )
    assert live.stub is False

    with pytest.raises(BookingBridgeError):
        await live.execute("restaurant.book", SLOTS)

    open_bookings = await runner(tmp_path, store_path=store).execute("booking.list_open", {})
    assert open_bookings["open"] == [], "a failed real booking must leave nothing behind"


@pytest.mark.asyncio
async def test_every_verb_the_distiller_can_emit_is_dispatchable(tmp_path):
    """The vocabulary gap that broke TON-21, caught structurally.

    The distiller and the bridge agreed on a schema but not on a VOCABULARY:
    `restaurant.select` was emitted by one and implemented by neither. Schema
    validation cannot catch that — it constrains shape, not dispatchability.

    This walks the distiller's own vocabulary rather than a hardcoded list, so
    adding a verb on either side without the other fails here instead of at
    replay, mid-run, after earlier steps have already executed.
    """
    from runbook_voice.distiller import VOCABULARIES

    bridge = runner(tmp_path, confirmation_is_upstream=True)
    for vocabulary in VOCABULARIES:
        for rule in (vocabulary.find, vocabulary.choose, vocabulary.commit):
            result = await bridge.execute(rule.action, SLOTS)
            assert result is not None, f"{rule.action} dispatched but returned nothing"


@pytest.mark.asyncio
async def test_distilled_runbook_executes_without_special_casing(tmp_path):
    """TON-21's actual exit criterion, asserted end to end.

    Validating against the schema is not enough: the distilled runbook is the
    artifact M3 replays, so it has to survive the real executor.
    """
    document = json.loads((ROOT / "fixtures/runbooks/distilled-branch-0.json").read_text())
    runbook = Runbook.from_dict(document)

    class Gate:
        async def confirm(self, request):
            return True

    slots = {slot.name: (2 if slot.type.value == "integer" else "Italian") for slot in runbook.slots}
    result = await RunbookExecutor(
        runner(tmp_path, confirmation_is_upstream=True), Gate()
    ).execute(runbook, slots)

    failed = [s for s in result.steps if s.error]
    assert result.succeeded, f"synthesized runbook did not replay: {[s.error for s in failed]}"


@pytest.mark.asyncio
async def test_unknown_provider_fails_in_STUB_mode_too(tmp_path):
    """The whole point of rehearsing in stub mode is that it fails for real reasons.

    A runbook naming a provider that does not exist must not sail through every
    rehearsal and then throw on stage at the irreversible step.
    """
    with pytest.raises(BookingBridgeError, match="Unknown booking provider"):
        await runner(tmp_path, confirmation_is_upstream=True).execute(
            "restaurant.book", {**SLOTS, "provider": "configured-provider"}
        )


@pytest.mark.asyncio
async def test_unknown_action_is_an_error_not_a_silent_success(tmp_path):
    with pytest.raises(BookingBridgeError, match="unknown action"):
        await runner(tmp_path).execute("restaurant.teleport", SLOTS)


@pytest.mark.asyncio
async def test_missing_search_term_refuses_rather_than_searching_for_nothing(tmp_path):
    with pytest.raises(BookingBridgeError, match="search term"):
        await runner(tmp_path).execute("restaurant.search", {"city": "SF"})


@pytest.mark.asyncio
async def test_missing_node_binary_is_reported_clearly(tmp_path):
    with pytest.raises(BookingBridgeError, match="not found"):
        await runner(tmp_path, node="definitely-not-node").execute(
            "restaurant.search", SLOTS
        )


@pytest.mark.asyncio
async def test_full_warm_path_through_the_real_executor(tmp_path):
    """The point of the bridge: a runbook executes end to end with no fakes.

    Confirmation still runs - the gate here stands in for the voice, and it is
    the only thing that authorises the irreversible step.
    """
    document = json.loads((ROOT / "demo/handwritten_runbook.json").read_text())
    runbook = Runbook.from_dict(document)

    spoken: list[str] = []

    class Gate:
        async def confirm(self, request):
            spoken.append(request.prompt)
            return True

    executor = RunbookExecutor(
        runner(tmp_path, confirmation_is_upstream=True), Gate()
    )
    result = await executor.execute(runbook, SLOTS)

    assert result.succeeded
    assert [step.action for step in result.steps] == [
        "restaurant.search",
        "restaurant.book",
    ]
    assert result.steps[-1].output["confirmation_id"].startswith("STUB-")
    # The readback names specifics rather than "shall I proceed?".
    assert "Italian" in spoken[0] and "San Francisco" in spoken[0]


@pytest.mark.asyncio
async def test_declining_the_spoken_gate_books_nothing(tmp_path):
    document = json.loads((ROOT / "demo/handwritten_runbook.json").read_text())

    class RefusingGate:
        async def confirm(self, request):
            return False

    store = tmp_path / "bookings.json"
    executor = RunbookExecutor(
        runner(tmp_path, store_path=store, confirmation_is_upstream=True),
        RefusingGate(),
    )
    result = await executor.execute(Runbook.from_dict(document), SLOTS)

    assert not result.succeeded
    assert [step.action for step in result.steps] == [
        "restaurant.search",
        "restaurant.book",
    ]
    assert result.steps[-1].status.value == "confirmation_rejected"
    open_bookings = await runner(tmp_path, store_path=store).execute(
        "booking.list_open", {}
    )
    assert open_bookings["open"] == []
