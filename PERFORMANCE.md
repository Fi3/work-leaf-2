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
after ten minutes and unused documents after 30 seconds. This releases cache
references; JavaScript garbage collection and the memory allocator control when
resident memory falls.
The Node worker and loaded provider code remain resident. Tools can allocate
additional memory.

## When to run the benchmark

Run the resource benchmark when a human completes a pull request for review, or
when the user explicitly requests a measurement. Do not add it to the normal
release gate or run it after every change. The first baseline for this work is
explicitly authorized.

Complete normal correctness checks first. Commit source, documentation, and
check evidence on the branch to measure. Then run:

```sh
python3 scripts/bench.py
```

Publication is enabled by default; the explicit `--publish` option remains
supported. On PASS, the command automatically commits only the matching result and validates
the new commit. It requires an attached branch and no uncommitted source changes.
It checks the source and branch again before the commit. Unrelated staged
benchmark evidence stays staged. Normal Git commit hooks run; a rejected commit
leaves the result available and makes the command fail. No push is automatic.

To measure uncommitted work as a local trial, use `--no-publish`. Stage new source
files or use `git add -N PATH` so the snapshot includes them. Local trials do not
create commits.

The default logical CPUs are 30 and 31. To select another pair, replace
`CPU1,CPU2` with two available CPU IDs:

```sh
python3 scripts/bench.py --cpuset-cpus CPU1,CPU2
```

If either CPU is unavailable, the command stops before the Docker build and
explains how to select another pair. The runner checks Docker's CPU selection
and records it. The two-core quota and
standard workload stay the same. Use the same CPU selection for repeated trials.
Select separate physical cores when possible; two logical CPUs can share a core.

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
are also stored under `benchmarks/results/` by default. Use `--no-publish`
for a local trial. Each result uses its source fingerprint as
the file name and records the profile hash, complete profile, Docker image ID,
actual limits, measurements, and exhaustion evidence. Source or profile changes
require a new result; an evidence-only commit does not.
Only passing published results are committed automatically. Complete failed
results remain saved for review. If source or branch state changes during the
run, automatic publication stops and keeps the result. An identical result
already present in the commit is validated without an empty commit.
The runner prints resource and comparison tables and saves the text report in
`.bench-results/`. A complete run remains recorded if it exceeds the resource
budget, but the command returns a failure status. A recorded run is not by
itself a passing result.

Install the local Git warning once in each clone:

```sh
sh scripts/install-hooks.sh
```

The installer preserves existing hooks. If another hooks directory or enabled
hook exists, it explains how to call `.githooks/pre-push` from that hook.

Before a push, the hook checks each outgoing ref tip against its benchmark
evidence. It checks the pushed commit, not an unrelated working tree or `HEAD`.
If that commit contains a matching result, the hook uses only that committed
result, including a failure or invalid data. A local file cannot replace it.
The hook does not select by timestamp or pass/fail status. Existing local
fallback applies only when the outgoing commit has no matching result.
A missing or invalid result prints a warning and asks through the terminal:

```text
Push these unmeasured changes? Type yes to continue:
```

Only the exact answer `yes` permits that unmeasured push. Without a terminal,
the hook refuses the push. The warning gives the outgoing branch and commit,
correctness checks, source commit steps, Docker requirements, measurement command,
optional CPU selection, and automatic evidence commit behavior. The hook does not run the
benchmark itself. An agent must not provide the human confirmation or bypass
the hook.

Valid evidence must also pass the resource budget below. A measured failure
stops the push and has no confirmation override. The hook recomputes the checks
from raw samples and stage results. A saved `PASS` field or resource summary is
not accepted as proof. Missing or invalid comparison data cannot pass.
Push evidence must also record the current comparison policy. A result from the
old policy needs a new measurement; recalculating its report does not make it
valid push evidence.

Inspect the evidence independently with:

```sh
python3 scripts/bench-evidence.py fingerprint
python3 scripts/bench-evidence.py validate
python3 scripts/bench-evidence.py validate --ref COMMIT
```

