"""Pick the winning branch out of a fan-out of sibling trajectories (TON-19).

One model call in, one winner out, with a stated reason.  Branch-and-prune is only
as good as the score it prunes on: a noisy judge is *worse* than no pruning, because
it discards the best branch confidently and then presents a loser as the answer.
Containing that means keeping this small, so there is deliberately no tournament, no
second opinion, no absolute scoring, and no benchmark - the judge compares these
branches to each other and to nothing else.

Two things make a comparative judge behave, and both are load-bearing here:

* It reads whole trajectories, not final answers.  ``steps[].outcome`` separates
  ``ok`` / ``error`` / ``abandoned``, and the abandoned ones are what distinguish two
  branches that both claim to have succeeded.
* It justifies the pick in one line.  That sentence is what you read on stage when
  someone asks how it chose, and the fastest way to spot a judge that is coin-flipping.

``success_signal`` is the branch's own claim about itself and is not evidence - the
judge exists precisely because it is unreliable.

Input is whatever ``schema/trajectory.schema.json`` describes, as plain JSON-shaped
mappings loaded straight from disk.  There is deliberately no ``Trajectory`` class:
the JSON Schema is the contract, and a second Python definition of it would drift.

The backend is the Anthropic SDK pointed at Sail's Anthropic-compatible Messages
endpoint.  Sail serves open-weight models, so this is *not* Claude - see the model
list at https://docs.sailresearch.com/pricing.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence
import tomllib

SAIL_BASE_URL = "https://api.sailresearch.com"
DEFAULT_MODEL = "moonshotai/Kimi-K2.6"

# The reason is the instrument you use to catch a judge that is coin-flipping, so an
# empty one makes the verdict unreadable even when the winner happens to be right.
# Observed in practice: one run in five answered "b0" - technically a string, useless
# as a justification. The floor is set below the shortest genuinely useful sentence
# ("b0 hit 7:00 PM exactly; b1 settled for 8:30." is ~45 characters).
MIN_REASON_CHARS = 25

JUDGE_SYSTEM_PROMPT = """\
You are judging a branching search. Several agents were given the SAME task and each \
attempted it independently from a different angle. Choose which attempt was best.

You are comparing these branches ONLY to each other. There is no reference answer and \
no ground truth available: "best" means best of the ones you were given.

Read the whole trajectory, not just the final answer. Every step records what was tried \
and what came back:
  outcome "ok"        - the step did what it was meant to
  outcome "error"     - the step failed outright
  outcome "abandoned" - the step was tried and dropped, and the branch moved on

Dead ends are evidence, not noise. A branch that wandered through abandoned steps \
searched worse than one that went straight to the result, all else being equal.

Do NOT trust "success_signal". It is the branch's own claim about itself, it is often \
wrong, and a branch can report success while delivering something that does not \
actually satisfy the task. Judge from the steps and the final answer instead.

Decide in this order:
1. Did the branch satisfy the task as stated? Check each constraint in the task text \
separately. Missing a stated constraint is a failure to satisfy it, not a small deduction.
2. On the branch's own recorded evidence, how good is the result it produced?
3. How directly did it get there - dead ends, errors, wasted steps, elapsed time.

A branch that produced nothing loses to any branch that produced something usable.

Reply with the winning branch_id and one sentence saying what decided it. Name the \
concrete difference between the winner and the runner-up, not a generic judgement.\
"""


class JudgeError(RuntimeError):
    """The judge could not produce a usable verdict."""


@dataclass(frozen=True, slots=True)
class JudgeVerdict:
    """Which branch won, and the one line that justifies it."""

    winner: str
    reason: str


class JudgeModel(Protocol):
    """The single model call the judge is allowed to make.

    Narrow on purpose, in the shape of :class:`~.adapters.HttpClient`: the judge owns
    the prompt and the output schema, the adapter owns the transport. That split is
    what lets every test below run without credentials or a network.
    """

    def compare(
        self, *, system: str, prompt: str, schema: Mapping[str, Any]
    ) -> str: ...


class PairwiseJudge:
    """Compare sibling trajectories and name a winner."""

    def __init__(self, model: JudgeModel) -> None:
        self._model = model

    def pick(self, trajectories: Sequence[Mapping[str, Any]]) -> JudgeVerdict:
        branch_ids = _branch_ids(trajectories)
        raw = self._model.compare(
            system=JUDGE_SYSTEM_PROMPT,
            prompt=_render_trajectories(trajectories),
            schema=verdict_schema(branch_ids),
        )
        return _parse_verdict(raw, branch_ids)


def longest_successful_branch(
    trajectories: Sequence[Mapping[str, Any]],
) -> JudgeVerdict:
    """The documented fallback for when the judge cannot be trusted (TON-19).

    Worse than the judge but honest, and it keeps the demo alive: it takes
    ``success_signal`` at face value and breaks ties by step count, which is exactly
    the naive scoring the judge exists to beat. On the shipped fixtures it picks b1
    over b0 - the wrong answer - so reach for it knowing what it costs.
    """
    successful = [t for t in trajectories if t.get("success_signal")]
    if not successful:
        raise JudgeError("no branch reported success; fallback has nothing to pick")
    # max() keeps the first maximum, so ties resolve by input order rather than
    # by whichever branch happened to be enumerated last.
    winner = max(successful, key=lambda t: len(t.get("steps", ())))
    steps = len(winner.get("steps", ()))
    return JudgeVerdict(
        winner=str(winner["branch_id"]),
        reason=(
            f"Longest self-reported successful trajectory ({steps} steps); "
            f"fallback ranking, no comparison was made."
        ),
    )


def verdict_schema(branch_ids: Sequence[str]) -> dict[str, Any]:
    """Constrain the verdict to the branches that were actually supplied.

    Putting the ids in an enum turns "invented a branch that was never in the fan-out"
    into a schema violation the model cannot emit, rather than a wrong answer the
    caller has to catch downstream.
    """
    return {
        "type": "object",
        "properties": {
            "winner": {
                "type": "string",
                "enum": list(branch_ids),
                "description": "branch_id of the branch that made the best attempt.",
            },
            "reason": {
                "type": "string",
                "minLength": MIN_REASON_CHARS,
                "description": (
                    "One sentence naming the concrete difference between the winner "
                    "and the runner-up. Not just the branch_id."
                ),
            },
        },
        "required": ["winner", "reason"],
        "additionalProperties": False,
    }


class SailJudgeModel:
    """Run the comparison through Sail's Anthropic-compatible Messages endpoint.

    Sail serves open-weight models, so despite the SDK this is not Claude. The
    endpoint accepts ``output_config.format``, which is what makes the response
    parseable without a retry loop.

    ``temperature`` defaults to 0: a judge that prunes branches should not be
    stochastic, and the whole point of the 5-run check is that repeated calls agree.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str = DEFAULT_MODEL,
        base_url: str = SAIL_BASE_URL,
        effort: str = "high",
        temperature: float = 0.0,
        max_tokens: int = 8192,
        client: Any | None = None,
    ) -> None:
        self._model = model
        self._effort = effort
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._client = client or _anthropic_client(
            api_key or sail_api_key(), base_url
        )

    def compare(self, *, system: str, prompt: str, schema: Mapping[str, Any]) -> str:
        try:
            response = self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                temperature=self._temperature,
                system=system,
                output_config={
                    "format": {
                        "type": "json_schema",
                        "name": "judge_verdict",
                        "schema": dict(schema),
                        "strict": True,
                    },
                    "effort": self._effort,
                },
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as exc:
            raise JudgeError(f"judge model call failed: {_detail(exc)}") from exc

        if getattr(response, "stop_reason", None) == "refusal":
            raise JudgeError("judge model refused the comparison")
        text = next(
            (b.text for b in response.content if getattr(b, "type", None) == "text"),
            None,
        )
        if not text:
            raise JudgeError("judge model returned no text content")
        return text


