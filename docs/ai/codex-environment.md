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

## History synchronization

The independent `codex-history` branch contains portable runtime state and has an orphan root, so
its commits never enter main history. Authentication, logs, caches, temporary files, model metadata,
and shell snapshots are excluded.

Directory entry imports a newer remote snapshot before Codex starts. Each main-thread `Stop` queues
an asynchronous snapshot; `SessionEnd` is a fallback. Pending local state prevents import, and push
refuses to overwrite a newer remote head. Repository visibility does not block synchronization.

Inspect or retry synchronization without displaying transcript contents:

```zsh
scripts/codex-state-sync.sh status
scripts/codex-state-sync.sh pull
scripts/codex-state-sync.sh push
```

Messages are stored in ignored `.codex/.state-sync/sync.log`. A public repository also exposes the
history branch, which may contain sensitive transcripts and SQLite state; choose visibility according
to your own disclosure policy.
