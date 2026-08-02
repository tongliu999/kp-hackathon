"""Durable JSON-file storage and offline matching for runbooks.

The store deliberately treats each runbook as an opaque JSON object.  The M0
schema owns the contents of that object; this module only persists it and reads
a small set of descriptive fields when choosing a warm-path candidate.
"""

from __future__ import annotations

import copy
import fcntl
import json
import math
import os
import re
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Iterator, Mapping, Protocol, Sequence, TypeAlias


JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
Runbook: TypeAlias = dict[str, JSONValue]

_FORMAT_VERSION = 1


class RunbookStoreError(RuntimeError):
    """Base class for runbook-store failures."""


class RunbookStoreCorruptionError(RunbookStoreError):
    """Raised when an existing store cannot be safely decoded."""


class RunbookValidationError(RunbookStoreError, ValueError):
    """Raised when ``save`` receives a value that is not a JSON object."""


class RunbookMatcher(Protocol):
    """Select one of the supplied runbooks, or return ``None`` for a miss.

    A network-backed/LLM matcher can implement this protocol and be injected
    into :class:`JSONRunbookStore`. Implementations must return one of the
    candidate objects they receive, rather than synthesizing a new runbook.
    """

    def match(
        self, utterance: str, runbooks: Sequence[Runbook]
    ) -> Mapping[str, JSONValue] | None:
        """Return the best candidate for ``utterance``, if one matches."""


class RunbookSerializable(Protocol):
    """M0 schema objects expose this method for JSON persistence."""

    def to_dict(self) -> Mapping[str, Any]:
        """Return the canonical M0 JSON document."""


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


def _aliases(*groups: tuple[str, ...]) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for group in groups:
        canonical = group[0]
        aliases.update((term, canonical) for term in group)
    return aliases


_ALIASES = _aliases(
    (
        "schedule",
        "arrange",
        "book",
        "booked",
        "booking",
        "reserve",
        "reserved",
        "reservation",
        "reservations",
    ),
    ("restaurant", "dinner", "dining", "meal", "restaurants", "table"),
    ("ride", "cab", "car", "lyft", "taxi", "uber"),
    ("flight", "airfare", "airline", "fly", "plane"),
    ("lodging", "accommodation", "hotel", "room", "stay"),
    ("haircut", "barber", "hair", "salon"),
    ("purchase", "buy", "order", "ordered", "ordering", "purchase"),
    ("cancel", "cancelled", "cancellation", "delete", "remove"),
    ("cheap", "affordable", "cheapest", "inexpensive", "lowcost"),
    ("weather", "forecast", "temperature"),
)

# The canonical side of the table is the vocabulary of *concepts* the product
# knows about: what kind of thing a request is about, never which instance of it.
_CONCEPTS = frozenset(_ALIASES.values())
_ALIAS_TERMS = tuple(sorted(_ALIASES))

# A token that names a concept is what the request *means*; anything else
# ("japanese", "sunday", "7pm", "san francisco") is an instance value, which is
# precisely what slots exist to capture.  Values still count -- two requests that
# share them are more alike -- but a missing one must not sink an otherwise
# identical intent, so they weigh a quarter of a concept.
_CONCEPT_WEIGHT = 1.0
_VALUE_WEIGHT = 0.25

# Below this much shared weight there is no intent in common worth replaying: a
# single incidental word ("italian") is a coincidence, not a request to reuse.
_MINIMUM_EVIDENCE = 0.5

# Fuzzy comparison is for slips, not for synonyms.  Short words are excluded
# because one edit is the whole difference between real words (table/cable,
# book/look, hair/hail), and the first letter must agree because typing and
# speech-to-text slips almost never land there.
_MIN_FUZZY_LENGTH = 6
_LONG_WORD_LENGTH = 9

