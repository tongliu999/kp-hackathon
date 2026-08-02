from runbook_voice.branch_search_demo import build_parser


def test_branch_search_records_typed_input_by_default() -> None:
    args = build_parser().parse_args(["research a new workflow"])

    assert args.input_source == "typed"


def test_branch_search_accepts_voice_input_provenance() -> None:
    args = build_parser().parse_args(
        ["research a new workflow", "--input-source", "voice"]
    )

    assert args.input_source == "voice"
