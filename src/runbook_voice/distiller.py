"""Distil a winning trajectory into a replayable M0 runbook.

The cold path solves an unfamiliar task once and emits a trajectory of raw
mechanics: browser fills against ``[data-test='...']`` selectors, carrying the
concrete values of one specific request.  Replaying that verbatim would be
theatre -- it books a table for two on Friday at seven forever, and it breaks
the first time the provider ships a redesign.

So distillation is a generalization, and it moves along two axes at once:

* mechanics become **abstract verbs** (``restaurant.book``, never a click on a
  selector), so the document survives a provider redesign;
* request values become **declared slots**, so the next caller can supply
  different ones.

Domain knowledge lives in :class:`TaskVocabulary` -- a data table naming the
verbs of one task family and how to recognise its slot values.  The pipeline
below is generic over that table: it decides which steps survive, which slots
are actually evidenced, and refuses trajectories it cannot honestly generalize.
Teaching the distiller a new domain means adding a vocabulary, not a branch.

Every ``{{ref}}`` this module emits resolves to a slot it also declares.  That
is not stylistic: the executor resolves slots lazily, step by step, so an
undeclared reference raises ``SlotResolutionError`` mid-replay -- after earlier
steps have already run.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "DistillationError",
    "SlotRule",
    "TaskVocabulary",
    "VerbRule",
    "distill",
]


class DistillationError(ValueError):
    """Raised when a trajectory cannot honestly become a runbook.

    Refusing is a real outcome, not a failure to try harder.  A trajectory that
    reached its goal by hard-coding one restaurant name generalizes to nothing,
    and emitting a runbook that pretends otherwise is worse than emitting none.
    """


_TEMPLATE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

_CARDINALS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}
_CARDINAL_WORDS = "|".join(_CARDINALS)

# Values a runbook must never carry: they belong to the box's session or to the
# provider's current DOM, not to the task.
_MECHANISM_MARKERS = ("data-test", "http://", "https://", "://", "selector")


def _cardinal(text: str) -> int | None:
    """Read '2' or 'two' as 2.  The request speaks words; the form takes digits."""
    stripped = text.strip().casefold()
    if stripped.isdigit():
        return int(stripped)
    return _CARDINALS.get(stripped)


def _hour12(text: str) -> int | None:
    """Reduce 'seven' and '7:00 PM' to the same comparable hour.

    Only the hour is compared.  The request says "at seven"; the provider
    normalizes to "7:00 PM".  Matching on the hour is what links the two without
    the distiller having to guess a meridiem it was never told.
    """
    stripped = text.strip().casefold()
    word = _CARDINALS.get(stripped)
    if word is not None:
        return word % 12
    digits = re.match(r"(\d{1,2})", stripped)
    if digits is None:
        return None
    return int(digits.group(1)) % 12


def _fold(text: str) -> str:
    return text.strip().casefold()


@dataclass(frozen=True, slots=True)
class SlotRule:
    """How to recognise one request value, and what to call it once lifted.

    Two patterns, deliberately: ``request`` finds the value as the user spoke it
    ("two", "seven"), ``observed`` finds it as the provider normalized it ("2",
    "7:00 PM").  A slot is lifted only when both fire and ``key`` agrees they are
    the same value -- so a value the request never mentioned cannot become a
    slot, and a slot the run never exercised cannot be invented.
    """

    name: str
    type: str
    prompt: str
    description: str
    readback: str
    request: re.Pattern[str]
    observed: re.Pattern[str]
    key: Callable[[str], object]

    def spoken(self, task: str) -> str | None:
        found = self.request.search(task)
        return found.group(1) if found else None

    def normalized(self, value: str) -> str | None:
        found = self.observed.search(value)
        return found.group(1) if found else None


@dataclass(frozen=True, slots=True)
class VerbRule:
    """One abstract verb, and which raw mechanics collapse into it."""

    step_id: str
    action: str
    description: str
    mechanics: frozenset[str]


@dataclass(frozen=True, slots=True)
class TaskVocabulary:
    """The verbs and slot values of one task family.

    The three verbs are the shape of every booking-like task -- find candidates,
    choose one, commit -- not a restaurant special case.  ``commit`` is the
    irreversible one, and it is always synthesized rather than observed: the
    branching search is forbidden from running irreversible actions, so no
    winning trajectory can ever contain it.
    """

    runbook_id: str
    runbook_name: str
    description: str
    domain: re.Pattern[str]
    slots: tuple[SlotRule, ...]
    find: VerbRule
    choose: VerbRule
    commit: VerbRule
    navigation: frozenset[str]

    def claims(self, task: str) -> bool:
        return self.domain.search(task) is not None


RESTAURANT = TaskVocabulary(
    runbook_id="restaurant-reservation",
    runbook_name="Book a restaurant table",
    # Kept short on purpose.  The store's matcher scores token coverage against
    # min(len(query), len(candidate)), so every extra word here dilutes the
    # score of a real request.  The verbose phrasing in the hand-written fixture
    # scores 0.32 against its own task and falls under the 0.48 threshold.
    description="Book a restaurant table for dinner",
    domain=re.compile(r"\b(table|restaurant|dinner|reservation)\b", re.I),
    slots=(
        SlotRule(
            name="party_size",
            type="integer",
            prompt="How many people?",
            description="the number of people dining",
            readback="Table for {{party_size}}",
            request=re.compile(rf"\bfor\s+(\d+|{_CARDINAL_WORDS})\b", re.I),
            observed=re.compile(r"^\s*(\d+)\s*$"),
            key=_cardinal,
        ),
        SlotRule(
            name="cuisine",
            type="string",
            prompt="What kind of food?",
            description="the kind of food",
            readback="at a {{cuisine}} restaurant",
            request=re.compile(
                r"\b(italian|thai|japanese|sushi|chinese|korean|vietnamese|indian"
                r"|mexican|french|greek|spanish|mediterranean|american|pizza)\b",
                re.I,
            ),
            observed=re.compile(
                r"^\s*(italian|thai|japanese|sushi|chinese|korean|vietnamese|indian"
                r"|mexican|french|greek|spanish|mediterranean|american|pizza)\s*$",
                re.I,
            ),
            key=_fold,
        ),
        SlotRule(
            name="date",
            type="string",
            prompt="What day?",
            description="the day of the reservation",
            readback="on {{date}}",
            request=re.compile(
                r"\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday"
                r"|friday|saturday|sunday)\b",
                re.I,
            ),
            observed=re.compile(
                r"\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday"
                r"|friday|saturday|sunday)\b",
                re.I,
            ),
            key=_fold,
        ),
        SlotRule(
            name="time",
            type="string",
            prompt="What time?",
            description="the reservation time",
            readback="at {{time}}",
            request=re.compile(
                rf"\bat\s+(\d{{1,2}}(?::\d{{2}})?\s*(?:[ap]\.?m\.?)?|{_CARDINAL_WORDS})\b",
                re.I,
            ),
            observed=re.compile(r"\b(\d{1,2}:\d{2}\s*[AP]\.?M\.?)", re.I),
            key=_hour12,
        ),
    ),
    find=VerbRule(
        step_id="search",
        action="restaurant.search",
        description="Find available tables matching the request",
        mechanics=frozenset({"fill", "type", "submit", "search"}),
    ),
    choose=VerbRule(
        step_id="select",
        action="restaurant.select",
        description="Take the best-ranked result offering the requested time",
        mechanics=frozenset({"read", "click"}),
    ),
    commit=VerbRule(
        step_id="book",
        action="restaurant.book",
        description="Place the reservation",
        mechanics=frozenset(),
    ),
    navigation=frozenset({"goto", "navigate", "open"}),
)

VOCABULARIES: tuple[TaskVocabulary, ...] = (RESTAURANT,)


@dataclass(frozen=True, slots=True)
class _Evidence:
    """One slot the trajectory actually exercised, with the value it used."""

    rule: SlotRule
    observed: str


def distill(trajectory: Mapping[str, Any]) -> dict[str, Any]:
    """Turn one winning trajectory into a schema-valid runbook document.

    Raises :class:`DistillationError` when the trajectory did not win, when no
    vocabulary covers its task, or when it reached its goal through a value that
    cannot be traced back to the request.
    """
    task = _require_winning(trajectory)
    vocabulary = _select_vocabulary(task)
    steps = _surviving_steps(trajectory["steps"])
    if not steps:
        raise DistillationError(
            "no steps survived pruning; the trajectory records no path that worked"
        )

    evidence = _lift_slots(vocabulary, task, steps)
    if not evidence:
        raise DistillationError(
            "no request value was lifted into a slot; the runbook would only ever "
            "replay the original request"
        )

    document = _assemble(vocabulary, trajectory, steps, evidence)
    _verify(document)
    return document


def _require_winning(trajectory: Mapping[str, Any]) -> str:
    """Refuse anything that is not a completed run.

    ``success_signal`` is self-reported and the judge exists because it is
    unreliable -- but a branch that does not even claim success, or that died
    with an error, is never the path to cache.
    """
    missing = [
        key
        for key in ("branch_id", "task", "steps", "success_signal")
        if key not in trajectory
    ]
    if missing:
        raise DistillationError(f"trajectory is missing {', '.join(missing)}")
    branch = trajectory["branch_id"]
    if trajectory.get("error"):
        raise DistillationError(
            f"branch {branch} died with error {trajectory['error']!r}; "
            f"nothing to distil"
        )
    if trajectory.get("success_signal") is not True:
        raise DistillationError(
            f"branch {branch} did not complete the task; the runbook is the path "
            f"that worked"
        )
    if not trajectory.get("final_answer"):
        raise DistillationError(f"branch {branch} reached no final answer")
    task = trajectory.get("task")
    if not isinstance(task, str) or not task.strip():
        raise DistillationError("trajectory has no task text to generalize toward")
    return task


def _select_vocabulary(task: str) -> TaskVocabulary:
    for vocabulary in VOCABULARIES:
        if vocabulary.claims(task):
            return vocabulary
    raise DistillationError(
        f"no distillation vocabulary covers {task!r}; teaching a new domain means "
        f"adding a TaskVocabulary"
    )


def _surviving_steps(steps: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Keep only the path that worked.

    Three cuts.  ``abandoned`` marks a dead end and ``error`` marks a mechanic
    that did not work -- neither belongs in a replay.  ``think`` steps are
    reasoning, and there is no verb to dispatch them to.

    The third cut is subtler: a field written twice means the first write was
    abandoned in fact even when the trajectory marked it ``ok``.  Branch 1 fills
    the same search box with two different restaurants; only the last one is
    part of the path that finished.
    """
    live = [
        step
        for step in steps
        if step.get("outcome") == "ok" and step.get("kind") != "think"
    ]

    last_write: dict[tuple[str, str], int] = {}
    for index, step in enumerate(live):
        selector = step.get("args", {}).get("selector")
        if selector is not None:
            last_write[(step.get("action", ""), selector)] = index

    superseded = {
        index
        for index, step in enumerate(live)
        for selector in [step.get("args", {}).get("selector")]
        if selector is not None
        and last_write[(step.get("action", ""), selector)] != index
    }
    return [step for index, step in enumerate(live) if index not in superseded]


