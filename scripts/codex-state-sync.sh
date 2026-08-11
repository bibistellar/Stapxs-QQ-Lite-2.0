#!/usr/bin/env bash
set -euo pipefail

action="${1:-status}"
quiet=false
if [[ "${2:-}" == "--quiet" || "${1:-}" == "--quiet" ]]; then
  quiet=true
fi

repo_root="$(git rev-parse --show-toplevel)"
expected_codex_home="$repo_root/.codex"
codex_home="${CODEX_HOME:-$expected_codex_home}"
branch="${CODEX_HISTORY_BRANCH:-codex-history}"
remote="${CODEX_HISTORY_REMOTE:-origin}"
sync_dir="$expected_codex_home/.state-sync"
pending_dir="$sync_dir/pending"
conflict_dir="$sync_dir/conflicts"
last_synced_file="$sync_dir/last-synced-commit"
log_file="$sync_dir/sync.log"
lock_dir="$sync_dir/lock"
lock_acquired=false
temporary_dir=""

mkdir -p "$sync_dir" "$pending_dir" "$conflict_dir"

cleanup() {
  if [[ -n "$temporary_dir" && -d "$temporary_dir" ]]; then
    case "$(basename "$temporary_dir")" in
      codex-history-import.*|codex-history-export.*)
        find "$temporary_dir" -depth -delete 2>/dev/null || true
        ;;
    esac
  fi
  if [[ "$lock_acquired" == true ]]; then
    unlink "$lock_dir/pid" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}

trap cleanup EXIT

log_status() {
  local message="$1"
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >>"$log_file"
  if [[ "$quiet" != true ]]; then
    printf '%s\n' "$message"
  fi
}

canonical_dir() {
  (cd "$1" && pwd -P)
}

if [[ "$(canonical_dir "$codex_home")" != "$(canonical_dir "$expected_codex_home")" ]]; then
  log_status "refused: CODEX_HOME is not repository-local"
  exit 1
fi
if [[ ! "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ || "$branch" == *..* || "$branch" == */ ]]; then
  log_status "refused: invalid history branch name"
  exit 1
fi

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
  else
    local holder=""
    if [[ -f "$lock_dir/pid" ]]; then
      holder="$(sed -n '1p' "$lock_dir/pid")"
    fi
    if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      log_status "skipped: another state sync is active"
      exit 0
    fi
    unlink "$lock_dir/pid" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    if ! mkdir "$lock_dir" 2>/dev/null; then
      log_status "skipped: state sync lock is unavailable"
      exit 0
    fi
    printf '%s\n' "$$" >"$lock_dir/pid"
  fi
  lock_acquired=true
}

remote_head() {
  git ls-remote --heads "$remote" "refs/heads/$branch" 2>/dev/null | awk 'NR == 1 {print $1}'
}

fetch_history() {
  git fetch --quiet --no-tags "$remote" \
    "refs/heads/$branch:refs/remotes/$remote/$branch" >/dev/null 2>&1
}

extract_snapshot() {
  local commit="$1"
  local destination="$2"
  git archive "$commit" | tar -xf - -C "$destination"
  if [[ ! -f "$destination/CODEX_STATE_FORMAT" ]]; then
    log_status "failed: history snapshot format is missing"
    return 1
  fi
  local format
  format="$(sed -n '1p' "$destination/CODEX_STATE_FORMAT")"
  if [[ "$format" != "1" && "$format" != "2" ]]; then
    log_status "failed: unsupported history branch format"
    return 1
  fi
  mkdir -p "$destination/state"
}

import_history() {
  acquire_lock

  local head
  if ! head="$(remote_head)"; then
    log_status "failed pull: history branch lookup failed"
    return 1
  fi
  if [[ -z "$head" ]]; then
    log_status "pull: remote history branch is not initialized"
    return 0
  fi
  if ! fetch_history; then
    log_status "failed pull: history branch fetch failed"
    return 1
  fi

  local temporary
  temporary="$(mktemp -d "${TMPDIR:-/tmp}/codex-history-import.XXXXXX")"
  temporary_dir="$temporary"
  mkdir -p "$temporary/base/state" "$temporary/remote/state" "$temporary/output/state"
  extract_snapshot "refs/remotes/$remote/$branch" "$temporary/remote"

  local last_synced=""
  if [[ -f "$last_synced_file" ]]; then
    last_synced="$(sed -n '1p' "$last_synced_file")"
  fi
  if [[ -n "$last_synced" ]] && git cat-file -e "$last_synced^{commit}" 2>/dev/null; then
    extract_snapshot "$last_synced" "$temporary/base"
  fi

  rsync -a "$temporary/remote/state/" "$temporary/output/state/"
  local merge_result
  merge_result="$(python3 "$repo_root/scripts/codex-session-merge.py" \
    --mode pull \
    --base "$temporary/base/state" \
    --remote "$temporary/remote/state" \
    --local "$codex_home" \
    --output "$temporary/output/state" \
    --conflicts "$conflict_dir")"

  if ! find "$pending_dir" -type f -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
    rsync -a \
      --exclude='/sessions/' \
      --exclude='/archived_sessions/' \
      "$temporary/remote/state/" "$codex_home/"
  fi
  printf '%s\n' "$head" >"$last_synced_file"
  log_status "pull: reconciled session files $merge_result"
}

copy_optional_tree() {
  local name="$1"
  local destination="$2"
  if [[ -d "$codex_home/$name" ]]; then
    mkdir -p "$destination/$name"
    rsync -a --safe-links "$codex_home/$name/" "$destination/$name/"
  fi
}

snapshot_sqlite() {
  local source="$1"
  local destination="$2"
  python3 - "$source" "$destination" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=5)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
finally:
    destination.close()
    source.close()
PY
}

