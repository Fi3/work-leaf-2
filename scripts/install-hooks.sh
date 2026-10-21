#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
hooks_path=$(git config --get core.hooksPath || true)
if [ "$hooks_path" = '.githooks' ]; then
    printf '%s\n' 'The repository Git hooks are already installed.'
    exit 0
fi
if [ -n "$hooks_path" ]; then
    printf '%s\n' "Existing core.hooksPath is $hooks_path; no setting was changed." >&2
    printf '%s\n' 'Call this repository .githooks/pre-push from the existing pre-push hook.' >&2
    exit 1
fi
hooks_directory=$(git rev-parse --git-path hooks)
for hook in "$hooks_directory"/*; do
    [ -f "$hook" ] && [ -x "$hook" ] || continue
    case "$hook" in *.sample) continue ;; esac
    printf '%s\n' "Existing Git hook $hook would be hidden; no setting was changed." >&2
    printf '%s\n' 'Call this repository .githooks/pre-push from the existing pre-push hook.' >&2
    exit 1
done
git config --local core.hooksPath .githooks
printf '%s\n' 'Installed repository Git hooks. Push checks resource benchmark evidence.'