def _written_values(steps: Iterable[Mapping[str, Any]]) -> list[tuple[str, str]]:
    """Every concrete value the run typed into the provider, with its step id."""
    written: list[tuple[str, str]] = []
    for step in steps:
        value = step.get("args", {}).get("value")
        if isinstance(value, str) and value.strip():
            written.append((str(step.get("i", "?")), value))
    return written


def _lift_slots(
    vocabulary: TaskVocabulary,
    task: str,
    steps: Sequence[Mapping[str, Any]],
) -> list[_Evidence]:
    """Lift request values into slots, and refuse values that are not requests.

    A written value that no rule can trace back to the request is the failure
    that matters.  Branch 1 types "Ristorante Adriatico" -- a name it got from an
    editorial listicle, not from the caller.  Lifting it into a slot would be
    inventing a parameter the run never varied; baking it in as a literal would
    produce a runbook that books that one restaurant forever.  Neither is
    honest, so this refuses instead.
    """
    written = _written_values(steps)
    claimed: dict[str, _Evidence] = {}
    attributed: set[str] = set()

    for rule in vocabulary.slots:
        spoken = rule.spoken(task)
        if spoken is None:
            continue
        wanted = rule.key(spoken)
        if wanted is None:
            continue
        for _, value in written:
            normalized = rule.normalized(value)
            if normalized is None or rule.key(normalized) != wanted:
                continue
            claimed.setdefault(rule.name, _Evidence(rule, normalized.strip()))
            attributed.add(value)
            break

    for step_index, value in written:
        if value not in attributed:
            raise DistillationError(
                f"step {step_index} writes {value!r}, which the request does not "
                f"mention. It cannot become a slot, and baking it in would build a "
                f"runbook that only ever repeats this one run."
            )

    return [claimed[rule.name] for rule in vocabulary.slots if rule.name in claimed]


