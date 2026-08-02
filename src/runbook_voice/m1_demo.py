"""M1 warm-path proof orchestration with injected live adapters."""

from __future__ import annotations

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
import json
import re
import sys
from typing import Any, Protocol

from .dialogue import DialogueOutcome, DialogueStatus, SlotFillingDialogue
from .executor import ConfirmationRequest, ExecutionResult, ExecutionStatus, RunbookExecutor


class SpokenConfirmationInput(Protocol):
    async def listen(self) -> str: ...


class SpokenConfirmationOutput(Protocol):
    async def say(self, text: str) -> None: ...


class ExactYesConfirmationGate:
    """Fail closed: approve only bare yes or the locked stage response."""

    def __init__(self, confirmation_input: SpokenConfirmationInput, confirmation_output: SpokenConfirmationOutput) -> None:
        self._input = confirmation_input
        self._output = confirmation_output

    async def confirm(self, request: ConfirmationRequest) -> bool:
        details = json.dumps(dict(request.resolved_arguments), sort_keys=True)
        await self._output.say(f"{request.prompt}: {details}. Say yes to proceed.")
        try:
            reply = await self._input.listen()
        except Exception:
            return False
        if not isinstance(reply, str):
            return False
        normalized = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", reply.casefold())).strip()
        return normalized in {"yes", "yes book it"}


class WarmPathStatus(str, Enum):
    NO_MATCH = "no_match"
    DIALOGUE_FAILED = "dialogue_failed"
    SUCCEEDED = "succeeded"
    EXECUTION_FAILED = "execution_failed"
    CONFIRMATION_REJECTED = "confirmation_rejected"


@dataclass(frozen=True, slots=True)
class WarmPathOutcome:
    status: WarmPathStatus
    dialogue: DialogueOutcome
    execution: ExecutionResult | None = None


class M1WarmPath:
    """Join intent/slots directly to replay; no cold-search component exists here."""

    def __init__(self, dialogue: SlotFillingDialogue, executor: RunbookExecutor) -> None:
        self._dialogue = dialogue
        self._executor = executor

    async def run(self, utterance: str, prefilled_slots: Mapping[str, Any] | None = None) -> WarmPathOutcome:
        dialogue = self._dialogue.run(utterance, prefilled_slots)
        if dialogue.status is DialogueStatus.NO_MATCH:
            return WarmPathOutcome(WarmPathStatus.NO_MATCH, dialogue)
        if dialogue.status is not DialogueStatus.READY or dialogue.invocation is None:
            return WarmPathOutcome(WarmPathStatus.DIALOGUE_FAILED, dialogue)
        invocation = dialogue.invocation
        execution = await self._executor.execute(invocation.runbook, invocation.slot_values)
        status = {
            ExecutionStatus.SUCCEEDED: WarmPathStatus.SUCCEEDED,
            ExecutionStatus.CONFIRMATION_REJECTED: WarmPathStatus.CONFIRMATION_REJECTED,
            ExecutionStatus.FAILED: WarmPathStatus.EXECUTION_FAILED,
        }[execution.status]
        return WarmPathOutcome(status, dialogue, execution)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate readiness for the real M1 booking proof.")
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args(argv)
    if args.live:
        print("REFUSED: production TON-11 booking and TON-12 confirmation adapters are not configured.", file=sys.stderr)
        return 2
    print("Offline proof only; --live fails closed until external adapters are installed.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
