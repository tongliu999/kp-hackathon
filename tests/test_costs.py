from runbook_voice.costs import inference_metrics, run_metrics


class Trajectory:
    def __init__(self, metrics):
        self.metrics = metrics


def test_inference_cost_uses_measured_tokens_and_published_rates() -> None:
    metrics = inference_metrics(
        model="zai-org/GLM-5.2-FP8",
        completion_window="priority",
        model_calls=2,
        input_tokens=1_000_000,
        output_tokens=100_000,
    )

    assert metrics["estimated_cost_usd"] == 1.0
    assert metrics["cost_status"] == "estimated"
    assert metrics["pricing_source"].endswith("/pricing")


def test_run_total_is_partial_when_sailbox_billing_is_unavailable() -> None:
    branch = Trajectory({"model_calls": 1, "input_tokens": 10, "output_tokens": 5, "estimated_cost_usd": 0.01})
    metrics = run_metrics(
        [branch],
        {"estimated_cost_usd": 0.02},
        {"status": "unavailable"},
    )

    assert metrics["known_cost_usd"] == 0.03
    assert metrics["total_cost_usd"] is None
    assert metrics["cost_status"] == "partial"


def test_unknown_model_preserves_usage_without_inventing_a_price() -> None:
    metrics = inference_metrics(
        model="future/model",
        completion_window="priority",
        model_calls=1,
        input_tokens=12,
        output_tokens=3,
    )

    assert metrics["input_tokens"] == 12
    assert metrics["cost_status"] == "unavailable"
    assert "estimated_cost_usd" not in metrics


def test_missing_provider_usage_does_not_claim_a_zero_dollar_run() -> None:
    metrics = inference_metrics(
        model="moonshotai/Kimi-K2.6",
        completion_window="priority",
        model_calls=1,
        input_tokens=0,
        output_tokens=0,
    )

    assert metrics["cost_status"] == "unavailable"
    assert "estimated_cost_usd" not in metrics
