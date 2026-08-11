#!/usr/bin/env python3
"""Three-way merge Codex rollout files without exposing transcript contents."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import os
import shutil
import tempfile


SESSION_TREES = ("sessions", "archived_sessions")


@dataclass(frozen=True)
class SessionFile:
    path: str
    data: bytes


def session_files(root: Path) -> dict[str, SessionFile]:
    result: dict[str, SessionFile] = {}
    for tree in SESSION_TREES:
        directory = root / tree
        if not directory.is_dir():
            continue
        for candidate in directory.rglob("*.jsonl"):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            relative = candidate.relative_to(root).as_posix()
            identity = candidate.name
            entry = SessionFile(relative, candidate.read_bytes())
            previous = result.get(identity)
            if previous is not None and previous.path != relative:
                raise RuntimeError(f"duplicate session filename: {identity}")
            result[identity] = entry
    return result


def digest(data: bytes | None) -> str | None:
    if data is None:
        return None
    return hashlib.sha256(data).hexdigest()


def conflict_directory(root: Path, identity: str) -> Path:
    return root / hashlib.sha256(identity.encode("utf-8")).hexdigest()


def atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def remove_identity(root: Path, entries: tuple[SessionFile | None, ...]) -> None:
    for entry in entries:
        if entry is None:
            continue
        target = root / entry.path
        if target.is_file() and not target.is_symlink():
            target.unlink()


def chosen_path(
    chosen: bytes,
    base: SessionFile | None,
    remote: SessionFile | None,
    local: SessionFile | None,
) -> str:
    matching = [entry for entry in (local, remote, base) if entry is not None and entry.data == chosen]
    archived = [entry for entry in matching if entry.path.startswith("archived_sessions/")]
    if archived:
        return archived[0].path

    if base is not None:
        if local is not None and remote is not None:
            if local.path == base.path and remote.path != base.path:
                return remote.path
            if remote.path == base.path and local.path != base.path:
                return local.path

    if local is not None and local.data == chosen:
        return local.path
    if remote is not None and remote.data == chosen:
        return remote.path
    if base is not None:
        return base.path
    raise RuntimeError("chosen session has no path")


def compatible_choice(
    base: SessionFile | None,
    remote: SessionFile | None,
    local: SessionFile | None,
    mode: str,
) -> tuple[bytes | None, bool]:
    base_data = base.data if base else None
    remote_data = remote.data if remote else None
    local_data = local.data if local else None

    if local_data is None:
        return remote_data if remote_data is not None else base_data, False
    if remote_data is None:
        return local_data, False
    if local_data == remote_data:
        return local_data, False
    if base_data is not None and local_data == base_data:
        return remote_data, False
    if base_data is not None and remote_data == base_data:
        return local_data, False
    if local_data.startswith(remote_data):
        return local_data, False
    if remote_data.startswith(local_data):
        if mode == "pull":
            return remote_data, False
        return remote_data, True
    return remote_data, True


def record_conflict(
    root: Path,
    identity: str,
    base: SessionFile | None,
    remote: SessionFile | None,
    local: SessionFile | None,
) -> None:
    directory = conflict_directory(root, identity)
    directory.mkdir(parents=True, exist_ok=True)
    metadata = {
        "session_file": identity,
        "base_path": base.path if base else None,
        "remote_path": remote.path if remote else None,
        "local_path": local.path if local else None,
        "base_sha256": digest(base.data if base else None),
        "remote_sha256": digest(remote.data if remote else None),
        "local_sha256": digest(local.data if local else None),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }
    atomic_write(
        directory / "metadata.json",
        (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )
    if remote is not None:
        atomic_write(directory / "remote.jsonl", remote.data)
    if local is not None:
        atomic_write(directory / "local.jsonl", local.data)


def clear_conflict(root: Path, identity: str) -> None:
    directory = conflict_directory(root, identity)
    if directory.is_dir():
        shutil.rmtree(directory)


def merge_sessions(
    base_root: Path,
    remote_root: Path,
    local_root: Path,
    output_root: Path,
    conflicts_root: Path,
    mode: str,
) -> dict[str, int]:
    base_files = session_files(base_root)
    remote_files = session_files(remote_root)
    local_files = session_files(local_root)
    conflicts_root.mkdir(parents=True, exist_ok=True)

    merged = 0
    imported = 0
    conflicted = 0
    identities = sorted(set(base_files) | set(remote_files) | set(local_files))
    for identity in identities:
        base = base_files.get(identity)
        remote = remote_files.get(identity)
        local = local_files.get(identity)
        previous_conflict = conflict_directory(conflicts_root, identity).is_dir()
        if (
            previous_conflict
            and local is not None
            and remote is not None
            and local.data != remote.data
            and not local.data.startswith(remote.data)
            and not (mode == "pull" and remote.data.startswith(local.data))
        ):
            chosen, is_conflict = remote.data, True
        else:
            chosen, is_conflict = compatible_choice(base, remote, local, mode)

        remove_identity(output_root, (base, remote, local))
        if is_conflict:
            conflicted += 1
            if remote is not None:
                atomic_write(output_root / remote.path, remote.data)
            record_conflict(conflicts_root, identity, base, remote, local)
            continue

        clear_conflict(conflicts_root, identity)
        if chosen is None:
            continue
        destination = chosen_path(chosen, base, remote, local)
        atomic_write(output_root / destination, chosen)
        merged += 1

        should_apply = mode == "pull" or local is None
        local_is_current = (
            local is not None and local.path == destination and local.data == chosen
        )
        if should_apply and not local_is_current:
            remove_identity(local_root, (local,))
            atomic_write(local_root / destination, chosen)
            imported += 1

    return {
        "sessions": len(identities),
        "merged": merged,
        "imported": imported,
        "conflicts": conflicted,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--remote", type=Path, required=True)
    parser.add_argument("--local", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--conflicts", type=Path, required=True)
    parser.add_argument("--mode", choices=("pull", "push"), required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = merge_sessions(
        args.base,
        args.remote,
        args.local,
        args.output,
        args.conflicts,
        args.mode,
    )
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
