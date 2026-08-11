# Project-local Codex files

Direnv points both Codex state roots at this directory. Lifecycle hooks archive portable state to
the independent `codex-history` branch.

Codex discovers configuration from this directory, so the main branch tracks only stable config
files here:

- `README.md`
- `config.toml`
- `hooks.json`

Synchronization implementation and tests live separately under the root `.codex-sync/` directory.

Authentication stays machine-local. Session rollout files are reconciled independently, while
SQLite state, memories, history, skills, and plugins remain part of the portable snapshot. A
divergent session is isolated without blocking unrelated sessions. Logs, caches, temporary files,
model metadata, and shell snapshots are excluded. See `docs/ai/codex-environment.md` for setup and
recovery.