`validate --ref COMMIT` uses the same committed-result priority as the hook.
Without `--ref`, validation keeps the local search order: `.bench-results/`,
then the working copy of `benchmarks/results/`. `validate --evidence-dir PATH`
explicitly selects one evidence directory, even with `--ref`. The push hook
does not use this override.

## Compare results

Render an existing result without Docker or a new measurement:

```sh
python3 scripts/bench_report.py benchmarks/results/RESULT_FINGERPRINT.json
```

The report shows active chats, CPU cores used out of two, sampled RAM peak out
of 512 MiB, remaining RAM, completed tasks, and retained-session capacity. It
also shows each difference from the first baseline. Retained capacity is not
concurrent capacity: the standard workload runs at most four chats at once.
Unused CPU or RAM does not prove that more sessions will fit. The report does
not extrapolate session counts.

### Resource budget

The reference is the first accepted
[baseline](benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json).
Its file checksum is fixed in the comparison code. The maximum allowed
regression is **20%**, with these directions:

| Measure | Phases | Passing limit relative to the first baseline |
| --- | --- | --- |
| Peak total process PSS | Idle, one/two/four active chats, hidden editor. | At most 120%. |
| Estimated CPU time per completed task | Each active-load phase, including hidden editor. | At most 120%. |
| 95th percentile task duration | Each active-load phase, including hidden editor. | At most 120%. |
| Completed tasks in the configured ten seconds | Each active-load phase, including hidden editor. | At least 80%. |
| Retained sessions before verified exhaustion | Capacity. | At least 80%; at least 285 against the reference count of 356. |

The memory comparison uses proportional set size (PSS), which divides mapped
shared pages among the processes that use them. For each sample, add the PSS
of all measured processes, including the driver, tools, server, worker, and
editor. Use the largest sample total in each phase. Do not add independent
process peaks. The reference values come from the original baseline's raw
process samples; the reference file and the 20% limit have not changed.
Missing process data, invalid values, duplicate process IDs, or missing
persistent process roles prevent a pass.

