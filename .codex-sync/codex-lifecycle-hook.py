#!/usr/bin/env python3
"""Enforce project-local Codex state and queue state-branch snapshots."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


def emit(payload: dict[str, object]) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


def repository_root() -> Path:
    configured = os.environ.get("REPO_CODEX_ROOT")
    if configured:
        return Path(configured).resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(result.stdout.strip()).resolve()


def external_skill_count(root: Path) -> int:
    locations = (Path.home() / ".agents" / "skills", Path("/etc/codex/skills"))
    count = 0
    for location in locations:
        try:
            resolved = location.resolve()
        except OSError:
            continue
        if resolved == root or root in resolved.parents or not resolved.is_dir():
            continue
        try:
            count += sum(1 for path in resolved.rglob("SKILL.md") if path.is_file())
        except OSError:
            count += 1
    return count


def escaping_runtime_links(codex_home: Path) -> int:
    count = 0
    for name in ("skills", "plugins"):
        base = codex_home / name
        if not base.exists():
            continue
        try:
            for candidate in base.rglob("*"):
                if not candidate.is_symlink():
                    continue
                try:
                    target = candidate.resolve(strict=True)
                except OSError:
                    count += 1
                    continue
                if target != codex_home and codex_home not in target.parents:
                    count += 1
        except OSError:
            count += 1
    return count


def verify_isolation(root: Path) -> list[str]:
    failures: list[str] = []
    expected = (root / ".codex").resolve()
    for variable in ("CODEX_HOME", "CODEX_SQLITE_HOME"):
        value = os.environ.get(variable)
        if not value or Path(value).resolve() != expected:
            failures.append(f"{variable} is not repository-local")

    external = external_skill_count(root)
    if external:
        failures.append(f"{external} external user/admin skill(s) would be discoverable")

    escaping = escaping_runtime_links(expected)
    if escaping:
        failures.append(f"{escaping} runtime skill/plugin symlink(s) escape CODEX_HOME")
    return failures


def safe_identifier(value: object, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", value)[:128]
    return cleaned or fallback


def queue_snapshot(root: Path, event: dict[str, object]) -> None:
    state_dir = root / ".codex" / ".state-sync"
    pending_dir = state_dir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)

    session_id = safe_identifier(event.get("session_id"), "session")
    turn_id = safe_identifier(event.get("turn_id"), "end")
    target = pending_dir / f"{session_id}-{turn_id}"
    fd, temporary = tempfile.mkstemp(prefix="pending-", dir=pending_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(datetime.now(timezone.utc).isoformat())
            handle.write("\n")
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

    subprocess.Popen(
        [str(root / ".codex-sync" / "codex-state-sync.sh"), "push", "--quiet"],
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def main() -> int:
    if sys.argv[1:] == ["--check"]:
        try:
            failures = verify_isolation(repository_root())
        except (OSError, subprocess.SubprocessError):
            failures = ["repository root could not be verified"]
        if failures:
            sys.stderr.write("Codex isolation preflight failed: ")
            sys.stderr.write("; ".join(failures))
            sys.stderr.write("\n")
            return 1
        return 0

    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError("hook input must be an object")
        root = repository_root()
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        emit({"continue": False, "stopReason": f"Codex isolation hook failed: {type(exc).__name__}"})
        return 0

    event_name = event.get("hook_event_name")
    if event_name == "SessionStart":
        failures = verify_isolation(root)
        if failures:
            emit(
                {
                    "continue": False,
                    "stopReason": "Repository-local Codex isolation check failed.",
                    "systemMessage": "; ".join(failures),
                }
            )
            return 0
        emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": (
                        "Repository-local Codex isolation is active. Read the repository's durable "
                        "agent instructions and current handoff before material work; keep runtime "
                        "state off the main branch."
                    ),
                }
            }
        )
        return 0

    if event_name in {"Stop", "SessionEnd"}:
        try:
            queue_snapshot(root, event)
        except OSError:
            emit({"systemMessage": "Codex history snapshot could not be queued."})
            return 0
        emit({})
        return 0

    emit({})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