_MATCH_FIELDS = frozenset(
    {
        "aliases",
        "canonical_utterance",
        "description",
        "examples",
        "intent",
        "match",
        "matching",
        "name",
        "summary",
        "task",
        "trigger",
        "trigger_phrases",
        "utterance",
        "utterance_examples",
        "utterances",
    }
)


def _edit_distance(left: str, right: str, limit: int) -> int:
    """Damerau-Levenshtein distance, abandoned as soon as it exceeds ``limit``.

    Transpositions count as one edit because "restuarant" is one slip of the
    fingers away from "restaurant", not two.
    """

    if abs(len(left) - len(right)) > limit:
        return limit + 1
    before_previous: list[int] = []
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row] + [0] * len(right)
        for column, right_char in enumerate(right, start=1):
            cost = 0 if left_char == right_char else 1
            current[column] = min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + cost,
            )
            if (
                row > 1
                and column > 1
                and left_char == right[column - 2]
                and left[row - 2] == right_char
            ):
                current[column] = min(current[column], before_previous[column - 2] + 1)
        if min(current) > limit:
            return limit + 1
        before_previous, previous = previous, current
    return previous[-1]


@lru_cache(maxsize=8192)
def _similarity(left: str, right: str) -> float:
    """1.0 for identical words, ~0.9 for one slip, 0.0 for anything else.

    Voice transcription and fast typing produce "resturant" and "restuarant" for
    "restaurant"; exact set equality throws away the single most informative
    token in the request when they do.
    """

    if left == right:
        return 1.0
    shorter = min(len(left), len(right))
    if shorter < _MIN_FUZZY_LENGTH or left[0] != right[0]:
        return 0.0
    tolerance = 2 if shorter >= _LONG_WORD_LENGTH else 1
    distance = _edit_distance(left, right, tolerance)
    if distance > tolerance:
        return 0.0
    return 1.0 - distance / max(len(left), len(right))


@lru_cache(maxsize=8192)
def _canonical(word: str) -> str:
    """Normalize a word onto a concept, tolerating a misspelling of one."""

    known = _ALIASES.get(word)
    if known is not None:
        return known
    best_term: str | None = None
    best_similarity = 0.0
    for term in _ALIAS_TERMS:  # sorted, so ties resolve the same way every time
        similarity = _similarity(word, term)
        if similarity > best_similarity:
            best_term, best_similarity = term, similarity
    return _ALIASES[best_term] if best_term is not None else word


def _tokens(text: str) -> frozenset[str]:
    return frozenset(
        _canonical(word)
        for word in _WORD_RE.findall(text.casefold())
        if word not in _STOP_WORDS
    )


def _weight(token: str) -> float:
    return _CONCEPT_WEIGHT if token in _CONCEPTS else _VALUE_WEIGHT


def _weigh(tokens: frozenset[str]) -> float:
    return sum(_weight(token) for token in tokens)


def _shared_weight(query: frozenset[str], candidate: frozenset[str]) -> float:
    """Weight of what the two texts share, pairing near-identical leftovers.

    Leftovers are paired greedily, one to one, over sorted tokens so the result
    depends only on the two texts.
    """

    total = _weigh(query & candidate)
    unpaired = sorted(candidate - query)
    for word in sorted(query - candidate):
        best_other: str | None = None
        best_similarity = 0.0
        for other in unpaired:
            similarity = _similarity(word, other)
            if similarity > best_similarity:
                best_other, best_similarity = other, similarity
        if best_other is not None:
            unpaired.remove(best_other)
            total += best_similarity * min(_weight(word), _weight(best_other))
    return total


def _strings(value: JSONValue) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)


def _match_text(runbook: Mapping[str, JSONValue]) -> str:
    parts: list[str] = []
    for key, value in runbook.items():
        if key.casefold() in _MATCH_FIELDS:
            parts.extend(_strings(value))
    return " ".join(parts)