def _rank(steps: Sequence[Mapping[str, Any]], vocabulary: TaskVocabulary) -> int | None:
    """Read the choice the run made as an ordinal, not as a name.

    ``:first-child`` is the only part of a selector worth keeping: it says the
    run took the top-ranked candidate, which is a policy that survives a
    redesign.  Everything else about the selector does not.
    """
    for step in steps:
        if step.get("action") not in vocabulary.choose.mechanics:
            continue
        selector = step.get("args", {}).get("selector", "")
        if ":first-child" in selector:
            return 1
        nth = re.search(r":nth-child\((\d+)\)", selector)
        if nth is not None:
            return int(nth.group(1))
    return None


def _arguments(evidence: Sequence[_Evidence]) -> dict[str, str]:
    return {item.rule.name: "{{" + item.rule.name + "}}" for item in evidence}


def _confirmation_prompt(evidence: Sequence[_Evidence]) -> str:
    """Build the spoken readback out of the slots that were declared.

    Generated rather than written so it cannot name a slot that does not exist.
    An unresolvable reference here does not merely read badly -- the executor
    fails the whole irreversible step closed rather than speak "{{cuisine}}"
    aloud.
    """
    fragments = [item.rule.readback for item in evidence]
    return " ".join(fragments) + ". Should I confirm?"


