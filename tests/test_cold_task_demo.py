import pytest

from runbook_voice.cold_task_demo import build_parser, main, run_demo
from runbook_voice.cold_tasks import JobStatus


def test_demo_parser_keeps_three_minute_default_configurable() -> None:
    args = build_parser().parse_args(["a request"])

    assert args.delay == 180.0


@pytest.mark.asyncio
async def test_demo_runs_multiple_utterances_with_near_zero_delay(capsys) -> None:
    jobs = await run_demo(["first", "second"], delay=0.001)

    assert [job.status for job in jobs] == [JobStatus.SUCCEEDED, JobStatus.SUCCEEDED]
    output = capsys.readouterr().out
    assert output.count("I'll get back to you.") == 2
    assert output.count("conversation is free for another utterance") == 2
    assert "Your result is ready" in output


def test_demo_cli_reports_success(capsys) -> None:
    assert main(["request", "--delay", "0"]) == 0
    output = capsys.readouterr().out
    assert "[released " in output
    assert "[succeeded " in output
