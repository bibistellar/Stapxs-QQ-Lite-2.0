from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "codex-session-merge.py"
SPEC = importlib.util.spec_from_file_location("codex_session_merge", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MERGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MERGE
SPEC.loader.exec_module(MERGE)


def write_session(root: Path, name: str, data: bytes, archived: bool = False) -> Path:
    tree = "archived_sessions" if archived else "sessions"
    target = root / tree / "2026" / "08" / "11" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target


class SessionMergeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.base = root / "base"
        self.remote = root / "remote"
        self.local = root / "local"
        self.output = root / "output"
        self.conflicts = root / "conflicts"
        for directory in (self.base, self.remote, self.local, self.output, self.conflicts):
            directory.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def merge(self, mode: str) -> dict[str, int]:
        shutil.copytree(self.remote, self.output, dirs_exist_ok=True)
        return MERGE.merge_sessions(
            self.base,
            self.remote,
            self.local,
            self.output,
            self.conflicts,
            mode,
        )

    def test_remote_update_and_new_local_session_merge_independently(self) -> None:
        first = "rollout-first.jsonl"
        second = "rollout-second.jsonl"
        write_session(self.base, first, b"base\n")
        write_session(self.remote, first, b"base\nremote\n")
        local_first = write_session(self.local, first, b"base\n")
        write_session(self.local, second, b"local-new\n")

        result = self.merge("pull")

        self.assertEqual(result["conflicts"], 0)
        self.assertEqual(local_first.read_bytes(), b"base\nremote\n")
        self.assertEqual(
            next(self.output.rglob(second)).read_bytes(),
            b"local-new\n",
        )

    def test_divergent_session_stays_isolated_while_new_sessions_merge(self) -> None:
        conflicted = "rollout-conflicted.jsonl"
        independent = "rollout-independent.jsonl"
        write_session(self.base, conflicted, b"base\n")
        write_session(self.remote, conflicted, b"base\nremote\n")
        local_conflicted = write_session(self.local, conflicted, b"base\nlocal\n")
        write_session(self.local, independent, b"new-session\n")

        first_result = self.merge("push")

        self.assertEqual(first_result["conflicts"], 1)
        self.assertEqual(next(self.output.rglob(conflicted)).read_bytes(), b"base\nremote\n")
        self.assertEqual(next(self.output.rglob(independent)).read_bytes(), b"new-session\n")
        self.assertEqual(local_conflicted.read_bytes(), b"base\nlocal\n")

        shutil.rmtree(self.base)
        shutil.copytree(self.remote, self.base)
        write_session(self.local, "rollout-third.jsonl", b"third\n")
        second_result = self.merge("push")

        self.assertEqual(second_result["conflicts"], 1)
        self.assertEqual(next(self.output.rglob(conflicted)).read_bytes(), b"base\nremote\n")
        self.assertEqual(next(self.output.rglob("rollout-third.jsonl")).read_bytes(), b"third\n")

    def test_local_continuation_of_remote_prefix_is_safe_to_push(self) -> None:
        name = "rollout-prefix.jsonl"
        write_session(self.base, name, b"base\n")
        write_session(self.remote, name, b"base\n")
        write_session(self.local, name, b"base\nlocal\n")

        result = self.merge("push")

        self.assertEqual(result["conflicts"], 0)
        self.assertEqual(next(self.output.rglob(name)).read_bytes(), b"base\nlocal\n")

    def test_archive_move_is_monotonic(self) -> None:
        name = "rollout-archived.jsonl"
        write_session(self.base, name, b"complete\n")
        write_session(self.remote, name, b"complete\n", archived=True)
        write_session(self.local, name, b"complete\n")

        result = self.merge("pull")

        self.assertEqual(result["conflicts"], 0)
        self.assertFalse(any((self.local / "sessions").rglob(name)))
        self.assertEqual(next((self.local / "archived_sessions").rglob(name)).read_bytes(), b"complete\n")


class StateSyncIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.remote = root / "remote.git"
        self.machine_a = root / "machine-a"
        self.machine_b = root / "machine-b"
        subprocess.run(["git", "init", "--bare", "--quiet", self.remote], check=True)
        for machine in (self.machine_a, self.machine_b):
            subprocess.run(["git", "init", "--quiet", machine], check=True)
            subprocess.run(
                ["git", "-C", machine, "remote", "add", "origin", self.remote],
                check=True,
            )
            (machine / ".codex-sync").mkdir()
            (machine / ".codex").mkdir()
            shutil.copy2(SCRIPT, machine / ".codex-sync" / SCRIPT.name)
            shutil.copy2(
                SCRIPT.with_name("codex-state-sync.sh"),
                machine / ".codex-sync" / "codex-state-sync.sh",
            )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def sync(self, machine: Path, action: str) -> str:
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(machine / ".codex")
        result = subprocess.run(
            [machine / ".codex-sync" / "codex-state-sync.sh", action],
            cwd=machine,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout

    def test_one_divergent_session_does_not_block_other_sessions(self) -> None:
        shared = "rollout-shared.jsonl"
        new_from_a = "rollout-new-a.jsonl"
        new_from_b = "rollout-new-b.jsonl"
        shared_a = write_session(self.machine_a / ".codex", shared, b"base\n")

        self.sync(self.machine_a, "push")
        self.sync(self.machine_b, "pull")
        shared_b = next((self.machine_b / ".codex").rglob(shared))

        shared_a.write_bytes(b"base\nmachine-a\n")
        shared_b.write_bytes(b"base\nmachine-b\n")
        self.sync(self.machine_b, "push")

        write_session(self.machine_a / ".codex", new_from_a, b"independent-a\n")
        self.sync(self.machine_a, "push")
        status_a = self.sync(self.machine_a, "status")
        self.assertIn("conflicts=1", status_a)

        self.sync(self.machine_b, "pull")
        self.assertEqual(shared_b.read_bytes(), b"base\nmachine-b\n")
        self.assertEqual(
            next((self.machine_b / ".codex").rglob(new_from_a)).read_bytes(),
            b"independent-a\n",
        )

        write_session(self.machine_b / ".codex", new_from_b, b"independent-b\n")
        self.sync(self.machine_b, "push")
        pending = self.machine_a / ".codex" / ".state-sync" / "pending" / "queued"
        pending.parent.mkdir(parents=True, exist_ok=True)
        pending.write_text("queued\n", encoding="utf-8")
        self.sync(self.machine_a, "pull")

        self.assertEqual(shared_a.read_bytes(), b"base\nmachine-a\n")
        self.assertEqual(
            next((self.machine_a / ".codex").rglob(new_from_b)).read_bytes(),
            b"independent-b\n",
        )
        final_status = self.sync(self.machine_a, "status")
        self.assertIn("pending=1", final_status)
        self.assertIn("conflicts=1", final_status)


if __name__ == "__main__":
    unittest.main()
