import json

from runbook_voice.sailbox_spend import get_sailbox_spend


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def test_sailbox_spend_aggregates_observed_cost_and_duration() -> None:
    def opener(request, timeout):
        assert request.headers["Authorization"] == "Bearer sk-test"
        assert "sailbox_id=sb-" in request.full_url
        assert timeout == 3
        return Response({
            "estimated_total_cost_usd_nanos": 2_500_000,
            "finalized_cost_usd_nanos": 2_000_000,
            "estimated_active_cost_usd_nanos": 500_000,
            "duration_seconds": 12,
        })

    result = get_sailbox_spend(
        api_key="sk-test",
        sailbox_ids=["sb-a", "sb-b"],
        started_at="2026-08-02T00:00:00Z",
        ended_at="2026-08-02T00:01:00Z",
        opener=opener,
        timeout=3,
    )

    assert result["status"] == "estimated"
    assert result["sailbox_count"] == 2
    assert result["total_cost_usd"] == 0.005
    assert result["duration_seconds"] == 24


def test_sailbox_spend_fails_open_when_usage_is_not_authorized() -> None:
    def opener(_request, **_kwargs):
        raise PermissionError("forbidden")

    result = get_sailbox_spend(
        api_key="sk-test",
        sailbox_ids=["sb-a"],
        started_at="2026-08-02T00:00:00Z",
        ended_at="2026-08-02T00:01:00Z",
        opener=opener,
    )

    assert result["status"] == "unavailable"
    assert "total_cost_usd" not in result
