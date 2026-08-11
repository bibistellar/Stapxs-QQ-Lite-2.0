# Repository skills

Put repository-maintained Codex skills in one subdirectory per skill, each containing `SKILL.md`.
The direnv preflight and `SessionStart` hook refuse external user/admin skills and runtime skill or
plugin symlinks that escape repository-local `.codex`.

OpenAI's system-bundled skills remain part of the Codex CLI itself.
