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
sh scripts/check-dependencies.sh
python3 tests/nvim/interactive.py
python3 tests/nvim/real.py --group exit
python3 tests/nvim/real.py --group integration
sh scripts/test-install.sh
