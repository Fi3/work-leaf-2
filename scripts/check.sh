#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo build --locked --release
for source in adapter/*.mjs; do node --check "$source"; done
node --test adapter/test/*.test.mjs tests/*.test.mjs
nvim --headless -u NONE -l tests/nvim/run.lua
nvim --headless -u NONE -l tests/nvim/view.lua
nvim --headless -u NONE -l tests/nvim/select.lua
nvim --headless -u NONE -l tests/nvim/setup.lua
sh scripts/check-dependencies.sh
python3 tests/nvim/support_test.py
test_logs=$(mktemp -d)
trap 'rm -rf "$test_logs"' EXIT
python3 tests/nvim/interactive.py >"$test_logs/fixture" 2>&1 & fixture_pid=$!
python3 tests/nvim/real.py --group exit >"$test_logs/exit" 2>&1 & exit_pid=$!
python3 tests/nvim/real.py --group integration >"$test_logs/integration" 2>&1 & integration_pid=$!
test_status=0
wait "$fixture_pid" || test_status=1
wait "$exit_pid" || test_status=1
wait "$integration_pid" || test_status=1
cat "$test_logs/fixture" "$test_logs/exit" "$test_logs/integration"
[ "$test_status" -eq 0 ]
python3 tests/nvim/login_gui.py
sh scripts/test-install.sh