prepare_local_snapshot() {
  local destination="$1"
  mkdir -p "$destination"

  copy_optional_tree "sessions" "$destination"
  copy_optional_tree "archived_sessions" "$destination"
  copy_optional_tree "skills" "$destination"
  copy_optional_tree "plugins" "$destination"

  local file base
  for file in "$codex_home/history.jsonl" "$codex_home/.personality_migration"; do
    if [[ -f "$file" && ! -L "$file" ]]; then
      cp -p "$file" "$destination/"
    fi
  done
  for file in "$codex_home"/goals_*.sqlite "$codex_home"/memories_*.sqlite \
              "$codex_home"/state_*.sqlite; do
    if [[ -f "$file" && ! -L "$file" ]]; then
      base="$(basename "$file")"
      snapshot_sqlite "$file" "$destination/$base"
    fi
  done
}

write_snapshot_metadata() {
  local snapshot="$1"
  printf '1\n' >"$snapshot/CODEX_STATE_FORMAT"
  printf '%s\n' \
    'Repository-local Codex runtime snapshot.' \
    'Session rollout files are reconciled independently; divergent sessions are isolated locally.' \
    'This orphan branch may contain sensitive transcripts; repository visibility is user-managed.' \
    'Authentication, logs, caches, temporary files, and shell snapshots are excluded.' \
    >"$snapshot/README.md"
}

create_snapshot_commit() {
  local snapshot="$1"
  local index_file="$2"
  local parent="$3"
  GIT_INDEX_FILE="$index_file" GIT_WORK_TREE="$snapshot" git read-tree --empty
  GIT_INDEX_FILE="$index_file" GIT_WORK_TREE="$snapshot" git add -f --all
  local tree timestamp
  tree="$(GIT_INDEX_FILE="$index_file" git write-tree)"
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [[ -n "$parent" ]]; then
    printf 'Codex state snapshot %s\n' "$timestamp" | \
      GIT_AUTHOR_NAME='Codex State Sync' \
      GIT_AUTHOR_EMAIL='codex-state@local.invalid' \
      GIT_COMMITTER_NAME='Codex State Sync' \
      GIT_COMMITTER_EMAIL='codex-state@local.invalid' \
      git -c commit.gpgsign=false commit-tree "$tree" -p "$parent"
  else
    printf 'Codex state snapshot %s\n' "$timestamp" | \
      GIT_AUTHOR_NAME='Codex State Sync' \
      GIT_AUTHOR_EMAIL='codex-state@local.invalid' \
      GIT_COMMITTER_NAME='Codex State Sync' \
      GIT_COMMITTER_EMAIL='codex-state@local.invalid' \
      git -c commit.gpgsign=false commit-tree "$tree"
  fi
}

