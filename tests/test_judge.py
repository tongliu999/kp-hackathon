"""Cover the judge without a network, a credential, or a model.

The interesting assertions are not "does it return a JudgeVerdict" - they are the ones
that pin down *what the model is shown*. TON-19's whole thesis is that comparing full
trajectories beats comparing final answers, and a judge trimmed down to final answers
would still satisfy every type-level test. So the prompt content is asserted directly.
"""

import json
from pathlib import Path

import pytest

from runbook_voice.judge import (
    MIN_REASON_CHARS,
    JudgeError,
    JudgeVerdict,
    PairwiseJudge,
    SailJudgeModel,
    longest_successful_branch,
    sail_api_key,
    verdict_schema,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "trajectories"

BRANCHES = [
    {"branch_id": "b0", "task": "t", "steps": [{"i": 0}], "success_signal": True},
    {"branch_id": "b1", "task": "t", "steps": [{"i": 0}], "success_signal": True},
]


def recorded_trajectories() -> list[dict]:
    return [json.loads(path.read_text()) for path in sorted(FIXTURES.glob("*.json"))]


class RecordingModel:
    """Stand in for the one model call, and keep what it was asked."""

    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[tuple[str, str, dict]] = []

    def compare(self, *, system, prompt, schema):
        self.calls.append((system, prompt, schema))
        return self.response


class Block:
    def __init__(self, text: str, kind: str = "text") -> None:
        self.text = text
        self.type = kind


class Response:
    def __init__(self, content, stop_reason: str = "end_turn") -> None:
        self.content = content
        self.stop_reason = stop_reason


class FakeMessages:
    def __init__(self, outcome) -> None:
        self.outcome = outcome
        self.kwargs: dict = {}

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class FakeAnthropic:
    def __init__(self, outcome) -> None:
        self.messages = FakeMessages(outcome)


REASON = "b1 matched the requested time exactly; b0 was 90 minutes late."


def test_pick_returns_the_structured_verdict() -> None:
    model = RecordingModel(json.dumps({"winner": "b1", "reason": REASON}))

    assert PairwiseJudge(model).pick(BRANCHES) == JudgeVerdict("b1", REASON)


def test_pick_rejects_a_winner_that_was_not_in_the_fan_out() -> None:
    model = RecordingModel('{"winner": "b7", "reason": "invented"}')

    with pytest.raises(JudgeError, match="not one of"):
        PairwiseJudge(model).pick(BRANCHES)


@pytest.mark.parametrize(
    "response",
    [
        "not json at all",
        '["b0"]',
        '{"reason": "no winner field"}',
        '{"winner": "b0", "reason": "   "}',
        '{"winner": "b0", "reason": 3}',
        '{"winner": "b0"}',
    ],
)
def test_pick_rejects_unusable_verdicts(response) -> None:
    with pytest.raises(JudgeError):
        PairwiseJudge(RecordingModel(response)).pick(BRANCHES)


@pytest.mark.parametrize("reason", ["b0", " b0 ", "better", "it won"])
def test_pick_rejects_a_pick_it_did_not_justify(reason) -> None:
    """A verdict whose "reason" restates the winner is unreadable on stage.

    Observed live once in five runs. The winner was right, but the sentence you would
    read out to explain the pick was the string "b0" - so the one signal TON-19 relies
    on to catch a coin-flipping judge was gone.
    """
    model = RecordingModel(json.dumps({"winner": "b0", "reason": reason}))

    with pytest.raises(JudgeError, match="did not justify"):
        PairwiseJudge(model).pick(BRANCHES)


def test_schema_asks_the_model_for_a_reason_of_substance() -> None:
    reason = verdict_schema(["b0", "b1"])["properties"]["reason"]

    assert reason["minLength"] == MIN_REASON_CHARS


def test_prompt_carries_every_step_including_the_dead_ends() -> None:
    """The regression guard for the design decision this ticket rests on.

    Feeding final answers only would leave every other test in this file passing while
    destroying the judge's ability to tell b0 from b1 - both of which claim success.
    """
    trajectories = recorded_trajectories()
    model = RecordingModel(json.dumps({"winner": "b0", "reason": REASON}))

    PairwiseJudge(model).pick(trajectories)

    _, prompt, _ = model.calls[0]
    for trajectory in trajectories:
        assert trajectory["branch_id"] in prompt
        assert trajectory["angle"] in prompt
        for step in trajectory["steps"]:
            assert step["outcome"] in prompt
            if "observation_excerpt" in step:
                assert step["observation_excerpt"] in prompt
            if "note" in step:
                assert step["note"] in prompt

    assert "abandoned" in prompt, "dead ends must survive serialization"
    assert prompt.count('"outcome"') == sum(
        len(t["steps"]) for t in trajectories
    ), "every step is shown, not a summary"


def test_prompt_states_the_task_the_branches_shared() -> None:
    trajectories = recorded_trajectories()
    model = RecordingModel(json.dumps({"winner": "b0", "reason": REASON}))

    PairwiseJudge(model).pick(trajectories)

    assert trajectories[0]["task"] in model.calls[0][1]


def test_system_prompt_distrusts_the_self_reported_success_signal() -> None:
    model = RecordingModel(json.dumps({"winner": "b0", "reason": REASON}))

    PairwiseJudge(model).pick(BRANCHES)

    system = model.calls[0][0]
    assert "success_signal" in system
    assert "abandoned" in system
    assert "no ground truth" in system


def test_schema_pins_the_winner_to_the_supplied_branches() -> None:
    schema = verdict_schema(["b0", "b1", "b2"])

    assert schema["properties"]["winner"]["enum"] == ["b0", "b1", "b2"]
    assert schema["required"] == ["winner", "reason"]
    assert schema["additionalProperties"] is False


def test_pick_needs_something_to_compare_against() -> None:
    with pytest.raises(ValueError, match="at least two"):
        PairwiseJudge(RecordingModel("{}")).pick(BRANCHES[:1])


def test_pick_rejects_duplicate_branch_ids() -> None:
    with pytest.raises(ValueError, match="duplicate branch_id"):
        PairwiseJudge(RecordingModel("{}")).pick([BRANCHES[0], BRANCHES[0]])


@pytest.mark.parametrize("branch_id", [None, "", "   ", 7])
def test_pick_rejects_branches_without_a_usable_id(branch_id) -> None:
    branches = [BRANCHES[0], {**BRANCHES[1], "branch_id": branch_id}]

    with pytest.raises(ValueError, match="non-empty branch_id"):
        PairwiseJudge(RecordingModel("{}")).pick(branches)


def test_fallback_ignores_branches_that_reported_failure() -> None:
    branches = [
        {"branch_id": "b0", "steps": [{}, {}], "success_signal": True},
        {"branch_id": "b1", "steps": [{}, {}, {}, {}], "success_signal": False},
    ]

    assert longest_successful_branch(branches).winner == "b0"


def test_fallback_breaks_ties_by_input_order() -> None:
    branches = [
        {"branch_id": "b0", "steps": [{}, {}], "success_signal": True},
        {"branch_id": "b1", "steps": [{}, {}], "success_signal": True},
    ]

    assert longest_successful_branch(branches).winner == "b0"


def test_fallback_raises_when_nothing_claimed_success() -> None:
    branches = [{**b, "success_signal": False} for b in BRANCHES]

    with pytest.raises(JudgeError, match="no branch reported success"):
        longest_successful_branch(branches)


def test_fallback_gets_the_recorded_fixtures_wrong() -> None:
    """Documents the cost of the fallback rather than leaving it to be discovered live.

    b1 has more steps than b0 and self-reports success, so step count crowns the branch
    that booked the wrong time 3.1 miles away. That is the "worse, but honest" trade
    TON-19 accepts - if this ever starts returning b0, the fixtures changed.
    """
    assert longest_successful_branch(recorded_trajectories()).winner == "b1"


def test_sail_model_sends_the_schema_and_returns_the_text() -> None:
    client = FakeAnthropic(Response([Block('{"winner": "b0", "reason": "r"}')]))
    model = SailJudgeModel(client=client, model="test/model")

    result = model.compare(system="sys", prompt="prompt", schema={"type": "object"})

    assert result == '{"winner": "b0", "reason": "r"}'
    sent = client.messages.kwargs
    assert sent["model"] == "test/model"
    assert sent["system"] == "sys"
    assert sent["temperature"] == 0.0, "a pruning judge must not be stochastic"
    assert sent["output_config"]["format"]["schema"] == {"type": "object"}
    assert sent["output_config"]["format"]["strict"] is True


def test_sail_model_reports_a_refusal_rather_than_returning_empty() -> None:
    client = FakeAnthropic(Response([], stop_reason="refusal"))

    with pytest.raises(JudgeError, match="refused"):
        SailJudgeModel(client=client).compare(system="s", prompt="p", schema={})


def test_sail_model_rejects_a_response_with_no_text() -> None:
    client = FakeAnthropic(Response([Block("", "thinking")]))

    with pytest.raises(JudgeError, match="no text content"):
        SailJudgeModel(client=client).compare(system="s", prompt="p", schema={})


def test_sail_model_wraps_transport_failures() -> None:
    client = FakeAnthropic(RuntimeError("connection reset"))

    with pytest.raises(JudgeError, match="connection reset"):
        SailJudgeModel(client=client).compare(system="s", prompt="p", schema={})


def test_sail_api_key_prefers_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("SAIL_API_KEY", "  from-env  ")

    assert sail_api_key() == "from-env"


def test_sail_api_key_falls_back_to_the_cli_auth_file(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("SAIL_API_KEY", raising=False)
    (tmp_path / ".sail").mkdir()
    (tmp_path / ".sail" / "auth.toml").write_text('api_key = "from-file"\n')
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert sail_api_key() == "from-file"


def test_sail_api_key_says_how_to_authenticate_when_absent(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("SAIL_API_KEY", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    with pytest.raises(JudgeError, match="sail auth login"):
        sail_api_key()
