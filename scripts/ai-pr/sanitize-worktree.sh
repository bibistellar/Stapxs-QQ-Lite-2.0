#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE DESTINATION" >&2
  exit 2
fi

source_dir=$1
destination=$2

test -d "$source_dir"
mkdir -p "$destination"

rsync -a --delete \
  --exclude='/.git/' \
  --exclude='/**/.git' \
  --exclude='/.codex/' \
  --exclude='/.env' \
  --exclude='/**/secrets.yaml' \
  --exclude='/**/secrets.yml' \
  --exclude='/.secrets' \
  --exclude='/.github/local-actions.secrets' \
  "$source_dir/" "$destination/"

find "$destination" -type l -delete
