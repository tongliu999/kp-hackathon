from __future__ import annotations

import json
from pathlib import Path
import re


ROOT = Path(__file__).parents[1]
CONFIG_PATH = ROOT / "demo" / "demo_config.json"
RUN_OF_SHOW_PATH = ROOT / "docs" / "demo-run-of-show.md"

_WORD_RE = re.compile(r"[a-z0-9]+")
_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "can",
        "could",
        "for",
        "i",
        "is",
        "it",
        "me",
        "my",
        "of",
        "on",
        "please",
        "some",
        "the",
        "to",
        "want",
        "would",
        "you",
    }
)
_ALIASES = {
    term: "schedule"
    for term in (
        "schedule",
        "arrange",
        "book",
        "booked",
        "booking",
        "reserve",
        "reserved",
        "reservation",
        "reservations",
    )
}
_ALIASES.update(
    {
        term: "restaurant"
        for term in ("restaurant", "dinner", "dining", "meal", "restaurants", "table")
    }
)


def matcher_tokens(text: str) -> frozenset[str]:
    """Mirror the deterministic matcher contract until TON-15 is merged."""
    return frozenset(
        _ALIASES.get(word, word)
        for word in _WORD_RE.findall(text.casefold())
        if word not in _STOP_WORDS
    )


def load_config() -> dict[str, object]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def test_documented_request_is_exactly_the_machine_readable_fixture() -> None:
    config = load_config()
    run_of_show = RUN_OF_SHOW_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"Exact spoken request \(use verbatim in both runs\):\s*"
        r"```text\s*\n(?P<request>[^\n]+)\n```",
        run_of_show,
    )

    assert match is not None
    assert match.group("request") == config["exact_spoken_request"]


def test_fixture_locks_matcher_normalization_and_warm_match_text() -> None:
    config = load_config()
    request = str(config["exact_spoken_request"])
    warm_match_text = str(config["warm_runbook_match_text"])
    expected = frozenset(config["normalized_match_tokens"])

    assert matcher_tokens(request) == expected
    assert matcher_tokens(warm_match_text) == expected


def test_ton15_matcher_accepts_exact_request_when_available() -> None:
    """Exercise the production matcher after TON-15 lands on the shared branch."""
    try:
        from runbook_voice.runbook_store import DeterministicSemanticMatcher
    except ModuleNotFoundError:
        return

    config = load_config()
    candidate = {
        "id": config["expected_intent"],
        "name": config["warm_runbook_match_text"],
    }

    assert DeterministicSemanticMatcher().match(
        str(config["exact_spoken_request"]), [candidate]
    ) is candidate


def test_run_of_show_contains_every_required_stage_contract() -> None:
    run_of_show = RUN_OF_SHOW_PATH.read_text(encoding="utf-8")
    collapsed = " ".join(run_of_show.split())

    required_phrases = (
        "Why it matters:",
        "Shyam — host and requester",
        "Tong — sole laptop driver",
        "Talia — system and safety explainer",
        "## Three-minute cue sheet",
        "## Pairwise judging: 30-second script",
        "## Failure and stub pivots",
        "## Rehearsal checklist",
        "it is not proof that the path",
        "globally best or always reliable",
    )
    for phrase in required_phrases:
        assert phrase in collapsed

    # Cold recording must precede the live warm-path request in the timed table.
    assert run_of_show.index("Play the cold video") < run_of_show.index(
        "Repeat the exact request verbatim"
    )