def _assemble(
    vocabulary: TaskVocabulary,
    trajectory: Mapping[str, Any],
    steps: Sequence[Mapping[str, Any]],
    evidence: Sequence[_Evidence],
) -> dict[str, Any]:
    slots = [
        {
            "name": item.rule.name,
            "type": item.rule.type,
            "required": True,
            "description": item.rule.description,
            "prompt": item.rule.prompt,
            "example": item.observed,
        }
        for item in evidence
    ]

    arguments = _arguments(evidence)
    document_steps: list[dict[str, Any]] = [
        {
            "id": vocabulary.find.step_id,
            "action": vocabulary.find.action,
            "description": vocabulary.find.description,
            "arguments": dict(arguments),
            "irreversible": False,
        }
    ]

    rank = _rank(steps, vocabulary)
    if rank is not None:
        choice: dict[str, Any] = {"rank": rank}
        if any(item.rule.name == "time" for item in evidence):
            choice["time"] = "{{time}}"
        document_steps.append(
            {
                "id": vocabulary.choose.step_id,
                "action": vocabulary.choose.action,
                "description": vocabulary.choose.description,
                "arguments": choice,
                "irreversible": False,
            }
        )

    # Synthesized, never observed.  The winning branch stops at "Ready to
    # confirm" because branching search must not run irreversible actions, so
    # the last inch of the task is exactly the part no trajectory can contain.
    document_steps.append(
        {
            "id": vocabulary.commit.step_id,
            "action": vocabulary.commit.action,
            "description": vocabulary.commit.description,
            "arguments": dict(arguments),
            "irreversible": True,
            "confirmation_prompt": _confirmation_prompt(evidence),
        }
    )

    return {
        "id": vocabulary.runbook_id,
        "name": vocabulary.runbook_name,
        "version": "1",
        "description": vocabulary.description,
        "utterance_examples": [trajectory["task"]],
        "slots": slots,
        "steps": document_steps,
    }


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _strings(item)


