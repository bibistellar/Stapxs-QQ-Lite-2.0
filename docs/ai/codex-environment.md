# Repository-local Codex environment

This repository uses direnv so plain `codex` invocations use repository-local state. A root `.env`
is deliberately not sourced because application credentials are unrelated to Codex startup.

## One-time machine setup

Install Git, Python 3.9+, rsync, direnv, and Codex. Add the appropriate direnv shell hook. For zsh:

```zsh
eval "$(direnv hook zsh)"
```

After cloning the repository, review and allow `.envrc`:

```zsh
direnv allow
```

Entering the repository exports both `CODEX_HOME` and `CODEX_SQLITE_HOME` as `.codex`. Run `codex`
or resume normally. Authentication is machine-local and excluded from synchronization; use
`codex login` once inside this environment on each machine.

## Isolation and skills

Configuration, sessions, SQLite state, memories, history, installed skills, and plugins use the
repository-local `.codex`. Repository-authored skills belong under `.agents/skills/`.

Codex also discovers user skills from `$HOME/.agents/skills` and admin skills from
`/etc/codex/skills`. Direnv refuses activation if either contains a skill or if a skill/plugin
symlink under `.codex` escapes the local home. `SessionStart` repeats the check. OpenAI-bundled
system skills remain part of the CLI.

Project hooks require one-time trust. Open `/hooks`, review `.codex/hooks.json`, trust the commands,
exit, and restart Codex before model work. Changed definitions require review again.

## File placement and shell requirements

Codex-discovered configuration remains in `.codex/config.toml` and `.codex/hooks.json`. Direnv must
remain at the repository root as `.envrc`. Implementation scripts and their tests are isolated from
application scripts under `.codex-sync/`:

```text
.codex-sync/
  codex-lifecycle-hook.py
  codex-session-merge.py
  codex-state-sync.sh
  tests/
```

The sync command targets Bash 3.2+ on macOS and Linux and requires Git, Python 3.9+, and `rsync`.
It uses `set -euo pipefail`, quotes repository paths, and resolves the Git root because hooks inherit
the session working directory and may start below the repository root. Matching hooks can run
concurrently, so the sync script serializes local work with a PID lock. Codex does not currently run
command hooks asynchronously; the short lifecycle hook therefore starts the longer push as a
detached Python subprocess. Native Windows needs a separate `commandWindows` implementation and
equivalent sync dependencies; use WSL for the Bash version. After `.envrc` changes, review it and run
`direnv allow` again.

## History synchronization

The independent `codex-history` branch contains portable runtime state and has an orphan root, so
its commits never enter main history. Authentication, logs, caches, temporary files, model metadata,
and shell snapshots are excluded.

Directory entry reconciles remote session files before Codex starts. Each main-thread `Stop` queues
an asynchronous snapshot; `SessionEnd` is a fallback. Rollout files use a three-way comparison with
the last imported commit. Equal files and prefix-only continuations merge automatically. If the same
session diverged on two machines, only that rollout is kept local and recorded under the ignored
`.codex/.state-sync/conflicts/` directory; unrelated sessions continue to pull and push. Pushes use a
remote-head lease and retry when another machine wins the race. Repository visibility does not block
synchronization.

Portable non-session state remains snapshot-based. When a session snapshot is pending, pull leaves
that global state local but still reconciles independent rollout files. A successful push clears the
event queue; unresolved rollout conflicts remain visible in `status` until their contents become a
safe prefix continuation or are resolved manually.

Inspect or retry synchronization without displaying transcript contents:

```zsh
.codex-sync/codex-state-sync.sh status
.codex-sync/codex-state-sync.sh pull
.codex-sync/codex-state-sync.sh push
```

`status` reports both `pending` hook events and isolated `conflicts`. A non-zero conflict count does
not block new sessions.

Messages are stored in ignored `.codex/.state-sync/sync.log`. A public repository also exposes the
history branch, which may contain sensitive transcripts and SQLite state; choose visibility according
to your own disclosure policy.
