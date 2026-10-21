# Performance

Read this document when you change resource limits, execution load, transcript
retention, or the benchmark. [ARCHITECTURE.md](ARCHITECTURE.md) explains component
ownership. [README.md](README.md) gives the required runtimes and normal checks.

## Resource policy

Share one server and Pi worker across sessions. Keep saved history in SQLite and
load display data when required. Bound protocol records, queues, and editor
history. Replace pending progress with the latest state. Preserve exact outcomes
in storage instead of retaining every progress update in each client.

| Resource | Current control |
| --- | --- |
| Public snapshot | At most 512 KiB and 50 recent entries. |
| Entry or live-tool text preview | At most 8 KiB, with explicit truncation. |
| Loaded editor history | At most 200 entries and 1 MiB of text, identifiers, and kinds, plus the current snapshot. |
| Hidden transcript display | Release text, highlights, and loaded history. Preserve draft and submission state. |
| Generated buffer undo | Disabled for transcript and sidebar buffers. Prompt undo remains enabled. |
| Progress writes | No text write for unchanged output; replace only changed lines. Hidden chats do not format progress. |
| Connected clients and active sessions | At most 32 clients and four active sessions. |
| Slow watch | Keep the newest pending snapshot. Other unsent output has a 4 MiB limit per client. |
| Idle server | Wait for descriptor readiness or the next deadline. |

These limits bound particular data, not total process memory. Pi can retain a
complete active context behind a small snapshot. The selected hidden session
still has a watch for live state and stop controls. Pi releases idle task context
and unused documents after its default ten-minute retention period. The Node
worker and provider code remain resident. Tools can allocate additional memory.

## When to run the benchmark

Run the resource benchmark when a human completes a pull request for review, or
when the user explicitly requests a measurement. Do not add it to the normal
release gate or run it after every change. The first baseline for this work is
explicitly authorized.

Complete normal correctness checks first. Stage each new source or documentation
file, or use `git add -N PATH`, so the benchmark can include it. Then run:

```sh
python3 scripts/bench.py --publish
```

The runner builds and measures an isolated Docker image from a source snapshot.
It requires Docker with Linux cgroup version 2. A cgroup is a Linux process group
with shared resource accounting and limits. The fixed profile is in
[benchmarks/profile.json](benchmarks/profile.json):

| Setting | Value |
| --- | --- |
| Platform | Linux AMD64. |
| CPU quota | Two CPU cores. |
| Memory | 512 MiB. |
| Swap | Disabled. |
| Process limit | 256. |
| Network during measurement | Disabled. |

Image preparation can download the exact runtimes and locked dependencies.
Measurement makes no paid model call. A local substitute supplies model stream
data through the provider SDK. The workload still uses the real server, Pi
storage and scheduler, Bash tools, and Neovim interface.
Neovim runs without a terminal display. This measures plugin work and buffer
changes, but excludes terminal screen rendering. The benchmark sets the Node
old-generation heap ceiling to 1 GiB so that the 512 MiB container limit can
stop the workload before a smaller V8 heap limit. This setting applies only to
the benchmark.

The runner samples every 500 milliseconds. It measures five seconds of idle
time, then ten seconds each with one, two, and four active sessions. The capacity
phase follows a further ten-second run with the editor transcript hidden and a
history reload after reopening. It adds sessions in batches of four, with
256 KiB of instructions and 64 KiB of input per session, until memory is
exhausted. It records CPU and memory for the complete container and samples
individual processes where available. The capacity phase must observe an
out-of-memory allocation failure and kill reported by the cgroup. A timeout, model error, or normal
application limit is not proof of memory exhaustion.

Keep normal-load results separate from the final exhaustion result. Capacity
depends on the fixed synthetic instructions, input size, and retention time.
It does not establish a universal maximum chat count or predict paid-model
latency. Reaching the ten-minute timeout or the 10,000-session test ceiling
without a memory failure produces an incomplete result.

## Evidence and push checks

The source fingerprint is a SHA-256 hash of the measured file names, modes, and
contents. It includes all files listed in the Git index, including documentation,
and uses their current working-tree contents. Untracked files must first be
staged or added with `git add -N`. Only `.bench-results/` and
`benchmarks/results/` are excluded, so storing results does not change the
measured source identity.

Local results are stored under `.bench-results/`. Reviewable baseline results
are also stored under `benchmarks/results/` when `--publish` is used. Omit that
option for a local trial. Each result uses its source fingerprint as
the file name and records the profile hash, complete profile, Docker image ID,
actual limits, measurements, and exhaustion evidence. Source or profile changes
require a new result; an evidence-only commit does not.

Install the local Git warning once in each clone:

```sh
sh scripts/install-hooks.sh
```

The installer preserves existing hooks. If another hooks directory or enabled
hook exists, it explains how to call `.githooks/pre-push` from that hook.

Before a push, the hook checks each outgoing ref tip against its benchmark
evidence. It checks the pushed commit, not an unrelated working tree or `HEAD`.
A missing or invalid result prints a warning and asks through the terminal:

```text
Push these unmeasured changes? Type yes to continue:
```

Only the exact answer `yes` permits that unmeasured push. Without a terminal,
the hook refuses the push. The hook does not run the benchmark itself. A local
Git hook is a review reminder and can be bypassed with Git's normal hook controls.

Inspect the evidence independently with:

```sh
python3 scripts/bench-evidence.py fingerprint
python3 scripts/bench-evidence.py validate
python3 scripts/bench-evidence.py validate --ref COMMIT
```

## Compare results

Compare the same profile and workload. Record source and image identity beside
the values. Check steady load, peak memory, CPU time and throttling, completed
tasks, the 50th, 95th, and 99th percentile task durations, and the
last successful load before exhaustion. A lower server RSS alone is not enough
if the worker, editor, or tools consume more memory.

The resource summary reports each phase over its first and last samples. Mean
CPU cores is CPU time divided by that elapsed time; `1.0` means one fully used
core. The sampled memory peak can miss a short allocation between samples.
Use the recorded cgroup `memory_peak_bytes` for the whole-container peak.

RSS is resident memory for one process; shared pages can appear in several
processes. PSS divides shared pages among those processes. Container accounting
also includes memory such as file cache. Released JavaScript or Lua objects do
not guarantee an immediate RSS decrease, so use repeated bounded workloads and
observe retention as well as peaks.
