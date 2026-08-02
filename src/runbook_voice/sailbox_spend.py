"""Read observed Sailbox spend without making run completion depend on billing."""

from __future__ import annotations

import json
from typing import Any, Callable, Sequence
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SPEND_ENDPOINT = "https://sailbox-api.sailresearch.com/v1/sailboxes/spend"
SPEND_SOURCE = "https://docs.sailresearch.com/api-reference/usage/get-sailbox-spend"


def get_sailbox_spend(
    *,
    api_key: str,
    sailbox_ids: Sequence[str],
    started_at: str,
    ended_at: str,
    opener: Callable[..., Any] = urlopen,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Return exact/estimated spend for named boxes, failing open if unavailable."""
    items: list[dict[str, Any]] = []
    errors = 0
    for sailbox_id in dict.fromkeys(identifier for identifier in sailbox_ids if identifier):
        query = urlencode({"from": started_at, "to": ended_at, "sailbox_id": sailbox_id})
        request = Request(
            f"{SPEND_ENDPOINT}?{query}",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        try:
            with opener(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            nanos = payload.get("estimated_total_cost_usd_nanos")
            if nanos is None:
                nanos = payload.get("finalized_cost_usd_nanos")
            if nanos is None:
                raise ValueError("spend response omitted total cost")
            items.append(
                {
                    "sailbox_id": sailbox_id,
                    "cost_usd": round(int(nanos) / 1_000_000_000, 9),
                    "duration_seconds": float(payload.get("duration_seconds", 0)),
                    "finalized_cost_usd": round(int(payload.get("finalized_cost_usd_nanos", 0)) / 1_000_000_000, 9),
                    "estimated_active_cost_usd": round(int(payload.get("estimated_active_cost_usd_nanos", 0)) / 1_000_000_000, 9),
                }
            )
        except Exception:
            errors += 1

    if not items:
        return {
            "status": "unavailable",
            "sailbox_count": len(tuple(dict.fromkeys(sailbox_ids))),
            "source": SPEND_SOURCE,
            "note": "Sailbox spend could not be read; model costs remain available.",
        }
    return {
        "status": "estimated" if any(item["estimated_active_cost_usd"] for item in items) else "finalized",
        "sailbox_count": len(items),
        "total_cost_usd": round(sum(item["cost_usd"] for item in items), 9),
        "duration_seconds": round(sum(item["duration_seconds"] for item in items), 3),
        "items": items,
        "source": SPEND_SOURCE,
        **({"unavailable_count": errors} if errors else {}),
    }
