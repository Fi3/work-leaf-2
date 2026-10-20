#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1-}" = ssh ]; then
    shift
    (cd "$root" && cargo build --quiet --locked --target-dir "$root/target")
    exec "$root/target/debug/harness" ssh "$@"
fi
if [ ! -f "$root/node_modules/@earendil-works/pi-durable/package.json" ]; then
    npm ci --ignore-scripts --prefix "$root"
fi
(cd "$root" && cargo build --quiet --locked --target-dir "$root/target")
exec "$root/target/debug/harness" nvim "$@"
