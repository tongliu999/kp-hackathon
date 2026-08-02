"""Transparent inference-cost estimates for Sail-hosted models.

Token counts come from the provider response. Dollar values are estimates made
from Sail's published price card; they are not invoices and are deliberately
tagged with their source and effective date.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

PRICING_SOURCE = "https://docs.sailresearch.com/pricing"
PRICING_AS_OF = "2026-08-02"

# USD per million tokens. Cached input is included where the price card exposes
# it, even though the current Anthropic-compatible endpoint does not report
# cache-token counts.
INFERENCE_RATES: dict[tuple[str, str], dict[str, float]] = {
    ("moonshotai/Kimi-K2.6", "priority"): {"input": 0.45, "cached_input": 0.20, "output": 3.00},
    ("moonshotai/Kimi-K2.6", "asap"): {"input": 1.00, "cached_input": 0.20, "output": 4.00},
    ("zai-org/GLM-5.2-FP8", "standard"): {"input": 0.50, "cached_input": 0.12, "output": 2.50},
    ("zai-org/GLM-5.2-FP8", "priority"): {"input": 0.70, "cached_input": 0.18, "output": 3.00},
    ("zai-org/GLM-5.2-FP8", "flex"): {"input": 0.40, "cached_input": 0.08, "output": 1.80},
    ("zai-org/GLM-5.2-FP8", "asap"): {"input": 1.00, "cached_input": 0.20, "output": 3.50},
}


def pricing_payload(model: str, completion_window: str) -> dict[str, Any] | None:
    """Return the small price-card fragment safe to ship into a Sailbox."""
    rates = INFERENCE_RATES.get((model, completion_window))
    if rates is None:
        return None
    return {
        "input_usd_per_million": rates["input"],
        "cached_input_usd_per_million": rates["cached_input"],
        "output_usd_per_million": rates["output"],
        "source": PRICING_SOURCE,
        "as_of": PRICING_AS_OF,
    }


def inference_metrics(
    *,
    model: str,
    completion_window: str,
    model_calls: int,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int = 0,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "model": model,
        "completion_window": completion_window,
        "model_calls": max(0, int(model_calls)),
        "input_tokens": max(0, int(input_tokens)),
        "cached_input_tokens": max(0, int(cached_input_tokens)),
        "output_tokens": max(0, int(output_tokens)),
    }
    pricing = pricing_payload(model, completion_window)
    missing_usage = (
        metrics["model_calls"] > 0
        and metrics["input_tokens"] == 0
        and metrics["output_tokens"] == 0
    )
    if pricing is None or missing_usage:
        metrics["cost_status"] = "unavailable"
        return metrics
    uncached = max(0, metrics["input_tokens"] - metrics["cached_input_tokens"])
    cost = (
        uncached * pricing["input_usd_per_million"]
        + metrics["cached_input_tokens"] * pricing["cached_input_usd_per_million"]
        + metrics["output_tokens"] * pricing["output_usd_per_million"]
    ) / 1_000_000
    metrics.update(
        estimated_cost_usd=round(cost, 9),
        cost_status="estimated",
        pricing_source=pricing["source"],
        pricing_as_of=pricing["as_of"],
    )
    return metrics


def run_metrics(
    trajectories: Sequence[Any],
    parent: Mapping[str, Any],
    sailboxes: Mapping[str, Any],
) -> dict[str, Any]:
    """Combine branch inference, parent inference, and Sailbox spend."""
    branch_items = [getattr(item, "metrics", None) or {} for item in trajectories]
    branch = {
        "model_calls": sum(int(item.get("model_calls", 0)) for item in branch_items),
        "input_tokens": sum(int(item.get("input_tokens", 0)) for item in branch_items),
        "cached_input_tokens": sum(int(item.get("cached_input_tokens", 0)) for item in branch_items),
        "output_tokens": sum(int(item.get("output_tokens", 0)) for item in branch_items),
    }
    branch_costs = [item.get("estimated_cost_usd") for item in branch_items]
    if branch_items and all(isinstance(value, (int, float)) for value in branch_costs):
        branch["estimated_cost_usd"] = round(sum(branch_costs), 9)
        branch["cost_status"] = "estimated"
    else:
        branch["cost_status"] = "unavailable"

    components = [branch.get("estimated_cost_usd"), parent.get("estimated_cost_usd")]
    box_cost = sailboxes.get("total_cost_usd")
    components.append(box_cost)
    known = sum(float(value) for value in components if isinstance(value, (int, float)))
    complete = all(isinstance(value, (int, float)) for value in components)
    return {
        "branch_inference": branch,
        "parent_inference": dict(parent),
        "sailboxes": dict(sailboxes),
        "known_cost_usd": round(known, 9),
        "total_cost_usd": round(known, 9) if complete else None,
        "cost_status": "estimated" if complete else "partial",
        "pricing_source": PRICING_SOURCE,
        "pricing_as_of": PRICING_AS_OF,
    }