def _verify(document: Mapping[str, Any]) -> None:
    """Fail here rather than mid-replay.

    Everything checked is a property of the document alone, so a violation means
    this module is wrong -- and a wrong runbook that reaches the executor fails
    somewhere far less legible, potentially after a step has already run.
    """
    declared = {slot["name"]: slot for slot in document["slots"]}

    for slot in document["slots"]:
        if not slot.get("prompt"):
            raise DistillationError(f"slot {slot['name']!r} has no spoken prompt")

    irreversible = [step for step in document["steps"] if step.get("irreversible")]
    if len(irreversible) != 1:
        raise DistillationError(
            f"{len(irreversible)} irreversible steps; expected exactly one gate"
        )

    for step in document["steps"]:
        fields = [step.get("arguments"), step.get("confirmation_prompt")]
        for text in (item for field in fields for item in _strings(field)):
            for marker in _MECHANISM_MARKERS:
                if marker in text:
                    raise DistillationError(
                        f"step {step['id']!r} carries provider mechanics ({marker!r}); "
                        f"runbooks hold verbs, not selectors"
                    )
            for reference in _TEMPLATE.findall(text):
                slot = declared.get(reference)
                if slot is None:
                    raise DistillationError(
                        f"step {step['id']!r} references undeclared slot "
                        f"{reference!r}; replay would raise SlotResolutionError "
                        f"after earlier steps had already run"
                    )
                # An optional slot with no default resolves to nothing rather
                # than failing at the door, so the reference blows up later.
                if not slot.get("required") and "default" not in slot:
                    raise DistillationError(
                        f"step {step['id']!r} references optional slot "
                        f"{reference!r}, which has no default"
                    )

    prompt = irreversible[0].get("confirmation_prompt") or ""
    if not _TEMPLATE.search(prompt):
        raise DistillationError(
            f"step {irreversible[0]['id']!r} has a readback that names no "
            f"specifics; a confirmation must say what, when, and how many"
        )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="runbook-distill",
        description="Distil a winning trajectory into a schema-valid runbook.",
    )
    parser.add_argument("trajectory", type=Path, help="path to a trajectory JSON file")
    parser.add_argument(
        "-o",
        "--out",
        type=Path,
        default=None,
        help="write the runbook here instead of stdout",
    )
    args = parser.parse_args(argv)

    try:
        trajectory = json.loads(args.trajectory.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read {args.trajectory}: {exc}", file=sys.stderr)
        return 2
    if not isinstance(trajectory, dict):
        print(f"{args.trajectory} is not a trajectory object", file=sys.stderr)
        return 2

    try:
        document = distill(trajectory)
    except DistillationError as exc:
        print(f"refused {args.trajectory.name}: {exc}", file=sys.stderr)
        return 1

    rendered = json.dumps(document, indent=2) + "\n"
    if args.out is None:
        sys.stdout.write(rendered)
    else:
        args.out.write_text(rendered)
        print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