export_history() {
  acquire_lock

  local temporary snapshot local_snapshot index_file
  temporary="$(mktemp -d "${TMPDIR:-/tmp}/codex-history-export.XXXXXX")"
  temporary_dir="$temporary"
  snapshot="$temporary/worktree"
  local_snapshot="$temporary/local-state"
  index_file="$temporary/index"
  prepare_local_snapshot "$local_snapshot"

  local attempt=1 max_attempts=4
  while [[ "$attempt" -le "$max_attempts" ]]; do
    find "$snapshot" -mindepth 1 -depth -delete 2>/dev/null || true
    find "$temporary/base" -mindepth 1 -depth -delete 2>/dev/null || true
    find "$temporary/remote" -mindepth 1 -depth -delete 2>/dev/null || true
    mkdir -p "$snapshot/state" "$temporary/base/state" "$temporary/remote/state"

    local head=""
    if ! head="$(remote_head)"; then
      log_status "failed push: history branch lookup failed"
      return 1
    fi
    if [[ -n "$head" ]]; then
      if ! fetch_history; then
        log_status "failed push: history branch fetch failed"
        return 1
      fi
      extract_snapshot "refs/remotes/$remote/$branch" "$temporary/remote"
      rsync -a "$temporary/remote/state/" "$snapshot/state/"
    fi

    local last_synced=""
    if [[ -f "$last_synced_file" ]]; then
      last_synced="$(sed -n '1p' "$last_synced_file")"
    fi
    if [[ -n "$last_synced" ]] && git cat-file -e "$last_synced^{commit}" 2>/dev/null; then
      extract_snapshot "$last_synced" "$temporary/base"
    fi

    rsync -a \
      --exclude='/sessions/' \
      --exclude='/archived_sessions/' \
      "$local_snapshot/" "$snapshot/state/"
    local merge_result
    merge_result="$(python3 "$repo_root/scripts/codex-session-merge.py" \
      --mode push \
      --base "$temporary/base/state" \
      --remote "$temporary/remote/state" \
      --local "$codex_home" \
      --output "$snapshot/state" \
      --conflicts "$conflict_dir")"
    write_snapshot_metadata "$snapshot"

    local commit
    commit="$(create_snapshot_commit "$snapshot" "$index_file" "$head")"
    local pushed=false
    if [[ -n "$head" ]]; then
      if GIT_TERMINAL_PROMPT=0 git push --quiet \
        --force-with-lease="refs/heads/$branch:$head" \
        "$remote" "$commit:refs/heads/$branch"; then
        pushed=true
      fi
    elif GIT_TERMINAL_PROMPT=0 git push --quiet "$remote" "$commit:refs/heads/$branch"; then
      pushed=true
    fi

    if [[ "$pushed" == true ]]; then
      printf '%s\n' "$commit" >"$last_synced_file"
      find "$pending_dir" -type f -maxdepth 1 -delete 2>/dev/null || true
      log_status "push: reconciled session files $merge_result"
      return 0
    fi
    attempt=$((attempt + 1))
  done

  log_status "failed push: remote history changed during reconciliation"
  return 1
}

show_status() {
  local head pending=0 conflicts=0 last_synced="none"
  head="$(remote_head)"
  if [[ -f "$last_synced_file" ]]; then
    last_synced="$(sed -n '1p' "$last_synced_file")"
  fi
  pending="$(find "$pending_dir" -type f -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
  conflicts="$(find "$conflict_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  printf 'branch=%s\nremote_head=%s\nlast_synced=%s\npending=%s\nconflicts=%s\n' \
    "$branch" "${head:-none}" "$last_synced" "$pending" "$conflicts"
}

case "$action" in
  pull)
    import_history
    ;;
  push)
    export_history
    ;;
  status)
    show_status
    ;;
  *)
    printf 'usage: %s {pull|push|status} [--quiet]\n' "$0" >&2
    exit 2
    ;;
esac
