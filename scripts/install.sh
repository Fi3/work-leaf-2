#!/bin/sh
set -eu
prefix=${1:?Usage: sh scripts/install.sh ABSOLUTE_PREFIX}
case "$prefix" in /*) ;; *) echo 'The installation prefix must be absolute.' >&2; exit 2;; esac
test "$(node --version)" = 'v26.10.0'
test "$(npm --version)" = '12.2.0'
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
cargo build --locked --release
mkdir -p "$prefix/bin" "$prefix/share/harness/adapter" "$prefix/share/harness/nvim"
install -m 0755 target/release/harness "$prefix/bin/harness"
cp package.json package-lock.json "$prefix/share/harness/"
cp adapter/*.mjs "$prefix/share/harness/adapter/"
cp -R lua plugin "$prefix/share/harness/nvim/"
npm ci --ignore-scripts --omit=dev --prefix "$prefix/share/harness"
printf 'Installed %s/bin/harness\n' "$prefix"