class DeterministicSemanticMatcher:
    """A dependency-free, deterministic approximation of intent matching.

    It combines synonym-normalized token coverage with Jaccard similarity, both
    computed over *weighted* tokens: a word that names a concept the product
    knows about counts four times what an instance value counts, and a word one
    slip away from another ("resturant"/"restaurant") counts as very nearly that
    word.  Together those make the score track what a request means rather than
    which words it happens to spell correctly, so "book me a japanese resturant
    on sunday for 4 pm" reaches the skill distilled from "book a table".

    The default is intentionally conservative enough to preserve the cold-path
    ``None`` seam: an unrelated errand ("get me a haircut", "book me a flight to
    tokyo") shares at most the verb, and half a skill's concepts is not enough
    to clear the threshold.
    """

    def __init__(self, *, threshold: float = 0.48) -> None:
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold must be between 0 and 1")
        self.threshold = threshold

    def match(
        self, utterance: str, runbooks: Sequence[Runbook]
    ) -> Mapping[str, JSONValue] | None:
        query = _tokens(utterance)
        if not query:
            return None

        query_weight = _weigh(query)
        best: Runbook | None = None
        best_score = 0.0
        for runbook in runbooks:
            candidate = _tokens(_match_text(runbook))
            if not candidate:
                continue
            shared = _shared_weight(query, candidate)
            if shared < _MINIMUM_EVIDENCE:
                continue
            candidate_weight = _weigh(candidate)

            # Coverage reads whichever side is the more concentrated statement
            # of the intent, so neither a terse skill ("book a table") nor a
            # detailed request is punished for the words the other omits.  The
            # weights are what make that safe: the words a request adds are
            # usually values, which cost a quarter of a concept, while a
            # concept the other side never mentions -- flight, haircut --
            # costs full price and is what keeps an errand off this skill.
            coverage = shared / min(query_weight, candidate_weight)
            # Jaccard still penalizes an accidental shared word between two
            # otherwise unrelated descriptions.
            jaccard = shared / (query_weight + candidate_weight - shared)
            score = 0.7 * coverage + 0.3 * jaccard
            if score > best_score:
                best = runbook
                best_score = score

        return best if best_score >= self.threshold else None


