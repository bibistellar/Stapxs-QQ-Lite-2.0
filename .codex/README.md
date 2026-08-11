# Project-local Codex files

Direnv points both Codex state roots at this directory. Lifecycle hooks archive portable state to
the independent `codex-history` branch.

The main branch tracks only stable files here:

- `README.md`
- `config.toml`
- `hooks.json`

Authentication stays machine-local. Sessions, SQLite state, memories, history, skills, and plugins
are synchronized by `scripts/codex-state-sync.sh`; logs, caches, temporary files, model metadata,
and shell snapshots are excluded. See `docs/ai/codex-environment.md` for setup and recovery.
