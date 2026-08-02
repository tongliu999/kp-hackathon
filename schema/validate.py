"""Validate runbooks and trajectories against the locked schemas.

"It looks right" is not done. Run this before handing anything off:

    .venv/bin/python schema/validate.py

Beyond JSON Schema it checks template resolution - that every {{name}} in a runbook
resolves to a declared slot or to a capture from an EARLIER step. That is the failure
mode a synthesized runbook actually hits (TON-21 lifting a value into a slot it never
declared), and JSON Schema cannot express it.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit("missing dep: .venv/bin/python -m pip install jsonschema")

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "schema"
# Mirrors _SLOT in src/runbook_voice/runbooks.py - keep the two in step.
TEMPLATE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _refs(value) -> list[str]:
    """Collect {{slot}} references from any JSON-like value, recursively.

    Arguments are nested objects and arrays, and substitute_slots walks all of
    them - so a check that only looked at top-level strings would miss most refs.
    """
    if isinstance(value, str):
        return TEMPLATE.findall(value)
    if isinstance(value, dict):
        return [r for v in value.values() for r in _refs(v)]
    if isinstance(value, list):
        return [r for v in value for r in _refs(v)]
    return []


def check_templates(runbook: dict) -> list[str]:
    """Every {{ref}} must resolve to a declared slot.

    This is the failure mode a synthesized runbook actually hits: TON-21 lifting a
    concrete value into a slot it never declared. At replay that raises
    SlotResolutionError mid-run - after earlier steps have already executed.
    """
    errors: list[str] = []
    declared = {s["name"] for s in runbook.get("slots", []) if "name" in s}

    for step in runbook.get("steps", []):
        sid = step.get("id", "?")
        for field in ("arguments", "confirmation_prompt"):
            for ref in _refs(step.get(field)):
                if ref not in declared:
                    errors.append(
                        f"step '{sid}'.{field}: {{{{{ref}}}}} is not a declared slot"
                    )
    return errors


def check_invariants(runbook: dict) -> list[str]:
    """Project rules that outlive any one schema version."""
    errors: list[str] = []
    irreversible = [s for s in runbook.get("steps", []) if s.get("irreversible")]

    for step in irreversible:
        prompt = step.get("confirmation_prompt") or ""
        # A readback with no templating names nothing specific - it is
        # "Confirm this restaurant booking", which Invariant 1 exists to prevent.
        if not TEMPLATE.search(prompt):
            errors.append(
                f"step '{step.get('id')}': confirmation_prompt names no specifics "
                f"(no {{{{slot}}}} refs) - Invariant 1 wants what/when/how many, "
                f"not 'shall I proceed?'"
            )
    if len(irreversible) > 1:
        errors.append(
            f"{len(irreversible)} irreversible steps. Expected at most one - "
            f"the demo books once, behind one gate."
        )
    return errors


def validate_dir(subdir: str, schema_name: str, extra_checks=None) -> tuple[int, int]:
    schema = json.loads((SCHEMA_DIR / schema_name).read_text())
    validator = Draft202012Validator(schema)
    files = sorted((ROOT / "fixtures" / subdir).glob("*.json"))
    if not files:
        print(f"  (no files in fixtures/{subdir})")
        return 0, 0

    passed = 0
    for path in files:
        doc = json.loads(path.read_text())
        errors = [
            f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
            for e in validator.iter_errors(doc)
        ]
        if extra_checks and not errors:
            errors += extra_checks(doc)

        if errors:
            print(f"  FAIL {path.name}")
            for err in errors:
                print(f"       {err}")
        else:
            print(f"  ok   {path.name}")
            passed += 1
    return passed, len(files)


def main() -> int:
    total_pass = total_all = 0

    print("runbooks (schema/runbook.schema.json)")
    p, n = validate_dir(
        "runbooks",
        "runbook.schema.json",
        lambda d: check_templates(d) + check_invariants(d),
    )
    total_pass, total_all = total_pass + p, total_all + n

    print("\ntrajectories (schema/trajectory.schema.json)")
    p, n = validate_dir("trajectories", "trajectory.schema.json")
    total_pass, total_all = total_pass + p, total_all + n

    print(f"\n{total_pass}/{total_all} valid")
    return 0 if total_pass == total_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