The comparison policy is `process-pss-v2`. It replaces the original gate on
container memory charges. The [accounting investigation](#memory-accounting-correction-2026-10-23)
reproduced that gate's failure with the unchanged baseline image. Reports keep
container RAM, headroom, and differences from the first run visible, separately
from the PSS gate. A PASS does not mean container RAM stayed within 20%.
PSS excludes unmapped file cache and kernel memory, and sharing with other
processes can change PSS. The capacity gate still checks retained sessions
under the full 512 MiB container limit, but it cannot detect every increase in
file cache or kernel memory during normal load.

Equality at a limit passes. All checks must pass. Idle CPU is too close to zero
for a useful percentage gate. The capacity memory peak is forced toward the
container limit, so it has no regression gate. The profile, actual resource
limits, and required stages must match the reference. Invalid or missing data
produces `UNAVAILABLE`, not `PASS`. The report command returns 0 for `PASS`,
1 for `FAIL`, and 2 for `UNAVAILABLE`.

This 20% budget is a review policy, not a measured noise threshold. In the prior
trials, some CPU results varied by more than this amount. A single failure does
not prove a source regression. Repeat authorized runs with the same CPU selection
and host conditions; report the median and range before attributing a change.
The first baseline does not record CPU affinity, so even a selected-CPU run has
that comparison limit. Do not replace the reference silently.

The estimated CPU cost divides CPU time between the first and last samples by
the full stage's completed task count. The sample interval can exclude stage
edges. Task rate uses the configured duration because the existing profile has
no exact stage timer. Task duration includes model simulation, tools, storage,
and editor work. It is not pure application overhead. These limits preserve
the standard workload and historical results.

### Published harness figures

[Published figures](benchmarks/published-harnesses.json) contain 18 rows for
14 harness projects from two preserved sources. OpenCode and OpenCode v2 are
kept as separate rows. The report has separate tables for scripted single-session
process-tree RSS and headless session-growth PSS. It includes versions, batches,
source revisions, CPU units, and known method limits. These figures were not
reproduced for this report. No pass/fail comparison with them is valid because
the workload, machine, features, and memory accounting differ.

The [current jcode source](https://github.com/1jehuang/jcode/blob/59fa887c8dd9bb76f8216012e3ed5eaf1ab20f0f/README.md)
reports 71.3 MiB for the first headless session and about 3.3 MiB per additional
session. This differs from the earlier 32.9/6.4 claim preserved in the investigation.
The [scripted source](https://github.com/KonghaYao/harness-perf-benchmark/blob/e89a895a27a6634bded08f93c886b1a70bb15d63/README.md)
reports peri at 54.7 MiB mean and 71.7 MiB peak RSS. Both sources label binary
megabytes as MB; their code uses MiB. Neither source establishes supported
session capacity under our CPU and RAM limits. Missing figures remain unknown.

### Accounting and repeated runs

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
also includes memory such as file cache. New samples record `memory.stat`
counters and the anonymous, file, and shared-memory PSS components when the
kernel supplies them. Some counters overlap; do not add all of them together.
Released JavaScript or Lua objects do
not guarantee an immediate RSS decrease, so use repeated bounded workloads and
observe retention as well as peaks.

## Memory accounting correction: 2026-10-23

The published run for `c1b7c2a` failed the former container-memory percentage
gate: idle rose from 57.62 to 117.64 MiB, and four-chat load rose from 158.17
to 226.98 MiB. Its sampled process PSS was 105.27 MiB idle and 189.85 MiB at
four chats, compared with 108.99 and 189.53 MiB in the original baseline.
These are separate accounting methods; their difference does not assign memory
to a particular owner.

We ran the retained original image and the reported candidate image three times
each, in order baseline/current/current/baseline/baseline/current. All six runs
used the unchanged standard workload, CPUs 30 and 31, two cores, 512 MiB,
no swap, and no network. Each reached verified memory exhaustion. A host-side
observer recorded `memory.stat`; it did not add a process to the measured
container. We did not clear global caches or prewarm images to obtain a pass.
The host was not exclusive. Values below are medians with minimum–maximum ranges.

| Measure | First baseline | Original image repeated | Current image repeated |
| --- | ---: | ---: | ---: |
| Idle container peak, MiB | 57.62 | 100.36 (100.05–119.61) | 98.60 (97.69–99.56) |
| Four-chat container peak, MiB | 158.17 | 208.52 (202.49–227.04) | 205.50 (203.36–207.91) |
| Idle total process PSS peak, MiB | 108.99 | 106.28 (105.30–107.49) | 105.55 (105.23–106.07) |
| Four-chat total process PSS peak, MiB | 189.53 | 188.22 (186.43–190.60) | 182.99 (181.72–191.09) |
| Retained sessions before exhaustion | 356 | 312 (312–352) | 312 (312–344) |

The unchanged original image also fails the old container-memory gate. Thus
the reported increase does not establish an application regression. The Linux
kernel assigns shared memory charges according to which cgroup first brings
the pages into memory; later sharing does not move those charges. See
[memory ownership](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-ownership).
The original result lacks `memory.stat`, so we cannot assign the exact historical
difference to file cache or kernel memory. The control results and process
measurements support a change in accounting conditions.

The corrected gate compares peak total process PSS with the same measure in
the original baseline. See the kernel's
[PSS description](https://docs.kernel.org/filesystems/proc.html).
Container figures remain visible, and new samples record their components.
The 20% limit, 512 MiB limit, workload, capacity gate, and original baseline
file remain unchanged. PSS is not a substitute for total container RAM; its
limits are stated in the resource-budget section. No application memory
reduction is claimed. The repeated process-memory ranges overlap.

Two of the three original-image controls and one current-image trial exceeded
at least one existing CPU or task-duration limit. Those checks remain enforced.
The first baseline has no CPU-affinity record; this host also has different
CPU core types. These trials do not establish that 20% exceeds normal variation,
and the memory-method correction does not guarantee that every later run passes.

The [summary](benchmarks/trials/2026-10-23-memory-accounting.json) records every
run and image identity. The [archive](benchmarks/trials/2026-10-23-memory-accounting.tar.gz)
contains raw results, external counters, the observer script, image information,
and a checksum manifest. These diagnostic trials do not satisfy the push check.
The original failed result remains saved without changing its recorded FAIL.
Current-policy evidence requires a new measurement after the correction is committed.

## Resource investigation: 2026-10-21

The retained changes reduce local formatting work and unused document retention.
Repeated standard trials did not establish an active-load CPU, memory, or capacity
improvement. This investigation does not establish the best possible efficiency
with Pi. Several costs remain measured only as groups, and further changes remain
untested. Pi, all supported features, and the modular architecture remain in place.

The first accepted [baseline](benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json)
remains the reference. The [summary](benchmarks/trials/2026-10-21.json) contains
trial results. The [archive](benchmarks/trials/2026-10-21.tar.gz) preserves raw
evidence, hashes, experimental code, and the full report. These are investigation
records, not accepted push evidence. Values below give medians and minimum–maximum
ranges unless stated otherwise; three runs do not establish confidence intervals.
Extract the archive into an empty directory to inspect its historical project
paths. Its `archive-manifest.json` records the size and SHA-256 of each file.

### Measurement limits

The unchanged standard profile includes the server, worker, tools, headless
editor, driver, and monitor. The simulated provider also consumes worker CPU.
Cgroup memory includes charged file cache and kernel memory. Process RSS/PSS
and cgroup memory use different accounting; they cannot be subtracted to assign
ownership. See the kernel's [memory ownership rules](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-ownership).
Task time includes scheduled stream waits, tools, storage, routing, and driver
work. Overlapping intervals prevent simple subtraction to find pure harness cost.
The one-, two-, and four-chat stages reuse chats and grow history. They do not
measure a constant cost per additional session. Sampling can miss short peaks.

### Repeated standard results

Three runs per image alternated order under the same two-core, 512 MiB profile,
with no swap or external network. Before means the current application before
these changes; after adds the two formatting changes and document retention below.
Images and source identities are in the evidence. The host was not exclusive.

| Stage | Before sampled cgroup peak, MiB | After, MiB | Before mean CPU, cores | After, cores |
| --- | ---: | ---: | ---: | ---: |
| Idle | 57.70 (56.23–57.84) | 54.75 (53.77–56.09) | 0.006 (0.005–0.006) | 0.007 (0.005–0.011) |
| One chat | 121.98 (120.27–134.70) | 121.22 (120.21–122.68) | 0.293 (0.253–0.355) | 0.292 (0.254–0.381) |
| Two chats | 133.16 (131.33–140.20) | 135.79 (126.20–137.82) | 0.383 (0.376–0.410) | 0.406 (0.370–0.491) |
| Four chats | 158.80 (154.67–171.70) | 157.97 (151.95–165.50) | 0.643 (0.643–0.708) | 0.641 (0.625–0.736) |
| Hidden editor | 161.77 (160.86–168.86) | 161.98 (157.07–164.15) | 0.224 (0.204–0.340) | 0.261 (0.203–0.336) |

| Stage | Before tasks | After tasks | Before task p95, ms | After, ms |
| --- | ---: | ---: | ---: | ---: |
| One chat | 62 (58–64) | 63 (57–64) | 181.80 (164.80–206.49) | 170.41 (169.07–225.78) |
| Two chats | 120 (119–125) | 121 (111–124) | 198.75 (172.64–199.26) | 180.47 (178.33–205.57) |
| Four chats | 216 (212–222) | 224 (201–228) | 216.41 (204.35–233.83) | 195.89 (191.81–226.79) |
| Hidden editor | 63 (56–63) | 60 (57–64) | 185.04 (171.25–200.39) | 198.49 (163.94–216.27) |

The active-load ranges overlap. The lower idle peak has no established cause.
Verified capacity was 328 retained sessions (312–344, two runs) before and 340
(324–352, three runs) after; only four were active. One before run lacked complete
exhaustion evidence and is excluded from capacity only. The ranges overlap.
Earlier repeated baselines also varied; the original 356 sessions is not a fixed
limit, and isolated four-chat peaks of 158.17 and 161.53 MiB do not prove a regression.

### Main measured costs

Three forced-collection import probes measured worker PSS of 46.49 MiB for Node
and probe code, 77.46 MiB after Pi Durable, and 84.21 MiB (84.10–85.20) after
application open. Explicit OpenAI and then Anthropic imports raised this to 94.04
and 97.08 MiB. These are cumulative, order-dependent process values, not container
memory or exclusive ownership. Heavy SDKs and login code already load on demand;
provider catalogs load at startup. Closing the application does not unload modules.

One CPU profile assigned 47.90% of non-idle main-thread samples to Pi/Chord,
16.74% to OpenAI, 14.17% to Node, and 1.34% to our adapter. SQLite, request JSON
encoding, process creation, and collection were major operations. These are sample
shares, not CPU seconds. A separate 1,200-task run attributed 64.93% of sampled
active CPU to the worker and 28.82% to tools. File cache also grew during that run.
After 30 idle seconds, worker RSS stayed at 117.99–119.48 MiB through a 660-second
idle period; resume succeeded. One observed interval does not prove lasting stability.

### Changes tested and decisions

| Change | Measured effect and decision |
| --- | --- |
| One snapshot-size loop | Retain. Local formatting CPU fell 30.9–71.4% across three fixtures. Removal order and output limits stay the same. |
| Encode only the needed preview prefix | Retain. Added to the first change, local CPU fell 7.6–34.0%. Unicode and truncation behavior stay the same. |
| Zero context/document retention | Reject. Reuse CPU rose from 22.63 (22.12–23.44) to 27.44 (26.42–28.26) ms/task, with no consistent memory benefit. |
| Both caches at 30 seconds | Reject. Forced collection found 39.44 MiB less retained heap in 64 large sessions, but long-history resume used 11.98 MiB more median PSS than default. |
| Documents at 30 seconds; context at ten minutes | Retain through Pi's public setting. In 64 large sessions, post-resume PSS was 158.75 (156.61–159.08) versus 175.06 (172.47–175.95) MiB with defaults. |

Formatting tests used seven repetitions of 500 snapshots, alternating order and
checking output equality. Their savings apply to local work, not total task CPU.
The 33 cache trials used separate reuse, large-session, forced-collection, and
long-history workloads. They used a 268 MiB V8 heap limit; the standard benchmark
sets the old-generation ceiling to 1 GiB. Forced collection does not prove natural
resident-memory savings. Cache expiry need not return memory immediately.

The six document-only trials ran later, not interleaved with matching defaults.
After four long histories resumed, PSS rose within each run by 15.01 MiB
(14.87–15.05) with document-only retention, 14.83 (14.38–14.91) with defaults,
and 20.33 (20.28–20.54) with both caches shortened. Resume CPU and time ranges
overlap defaults. These results support keeping context retention; later trial
order limits causal conclusions. The full release gate passed, including expiry,
history, receipts, targeted cancellation, recovery, authentication, and editor checks.

### Comparison with efficient harnesses

Three runs per harness used one retained session and 50 sequential tasks, the same
local Anthropic substitute, actual Bash/Python tool, 5,633-byte output, and paced
2,048-byte answer. Linux resource limits matched; PSS includes each harness and
its tools, while the common driver and provider substitute are measured separately.

| Harness | Sampled PSS peak, MiB | Estimated CPU, seconds | Time for 50 tasks, seconds |
| --- | ---: | ---: | ---: |
| Our formatting candidate | 125.45 (124.88–127.76) | 3.260 (1.769–3.284) | 9.13 (7.98–9.14) |
| jcode v0.99.0 | 63.49 (62.13–64.26) | 1.413 (1.405–2.899) | 12.64 (12.63–13.65) |
| peri 3.17.0 | 115.40 (109.03–117.24) | 3.242 (1.588–3.446) | 8.79 (7.55–8.90) |

This places our process memory near peri and 61.96 MiB above jcode in this workload.
CPU ranges overlap. All 450 main tasks completed with full tool output; exported
final answers were not independently compared. Normal storage and tools stayed on.
Auxiliary features stayed on but received empty results; nonempty costs were not
measured. The smaller tool output avoids competitor truncation. The test excludes
editors, multiple active sessions, OAuth refresh, recovery, and cancellation parity.
The first comparison matrix had fixture errors and is rejected. A later three-run
check of the final image had PSS 127.16 (121.70–128.17) MiB; it is not pooled here.

The 61.96 MiB difference is a total at one session, not a per-session charge.
Our chats share one Node/Pi worker, provider code, and database connection. Each
chat adds metadata, retained context, and work buffers. The trials do not divide
the gap into fixed and variable costs or establish comparative per-session growth.

jcode's earlier published 32.9 MiB first session and 6.4 MiB additional-session claims
use post-turn PSS and a different workload; see its [saved README](dev-docs/performance/jcode/README.md)
and [pinned method](https://github.com/1jehuang/jcode/blob/28d51019f7fdd30bbde69d40c87d59536314bd46/scripts/bench_headless_memory.py).
Its [website](https://jcode.sh/) gives a separate 3.5 MiB claim for v0.92.14.
The published peri 54.7 MiB mean/71.7 MiB peak uses RSS on macOS, different mocked
output, and no stream delay; see the [benchmark](https://github.com/KonghaYao/harness-perf-benchmark)
and [pinned method](https://github.com/KonghaYao/harness-perf-benchmark/blob/e89a895a27a6634bded08f93c886b1a70bb15d63/docs/perf-compare.md).
These claims were checked, not reproduced. Preserved [upstream sources](dev-docs/performance/)
and the [catalog](dev-docs/catalog.json) record revisions, licenses, and hashes.
Both published sources label values divided by 1024 squared as MB; these are MiB.

### What remains open

The current design retains Node/Pi/provider code, model context, SQLite, tools,
and selected-session views. The evidence does not prove every representation or
repeated serialization is necessary. Further savings could come
from measured changes to these operations, cache use, or observation lifetime.
The adapter's small sampled CPU share suggests limited gains from formatting alone;
this is an inference, not an architectural limit. No numeric estimate for the
remaining achievable savings, or for closing the jcode gap, is yet supported.

## Session growth investigation: 2026-10-22

This separate diagnostic used CPU affinity `30,31`, on two distinct physical
cores, with a two-core quota, 512 MiB of memory, no swap, no network, and a 1 GiB
V8 old-generation ceiling. It called the actual application adapter, Pi, provider
SDK, and tools. It did not run the Rust server or editor. The worker also ran the
diagnostic driver and simulated provider. Its results cannot replace the standard
benchmark or be compared directly with the earlier competitor measurements.
The [trial summary](benchmarks/trials/2026-10-22.json) and
[archive](benchmarks/trials/2026-10-22.tar.gz) preserve the method and raw evidence.

The session-count test used 1, 4, 16, then 64 retained sessions, each with two
completed tasks. At most four sessions ran at once; one session stayed watched
during activity and idle. The small profile used no extra instructions and a
56-byte input. The large profile used unique 256 KiB instructions and a 64 KiB
input per session. Three interleaved runs of each profile and policy compared
Pi's 600-second document retention with the retained 30-second setting. Context
retention stayed at 600 seconds. No run forced garbage collection.

Values below are median worker PSS in MiB, with the minimum and maximum of three
runs. Task stages include two seconds of settlement. Resume means one further
task in each of four sessions after 35 idle seconds and release of the watch.

| Profile and stage | Documents: 600 seconds | Documents: 30 seconds |
| --- | ---: | ---: |
| Small, 1 session | 98.80 (98.35–99.46) | 98.77 (97.38–99.40) |
| Small, 4 sessions | 102.92 (101.96–104.66) | 101.85 (99.94–104.91) |
| Small, 16 sessions | 116.13 (115.32–118.69) | 115.64 (114.93–115.78) |
| Small, 64 sessions | 128.56 (128.28–130.00) | 129.83 (127.94–131.69) |
| Small, after resume | 113.88 (113.57–116.44) | 114.25 (114.20–114.31) |
| Large, 1 session | 108.63 (108.10–109.25) | 108.54 (108.27–108.64) |
| Large, 4 sessions | 119.91 (118.29–121.62) | 120.69 (120.62–120.94) |
| Large, 16 sessions | 139.94 (139.41–144.53) | 139.81 (139.19–147.76) |
| Large, 64 sessions | 203.59 (198.82–203.61) | 201.88 (199.04–228.81) |
| Large, after 35 idle seconds | 171.14 (169.68–172.01) | 170.48 (167.89–172.11) |
| Large, after resume | 184.63 (183.21–184.74) | 168.33 (167.60–170.45) |

The large-session resume result supports the retained document policy: median PSS
was 16.30 MiB lower. The four-task resume batch used 147.43 (145.02–152.36) ms
of worker CPU, versus 136.45 (135.29–138.19) ms with defaults: about 11 ms or 8%
more. This CPU measure excludes child tools and settlement time. It includes Pi,
SDK serialization, and the simulated provider; it is not pure harness overhead.
The trials did not establish a memory or CPU benefit during active work or for
small sessions. The container also held about 99 MiB of file cache at 64 large
sessions. Container memory and worker PSS remain separate measures.

With the current policy, the change from 16 to 64 sessions was 0.29
(0.27–0.33) MiB of worker PSS per added small session and 1.31 (1.23–1.69) MiB
per added large session. These are observed differences across cumulative stages,
not fixed per-session charges. Runtime and provider code are shared, while
instructions, history, work buffers, cache age, and allocation affect growth.

A separate three-run test kept four sessions and the current policy, with
1, 10, 25, then 50 completed tasks per session. Worker PSS was 100.28
(99.78–100.28), 132.49 (130.75–132.94), 142.45 (136.67–145.57), and 154.05
(148.80–155.89) MiB. It fell to 104.80 (104.41–105.87) MiB after 35 idle
seconds, then reached 115.19 (114.59–115.88) MiB after four resume tasks. All
204 tasks in each run completed. Each run made 416 provider requests, eight more than the
usual two per task, consistent with Pi compaction. The synthetic summary cannot
establish memory growth or summary quality for real long conversations. This
test had no matching default-policy group and proves no retention-policy effect.

A separate single run kept 64 large sessions idle for 660 seconds with the current
policy. Worker PSS was 170.68 MiB at 35 seconds and 170.61 MiB at 660 seconds.
After four sessions resumed, it was 157.07 MiB; used JavaScript heap fell from
88.80 to 50.09 MiB. Resume and saved-history checks passed. This shows why expiry
does not guarantee an immediate resident-memory decrease. Container file cache
also fell from 99.32 to 81.55 MiB during idle, so a container decrease must not be
attributed solely to Pi. One run establishes neither variation nor long-term
stability and is not pooled with the 35-second comparisons.

All 2,328 tasks in the 16 measured runs completed. Two smaller pilot runs are
preserved separately and excluded from these results. All runs verified CPU
affinity and resource limits; none reported memory exhaustion. At the end of
these measurements, the 81 source hashes from the earlier successful full release
gate still matched the application and its tests. This investigation changed
neither the standard workload nor its accepted results and push check. Later
report and correctness changes have separate
[release evidence](tests/evidence/performance.json).

No further application change was retained in this round. Loading instruction
metadata only when needed remains a possible large-session optimization, but
small instructions offer little saving. That change would affect configuration,
inheritance, recovery, and metadata delivery with atomic watches. Its wider
correctness cost is not justified by these results. Further formatting work is
also deferred unless a complete workload profile identifies it as a material
cost. The earlier 1.34% adapter sample share does not support that work now.
