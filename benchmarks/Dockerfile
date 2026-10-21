FROM rust:1.94.1-slim-bookworm@sha256:f845b308e3104231c98dba2dab952ebd54e35cd6ab8ef4a230ecb38e2315f20c AS rust
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
RUN cargo build --locked --release

FROM node:26.10.0-bookworm-slim@sha256:cfa005801786b8e38fa220af518e43f5654c53b36af36b4ad5b3049225ee261e
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --silent --show-error \
    https://github.com/neovim/neovim/releases/download/v0.12.6/nvim-linux-x86_64.tar.gz \
    --output /tmp/nvim.tar.gz \
    && echo '474430d53e6264f6d6dd18db42d6dc9df3a1b56ca9e88a325bbf860e1a811d87  /tmp/nvim.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/nvim.tar.gz -C /opt && rm /tmp/nvim.tar.gz
ENV PATH="/opt/nvim-linux-x86_64/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global --ignore-scripts npm@12.2.0 \
    && test "$(node --version)" = v26.10.0 && test "$(npm --version)" = 12.2.0 \
    && npm ci --ignore-scripts --omit=dev
COPY --from=rust /source/target/release/harness /app/target/release/harness
COPY adapter ./adapter
COPY lua ./lua
COPY plugin ./plugin
COPY tests/fixtures ./tests/fixtures
COPY benchmarks ./benchmarks
RUN test "$(nvim --version | head -1)" = 'NVIM v0.12.6'
ENTRYPOINT ["python3", "-u", "/app/benchmarks/workload.py"]