def sail_api_key() -> str:
    """Resolve the Sail key from the environment, then from ``sail auth login`` state.

    Reading the documented ``~/.sail/auth.toml`` directly keeps this module off the
    optional ``sail`` dependency, which exists for Sailbox lifecycle and has nothing
    to do with judging.
    """
    from_env = os.environ.get("SAIL_API_KEY", "").strip()
    if from_env:
        return from_env

    path = Path.home() / ".sail" / "auth.toml"
    try:
        auth = tomllib.loads(path.read_text())
    except OSError as exc:
        raise JudgeError(
            f"no Sail credential: set SAIL_API_KEY or run `sail auth login` ({exc})"
        ) from exc
    except tomllib.TOMLDecodeError as exc:
        raise JudgeError(f"could not parse {path}: {exc}") from exc

    key = str(auth.get("api_key", "")).strip()
    if not key:
        raise JudgeError(f"{path} has no api_key; run `sail auth login`")
    return key


def _anthropic_client(api_key: str, base_url: str) -> Any:
    try:
        from anthropic import Anthropic
    except ImportError as exc:
        raise JudgeError(
            "judge support is not installed; run `pip install -e '.[judge]'`"
        ) from exc
    return Anthropic(api_key=api_key, base_url=base_url)


def _branch_ids(trajectories: Sequence[Mapping[str, Any]]) -> list[str]:
    if len(trajectories) < 2:
        raise ValueError("a comparison needs at least two trajectories")

    branch_ids: list[str] = []
    for trajectory in trajectories:
        branch_id = trajectory.get("branch_id")
        if not isinstance(branch_id, str) or not branch_id.strip():
            raise ValueError("every trajectory needs a non-empty branch_id")
        if branch_id in branch_ids:
            raise ValueError(f"duplicate branch_id: {branch_id}")
        branch_ids.append(branch_id)
    return branch_ids


def _render_trajectories(trajectories: Sequence[Mapping[str, Any]]) -> str:
    """Serialize the branches whole - every step, every dead end, every note.

    Trimming this to final answers is the one change that would quietly break the
    judge while leaving every test that only checks the return type passing.
    """
    task = str(trajectories[0].get("task", "")).strip()
    body = json.dumps(list(trajectories), indent=2)
    return (
        f"The task every branch was given:\n\n    {task}\n\n"
        f"The trajectories, in no particular order:\n\n{body}"
    )


def _parse_verdict(raw: str, branch_ids: Sequence[str]) -> JudgeVerdict:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise JudgeError(f"judge returned malformed JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise JudgeError(f"judge returned {type(payload).__name__}, expected an object")

    winner = payload.get("winner")
    if not isinstance(winner, str) or winner not in branch_ids:
        raise JudgeError(
            f"judge picked {winner!r}, which is not one of {list(branch_ids)}"
        )

    reason = payload.get("reason")
    if not isinstance(reason, str):
        raise JudgeError("judge gave no reason for its pick")
    # Restating the winner is the degenerate answer the schema cannot rule out on its
    # own, and TON-19 is only done when a winner comes out *with a stated reason*.
    reason = reason.strip()
    if reason in branch_ids or len(reason) < MIN_REASON_CHARS:
        raise JudgeError(f"judge picked {winner} but did not justify it: {reason!r}")
    return JudgeVerdict(winner=winner, reason=reason)


def _detail(error: BaseException) -> str:
    detail = str(error).strip()
    return detail or type(error).__name__
