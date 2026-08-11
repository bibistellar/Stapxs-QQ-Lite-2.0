# Project-local Codex files

Direnv points both Codex state roots at this directory. Lifecycle hooks archive portable state to
the independent `codex-history` branch.

The main branch tracks only stable files here:

- `README.md`
- `config.toml`
- `hooks.json`

Authentication stays machine-local. Session rollout files are reconciled independently, while
SQLite state, memories, history, skills, and plugins remain part of the portable snapshot. A
divergent session is isolated without blocking unrelated sessions. Logs, caches, temporary files,
model metadata, and shell snapshots are excluded. See `docs/ai/codex-environment.md` for setup and
recovery.