class JSONRunbookStore:
    """Concurrency-safe runbook persistence backed by one JSON file."""

    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        matcher: RunbookMatcher | None = None,
    ) -> None:
        self.path = Path(path)
        self.lock_path = self.path.with_name(f"{self.path.name}.lock")
        self.matcher = matcher or DeterministicSemanticMatcher()

    def save(self, runbook: Mapping[str, Any] | RunbookSerializable) -> None:
        """Insert a runbook, replacing an existing entry with the same ``id``.

        The input is validated as finite JSON but is otherwise left to the M0
        schema. A failed validation or write never replaces the existing file.
        """

        if isinstance(runbook, Mapping):
            document = runbook
        else:
            to_dict = getattr(runbook, "to_dict", None)
            if not callable(to_dict):
                raise RunbookValidationError(
                    "runbook must be a JSON object or expose to_dict()"
                )
            document = to_dict()
        validated = _validate_runbook(document)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock(exclusive=True):
            runbooks = self._read_unlocked()
            identity = validated.get("id")
            replaced = False
            if isinstance(identity, str) and identity:
                for index, existing in enumerate(runbooks):
                    if existing.get("id") == identity:
                        runbooks[index] = validated
                        replaced = True
                        break
            if not replaced:
                runbooks.append(validated)
            self._write_unlocked(runbooks)

    def lookup(self, utterance: str) -> Runbook | None:
        """Return the matching stored runbook, or ``None`` to trigger cold path."""

        if not isinstance(utterance, str):
            raise TypeError("utterance must be a string")
        if not self.path.parent.exists():
            return None
        with self._lock(exclusive=False):
            runbooks = self._read_unlocked()

        # Isolate persisted records from matchers that mutate their inputs.
        candidates = copy.deepcopy(runbooks)
        selected = self.matcher.match(utterance, candidates)
        if selected is None:
            return None
        if not isinstance(selected, Mapping) or not any(
            selected is candidate for candidate in candidates
        ):
            raise RunbookStoreError("matcher must return one of its candidate runbooks")
        return copy.deepcopy(dict(selected))

    def list(self) -> list[Runbook]:
        """Return isolated copies of every completed runbook in store order."""

        if not self.path.parent.exists():
            return []
        with self._lock(exclusive=False):
            runbooks = self._read_unlocked()
        return copy.deepcopy(runbooks)

    @contextmanager
    def _lock(self, *, exclusive: bool) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(descriptor, operation)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read_unlocked(self) -> list[Runbook]:
        if not self.path.exists():
            return []
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RunbookStoreCorruptionError(
                f"runbook store {self.path} contains invalid JSON: {error}"
            ) from error
        except OSError as error:
            raise RunbookStoreError(
                f"could not read runbook store {self.path}: {error}"
            ) from error

        try:
            if isinstance(document, list):
                # Accept the earliest prototype layout and migrate it on save.
                records = document
            elif isinstance(document, dict):
                if document.get("format_version") != _FORMAT_VERSION:
                    raise ValueError("unsupported or missing format_version")
                records = document.get("runbooks")
                if not isinstance(records, list):
                    raise ValueError("'runbooks' must be an array")
            else:
                raise ValueError("top-level value must be an object")
            return [_validate_runbook(item) for item in records]
        except (RunbookValidationError, ValueError) as error:
            raise RunbookStoreCorruptionError(
                f"runbook store {self.path} has an invalid structure: {error}"
            ) from error

    def _write_unlocked(self, runbooks: Sequence[Runbook]) -> None:
        document = {"format_version": _FORMAT_VERSION, "runbooks": runbooks}
        serialized = json.dumps(
            document, indent=2, sort_keys=True, allow_nan=False
        )
        payload = (serialized + "\n").encode("utf-8")
        temporary_path: Path | None = None
        try:
            with NamedTemporaryFile(
                mode="wb",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, self.path)
            temporary_path = None
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError as error:
            raise RunbookStoreError(
                f"could not write runbook store {self.path}: {error}"
            ) from error
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass


def _validate_runbook(value: Mapping[str, Any]) -> Runbook:
    if not isinstance(value, Mapping):
        raise RunbookValidationError("runbook must be a JSON object")
    candidate = dict(value)
    _validate_json_value(candidate, path="runbook")
    try:
        encoded = json.dumps(candidate, allow_nan=False)
        decoded = json.loads(encoded)
    except (TypeError, ValueError) as error:
        raise RunbookValidationError(f"runbook is not finite JSON: {error}") from error
    if not isinstance(decoded, dict):  # pragma: no cover - guaranteed by the check above
        raise RunbookValidationError("runbook must be a JSON object")
    return decoded


def _validate_json_value(value: Any, *, path: str) -> None:
    if value is None or isinstance(value, str | bool | int):
        return
    if isinstance(value, float):
        if math.isfinite(value):
            return
        raise RunbookValidationError(f"{path} contains a non-finite number")
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, path=f"{path}[{index}]")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise RunbookValidationError(f"{path} contains a non-string object key")
            _validate_json_value(item, path=f"{path}.{key}")
        return
    raise RunbookValidationError(
        f"{path} contains non-JSON value of type {type(value).__name__}"
    )


# Short alias for call sites that do not need to mention the storage mechanism.
RunbookStore = JSONRunbookStore


__all__ = [
    "DeterministicSemanticMatcher",
    "JSONRunbookStore",
    "JSONValue",
    "Runbook",
    "RunbookMatcher",
    "RunbookSerializable",
    "RunbookStore",
    "RunbookStoreCorruptionError",
    "RunbookStoreError",
    "RunbookValidationError",
]
