# Codex state synchronization

This hidden root directory contains repository-portability implementation, separate from product
scripts. Codex-discovered configuration stays in `.codex/`, while direnv configuration stays in the
root `.envrc`.

- `codex-lifecycle-hook.py` validates repository-local isolation and queues background pushes.
- `codex-state-sync.sh` pulls, snapshots, leases, retries, and reports synchronization status.
- `codex-session-merge.py` reconciles each rollout independently and isolates true divergence.
- `tests/` covers three-way merge, archival movement, pending work, and two-machine contention.

Run `./codex-state-sync.sh status` from this directory or `.codex-sync/codex-state-sync.sh status`
from the repository root. The Bash implementation supports macOS/Linux; see
`docs/ai/codex-environment.md` for dependencies, hook placement, trust, and Windows notes.
