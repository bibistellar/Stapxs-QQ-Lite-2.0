#!/usr/bin/env python3
"""Validate the bounded JSON verdict emitted by the review agent."""

from __future__ import annotations

import json
import re
import sys


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    if len(sys.argv) != 3:
        return fail(f"usage: {sys.argv[0]} REVIEW_JSON EXPECTED_SHA")

    try:
        payload = json.load(open(sys.argv[1], encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return fail(f"invalid review JSON: {type(exc).__name__}")

    expected_keys = {
        "schema_version",
        "head_sha",
        "verdict",
        "blocking_findings",
        "summary",
        "confidence",
    }
    if set(payload) != expected_keys:
        return fail("review JSON has unexpected fields")
    if payload["schema_version"] != 1:
        return fail("unsupported review schema")
    if payload["head_sha"] != sys.argv[2] or not re.fullmatch(
        r"[0-9a-f]{40}", payload["head_sha"]
    ):
        return fail("review head SHA does not match")
    if payload["verdict"] not in {"approve", "changes_requested"}:
        return fail("invalid review verdict")
    findings = payload["blocking_findings"]
    if not isinstance(findings, list) or len(findings) > 10:
        return fail("invalid blocking findings")
    if any(not isinstance(item, str) or not item or len(item) > 1000 for item in findings):
        return fail("invalid blocking finding")
    if payload["verdict"] == "approve" and findings:
        return fail("approved review cannot contain blocking findings")
    if payload["verdict"] == "changes_requested" and not findings:
        return fail("changes-requested review must contain a blocking finding")
    if not isinstance(payload["summary"], str) or not payload["summary"] or len(payload["summary"]) > 4000:
        return fail("invalid review summary")
    confidence = payload["confidence"]
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        return fail("invalid review confidence")

    print(f"review accepted: verdict={payload['verdict']} findings={len(findings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
