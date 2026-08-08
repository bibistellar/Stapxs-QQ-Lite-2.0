#!/usr/bin/env python3
"""Validate an AI-generated patch without printing its contents."""

from __future__ import annotations

import re
import sys
from pathlib import PurePosixPath


DENIED_EXACT = {
    ".env",
    ".secrets",
    "AGENTS.md",
    ".github/local-actions.secrets",
}
DENIED_PREFIXES = (
    ".codex/",
    ".git/",
    ".github/workflows/",
)
MAX_FILES = 40
MAX_PATCH_BYTES = 1_000_000


def normalize(raw: str) -> str:
    value = raw.strip().split("\t", 1)[0]
    if value == "/dev/null":
        return value
    for prefix in ("a/", "b/", "baseline/", "work/"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("unsafe patch path")
    return path.as_posix()


def denied(path: str) -> bool:
    lowered = path.lower()
    return (
        path in DENIED_EXACT
        or path.startswith(DENIED_PREFIXES)
        or lowered.endswith(("/secrets.yaml", "/secrets.yml"))
        or lowered.endswith((".pem", ".key", ".p12", ".pfx"))
    )


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} PATCH", file=sys.stderr)
        return 2

    patch_path = sys.argv[1]
    data = open(patch_path, "rb").read()
    if len(data) > MAX_PATCH_BYTES:
        print("AI patch exceeds the configured size limit", file=sys.stderr)
        return 1
    if b"GIT binary patch" in data or b"Binary files " in data:
        print("AI patch contains unsupported binary changes", file=sys.stderr)
        return 1

    text = data.decode("utf-8", errors="strict")
    paths: set[str] = set()
    for match in re.finditer(r"^(?:---|\+\+\+) ([^\n]+)$", text, re.MULTILINE):
        path = normalize(match.group(1))
        if path != "/dev/null":
            paths.add(path)

    if not paths:
        print("AI patch contains no file changes", file=sys.stderr)
        return 1
    if len(paths) > MAX_FILES:
        print("AI patch changes too many files", file=sys.stderr)
        return 1

    blocked = sorted(path for path in paths if denied(path))
    if blocked:
        print("AI patch touches protected paths:", file=sys.stderr)
        for path in blocked:
            print(f"- {path}", file=sys.stderr)
        return 1

    print(f"AI patch scope accepted: files={len(paths)} bytes={len(data)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
