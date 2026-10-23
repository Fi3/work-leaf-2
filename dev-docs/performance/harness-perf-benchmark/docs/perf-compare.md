# Load-test comparison: six harnesses (opencode v1 removed from rankings; Antigravity CLI, opencode v2, Hermes Agent, and Cline integrated but not yet included in the batch)

> **opencode v1 was removed from the rankings on 2026-09-19.**
>
> It was the only harness **far behind on every metric**. Measurements when it was removed:
> elapsed time **38.6s**, versus 1.5~19.9s for the other five in that batch; process-tree
> **mean CPU 69.9% / peak 229.3%**, both the highest; process-tree **mean RSS 798.9MB /
> peak 943.0MB**, versus just 274.9 / 321.9MB for the next highest, Claude Code: a factor of 2.9.
> A rough estimate using elapsed time × mean CPU gives about **27 core·s**, versus 1.0~5.0 core·s
> for the other five. For the same 100-round script, it used more than 5 times their resources.
>
> Keeping it in the rankings would extend the horizontal axis and crowd the others together.
> It no longer provides a useful comparison, so **later batches do not run or rank opencode v1**.
> It is also absent from the tables below: all readings are from one batch, and adding an old
> result from hours earlier would break comparability within that batch. The `playground/opencode/`
> sandbox and integration code remain. To test it again, use the commands below. Its aliases
> remain in `scripts/perf/harness-id.ts`; the demo checks the version first and rejects versions
> other than v1. Historical results remain in `data/runs/opencode/`. To show it on charts, omit
> `--exclude opencode` when generating data. **Its successor v2 (`opencode2`) is a separate
> entry and is in the rankings**; see its section below. The same name covers different
> generations, and their readings cannot replace each other.

Use llm-mock with a controlled load to measure each harness's own resource overhead. Measurement
period: **2026-09-19 20:39~20:43** (fifth batch; macOS / Apple Silicon, 18 cores). Samples are taken
every 100ms with `proc_pid_rusage`; CPU uses **100% per core**, and GPU use is not sampled.
All readings in this document come from that batch. Every run uses `--label codex-proxy-fix`:
six harnesses × 3 serial runs, 18 runs total, completed in **2 minutes 50 seconds**.

**This batch was repeated to measure the Codex fix.** The Codex demo removed the fixed shutdown
wait for a `chatgpt.com` timeout by injecting an HTTPS proxy pointed at an unused port only into
the harness and its children. See “Shutdown and auxiliary requests by harness” for the cause and
verification. Both elapsed time and CU change, so the entire batch had to be repeated.
Compared with the previous batch (19:50~19:54, `cu-1to1`): **Codex elapsed time 16.4s → 6.1s,
shutdown 10.06s → 0.04s, CU 3.294 → 1.383, and rank fourth → second**.
The machine was also much less busy: `load average` stayed at **2.9~3.8**, versus 4~17 previously.
Thus **absolute durations and CU generally fell for all harnesses**: pi 1.6 → 1.3s, peri 2.8 → 2.2s,
Claude Code 2.6 → 2.2s, and MiniMax Code 21.1 → 19.9s. Across batches, **compare structure and
rankings only; do not directly subtract durations from different batches**.

The method measures **a complete long script from start to exit**: a finite script with
100 rounds × about 4KB of text plus one tool call (`--exhausted stop`). After completing the script
and receiving the final response, the harness **exits by itself**. This answers how long the same
task takes, how many resources the full run uses, and how startup, execution, and shutdown
contribute. Comparing CPU burned within a fixed time window is not meaningful: each harness
completes a different amount of work in that window.

Harnesses and integration methods:

| Harness | Version | Wire protocol | Integration point | Sandbox isolation |
| --- | --- | --- | --- | --- |
| peri | 3.17.0 (PATH) | OpenAI Chat Completions | `--settings <JSON>` | `--db-path` session database |
| opencode v1 (**removed from rankings**) | 1.17.12 | OpenAI Chat Completions | `opencode.json` in cwd + `{env:LLM_MOCK_BASE_URL}` | `XDG_*` |
| Claude Code | 2.1.277 | Anthropic Messages | `ANTHROPIC_BASE_URL` and other environment variables | `HOME` + `CLAUDE_CONFIG_DIR` |
| Codex | 0.155.1 | OpenAI Responses | Provider in `CODEX_HOME/config.toml` | `CODEX_HOME` |
| pi | 0.85.1 | OpenAI Chat Completions | Set baseUrl in sandbox `models.json` + `--model llm-mock/llm-mock` | `PI_CODING_AGENT_DIR` |
| dsh | 0.1.5-rc.2 | OpenAI Chat Completions | `$DEEPSEEK_BASE_URL` / `$DEEPSEEK_API_KEY` environment variables | `DSH_HOME` |
| MiniMax Code (`mcode`) | 0.4.12 | OpenAI Chat Completions | `custom_provider.*.options.baseURL` in sandbox `config.yaml` + `--model custom_provider:llm-mock/llm-mock` | `MINIMAX_DATA_DIR` |
| Antigravity CLI (`agy`) (**new integration, not run in this batch**) | 1.2.7 (PATH) | **Google Gemini API** | `GOOGLE_GEMINI_BASE_URL` + `modelProvider: "gemini"` in sandbox `settings.json` | `HOME` |
| opencode v2 (`opencode2`) (**new integration, not run in this batch**) | 2.0.10 | OpenAI Chat Completions | `opencode.json` in cwd + `{env:LLM_MOCK_BASE_URL}`, with `--standalone` | `XDG_*` + proxy to an unused port |
| Hermes Agent (`hermes`) (**new integration, not run in this batch**) | 0.21.3 (2026.9.14, official script installs into `~/.local/bin`) | OpenAI Chat Completions | `model.provider: custom` + `base_url` in sandbox `config.yaml` (no environment-variable interpolation) | `HERMES_HOME` |
| Cline (`cline`) (**new integration, not run in this batch**) | 3.0.62 | OpenAI Chat Completions | `openai-compatible` provider in sandbox `settings/providers.json` + explicit `-P` / `-m` (no environment-variable interpolation) | `--config` / `--data-dir` / `--hooks-dir` (**no HOME change**) |
| Kimi Code (`kimi`) (**new integration, not run in this batch**) | 2.0.0 (official install.sh installs into `~/.kimi-code/bin`) | OpenAI Chat Completions | `[providers.llm-mock]` in sandbox `config.toml` (`type = "openai"` + `base_url`, fake key) + `-m llm-mock` (no environment-variable interpolation) | `KIMI_CODE_HOME` (**no HOME change**) |

Each harness runs the same script in its own playground sandbox
(`cd playground/<name> && bun perf-demo.ts …`). The same generator creates each script, with tool
formats based on measurements of each harness. Generator timing defaults are
`chunkSize=64 / chunkDelayMs=0`: the mock emits output as quickly as possible and is not the
bottleneck. Measurements cover the main harness process and its process tree.
**The six harnesses run serially**, without competing for the machine. Each runs **3 times**.
Select the run with the median elapsed time (`gen-chart-data.ts --window 3` uses this rule);
all readings below come from that selected run. **Do not compare absolute times across batches**:
an earlier batch ran at load 10~16, and the same machine and script can differ by a factor of
2~4 in elapsed time. This batch had load 2.9~3.8, peri 2.2s, and dsh 3.8s; CPU-saturated
MiniMax Code is the most sensitive to load.

## Reproduction

### Complete long script (100 rounds × 4KB, through normal exit)

The generator creates 100 rounds of about 4KB of text plus one tool call, **followed by two final
entries**: a plain-text “task complete” response (`finish_reason=stop`, which causes the harness
to finish and exit), then a blank response for peri's “predict the next input” request. The blank
response removes peri's fixed 5.0s shutdown wait; see “Shutdown and auxiliary requests by harness”.
This batch includes both entries, leaving peri's shutdown at 0.07s. Without them, the mock's
`--exhausted stop` supplies the last response, but peri receives nonempty prediction text and
waits 5s unnecessarily. Elapsed time therefore covers startup → 100 rounds → exit.
`--timeout-ms` is only a fallback and should not trigger in normal operation.

The summary **splits this duration into three segments**, using request timestamps recorded by
the mock on the same machine and clock as harness startup and exit:

```
Time segments: startup → first request X | first request → last request Y | last request → exit Z (shutdown without requests: …)
```

The third segment is the **shutdown wait** after requests stop but before the process exits.
Measurements show that this is useful information: almost all of Codex's previous fixed overhead
was here (10.06s). The demo's proxy injection reduced it to 0.04s in this batch; see below.
Peri's 5.0s wait had already been removed by the final blank script entry; this batch measured 0.07s.

```sh
# Generate scripts using each harness's measured tool format; **pi needs 133 rounds**, explained below.
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json   # Shared by peri / Claude Code
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash --out data/scenarios/long-run-pi.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \
  --out data/scenarios/long-run-dsh.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \
  --out data/scenarios/long-run-minimax-code.json   # mcode: bash + {command}; 100 entries complete 100 rounds

cd playground/peri        && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --turns 100 --label codex-proxy-fix
cd playground/opencode    && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/claude-code && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/codex       && bun perf-demo.ts --script data/scenarios/long-run-codex.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/pi          && bun perf-demo.ts --script data/scenarios/long-run-pi.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/deepseek    && bun perf-demo.ts --script data/scenarios/long-run-dsh.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/minimax-code && bun perf-demo.ts \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix   # Default script: long-run-minimax-code.json
```

- The `--script` values above are each demo's default scripts, shown for clarity. Paths are
  resolved from the repository root, so they also work from `playground/<name>/`.
- **Three runs per harness**: repeat the same command 3 times. This batch completed six harnesses
  × 3 serial runs in 2 minutes 50 seconds. Give every run `--label <batch-name>` to filter results
  by batch. Select **the run with the median elapsed time**, as `gen-chart-data.ts --window 3`
  does. Do not mix runs from different batches in one table.
- `--turns 100` guards against mistakes. Although peri 3.17 ignores `--max-turns` in `-p` mode,
  its default of 25 would truncate the script if it took effect. The other harnesses have no
  equivalent round-limit parameter and finish when the script is exhausted. This differs from
  the generator's same-named option: generator `--turns` sets script rounds; the demo option
  sets the harness's `--max-turns`.
- **Why pi needs 133 rounds**: pi starts **automatic compaction** at about 140 context messages.
  `compaction.enabled` defaults to true, with `reserveTokens` 16384 / `keepRecentTokens` 20000.
  During compaction it adds a `messages=2` summary request each round, consuming script entries.
  A 100-entry script reaches only round 84; from round 70, summary and main requests alternate
  in consuming entries. The generator's two final entries use one more entry in this sequence.
  **Measurements found that 132 entries (`--turns 130`) reach only 99 rounds, 133 entries still
  reach 99 rounds, and only 135 entries (`--turns 133`) complete exactly 100 rounds.**
  Compaction requests consume all extra entries. Thus this script has 133 rounds = 135 entries.

Outputs are written to `data/runs/<harness>/<runId>/`: `run.json` provides the machine interface
(identity / timeline / segments / summary / **combined score `cost` and peaks `peaks`** / exit code);
`perf.log` is a readable timeline; `samples.csv` contains individual samples, including
`child_cpu_pct`; and `harness.log` / `mock.log` contain logs. Each of the six harnesses ran
**3 times** with `--label codex-proxy-fix`, 18 runs total. All readings below are from
**the run with the median elapsed time**:

```
peri 20260919-204152 · dsh 20260919-204208        · minimax-code 20260919-204129
claude-code 20260919-204027 · codex 20260919-204120 · pi 20260919-204157
```

To view sample curves, run `bun run scripts/perf/gen-chart-data.ts --exclude opencode`.
Without `--pick`, it selects each harness's median-duration run from its latest 3 runs, which gives
the 6 runIds above. It generates `data/perf-chart.json`. Serve and open `docs/perf-chart.html`;
see “Chart page” at the end.

## Findings at a glance

- **Elapsed time: pi 1.3s ≈ Claude Code 2.2s ≈ peri 2.2s < dsh 3.8s < Codex 6.1s ≪ MiniMax Code 19.9s**.
  This differs from resource efficiency. Codex takes 59.8ms per round, slower than all except
  MiniMax Code, and has the second-longest elapsed time, but its total CU is only slightly above pi.
- **Combined score (CPU and memory 1:1, Beta): pi 1.271 CU (100 points) < Codex 1.383 (91.9)
  < peri 2.102 (60.5) < Claude Code 2.828 (45.0) < dsh 3.101 (41.0) ≪ MiniMax Code 31.995 (4.0)**.
  **Codex moved to second directly because of this batch's fix.** Previously, 53% of its CU came
  from the 10s idle shutdown wait: 1.760 CU while retaining about 160MB of memory. Removing that
  wait leaves 1.383 CU, just 0.11 above pi.
- **Pi's 1.3s includes all 100 rounds**: 135 requests = 100 tool-call rounds + 34 compaction
  summaries + 1 initial request. Its 11.2ms/round is the lowest of the six. The cost is
  **automatic compaction**, with 34 extra summary requests; see below.
- **Fixed costs are already small in this batch**: startup 0.10~1.22s and shutdown 0.02~0.23s
  across the six. Codex shutdown is 0.04s after the fix; peri is 0.07s. **Almost all time is in
  execution.** MiniMax Code's slowest startup, 1.22s, includes a model-catalog refresh.
- **Mean CPU / peak RSS alone can mislead**: MiniMax Code keeps one core busy throughout
  (mean CPU 98.1%, peak RSS 892.0MB), versus peri at 32.6% / 71.7MB and Codex at 10.5% / 163.7MB.
  Codex's low CPU reflects work done by its spawned native binary: 0.618 core·s in sampled
  descendants. Peri's low CPU reflects shells reaped each round: 1.261 core·s in child counters.
  **Neither number alone answers how many resources the full run uses.**
- **Peri ranks third because of its 100 spawned shells**. Its main-process mean CPU is only
  32.6%, but every tool call spawns a process. **1.261 core·s, 64% of total CPU, or approximately
  100 rounds × 13ms CPU/round, appears in the reaped-child counters.** Across 2.2s of wall time,
  it nearly keeps one core busy: 1.983 ÷ 2.2 ≈ 0.9 cores. The old sampler missed this cost,
  understating peri's CU as ~0.84 (0.722 + 0.119) instead of 2.102: **below pi, falsely putting
  it first**. This directly motivates the project's process-tree scoring scope. CU distinguishes
  work assigned to children from work performed in the main process.
- **Memory growth with rounds is expected**: each request sends the history, including the
  previous text and tool results. RSS includes rendering buffers and accumulated session data.
  The 100-round script contains about 450KB of text, similar to the last request body; pi's body
  is much shorter after compaction. Process-tree growth from first to last sample: peri +49MB,
  pi +106MB, Codex +119MB, dsh +173MB, Claude Code +206MB, MiniMax Code +696MB.
- **Request count is not round count**: mock requests include auxiliary requests. This batch
  had peri 1 prediction request, consuming the final blank entry without taking a round;
  dsh 1 session-title request, consuming script entry 2; and pi 34 compaction summaries.
  Claude Code / Codex / MiniMax Code had none. **Auxiliary requests consume script entries**,
  so dsh completes 99 tool rounds. Pi needs a 133-round script, 135 entries, for exactly
  100 tool rounds; see “Reproduction”.
- **MiniMax Code alone is “not efficient, just fast”**: 18.5s of its 19.9s is execution,
  with CPU at 98.1% throughout. Its 31.995 CU is 10.3 times the next most expensive, dsh,
  and 25.2 times the most efficient, pi.
- **Peri's low memory use is clear**: memory integral 122 MB·s and peak 71.7MB are the lowest
  of the six. Its CPU peak of 43.7% is the only one below a full core. Its cost comes from
  integrated CPU use for 100 tool shells.
- Machine load was 2.9~3.8, lower than the previous batch's 4~17. The six ran under similar
  conditions and can be compared. For cleaner measurements, repeat the procedure on an idle machine.

## Results

### Long script: 100 rounds × 4KB, through normal exit (median of 3 runs per harness)

| Harness | Elapsed time | Startup → first request | First → last request | Last request → exit | Execution per round | Requests | Completed rounds | Mean CPU | Peak CPU | Mean RSS | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.3s** | 0.18s | 1.12s | 0.02s | **11.2ms** | 135 | 100 | 65.5% | 128.8% | 186.2MB | 234.4MB |
| Claude Code 2.1.277 | 2.2s | 0.19s | 1.96s | 0.06s | 19.6ms | 101 | 100 | 71.8% | 122.4% | 310.9MB | 351.0MB |
| peri 3.17.0 | 2.2s | 0.30s | 1.85s | 0.07s | 18.5ms | 102 | 100 | 32.6% | **43.7%** | **54.7MB** | **71.7MB** |
| dsh 0.1.5-rc.2 | 3.8s | 0.76s | 2.99s | 0.07s | 30.2ms | 101 | 99 | 46.3% | 128.0% | 185.6MB | 231.2MB |
| Codex 0.155.1 | 6.1s | 0.10s | 5.98s | **0.04s** | 59.8ms | 101 | 100 | **10.5%** | **26.0%** | 123.4MB | 163.7MB |
| MiniMax Code 0.4.12 | 19.9s | 1.22s | 18.47s | 0.23s | 184.7ms | 101 | 100 | **98.1%** | 177.8% | 617.6MB | 892.0MB |

Definitions:

- **Elapsed time** runs from harness startup to exit (`duration.endToEndMs` in `run.json`).
  It exceeds the sampling window by the priming interval and the gap after the final sample.
  The 100-round script text totals about 450KB. Claude Code and peri both display 2.2s; their actual values
  are 2219 / 2221ms, the same range, so the table does not force an ordering.
- **Three segments** are `segments` in `run.json` (`startupMs / spanMs / tailMs`), calculated
  from request timestamps recorded by the mock.
- **Execution per round** = `spanMs ÷ completed rounds`, an estimate of processing per round
  **excluding startup and shutdown**.
- **Completed rounds** count tool calls actually executed and returned. They are counted in
  `mock.log` from “consume entry N” requests that contain tool results: `last=tool` for chat,
  `last=custom_tool_call_output` for Codex. Claude Code always appends a final system message
  for the token balance, so its count is requests − 1. Dsh's title request consumes one entry,
  leaving 99 rounds; pi's 133-round script completes exactly 100 rounds.
- **CPU / RSS cover the process tree**. Means and peaks come from `samples.csv`, sampled every
  100ms. Codex's main process is only a Node launcher: mean CPU 0.1%, mean RSS 41.7MB, and final
  RSS also 41.7MB. Only process-tree measurements are meaningful for it.
- RSS growth from first to last process-tree sample: MiniMax Code +696MB, Claude Code +206MB,
  dsh +173MB, Codex +119MB, pi +106MB, peri +49MB. Much of Codex's increase comes from tool
  subprocesses each round (`zsh -lc` plus emsdk initialization in the local `.zshrc`;
  peak `procs` **3** in this batch). It is not all accumulated context.

Interpretation:

- **Pi's 1.3s does not omit rounds**: the mock main loop completes 100 tool calls, and the
  final message contains the tool result. It is fast because the processing path is short,
  11.2ms/round, and it compacts its history through 34 `messages=2` summary requests.
  For comparison of long sessions, this reading is optimistic because pi removed history itself.
- **Codex's 6.1s is actual execution**: shutdown is only 0.04s after the fix. Execution takes
  5.98s, or 59.8ms/round, slower than all except MiniMax Code. Each round starts a new
  `/bin/zsh -lc`, with emsdk initialization in the local `.zshrc`. The delay is per round,
  not shutdown. The previous 10.06s shutdown delay came from local DNS pollution; see
  “Shutdown and auxiliary requests by harness”.
- **MiniMax Code is expensive per round**: 184.7ms/round is 9.4 times Claude Code's 19.6ms/round
  and 16.5 times pi's 11.2ms/round. Mean CPU is 98.1%, nearly one core throughout, and peak RSS
  is 892.0MB. Startup, 1.22s and slowest of the six, is not the bottleneck; processing each round
  is. Its three runs are stable at 19.1 / 19.9 / 20.0s, without the previous batch's outliers
  during load spikes.
- **Dsh startup at 0.76s** is second-longest, after MiniMax Code's 1.22s; total elapsed time is
  3.8s. Its execution cost of 30.2ms/round is about 50% above Claude Code's 19.6ms/round.

## MiniMax Code (`mcode`): a member of the regular batch

`mcode exec`, the headless mode of `@minimax-ai/code` 0.4.12 over OpenAI Chat Completions, has run
serially in the same batch as the other five since the previous batch. See “Harness integration”
in `CLAUDE.md` for details. This batch measured 19.1s / 19.9s / 20.0s and CU 30.42 / 31.99 / 32.15.
The median run, 19.9s, gives:

- **Elapsed time 19.9s: startup 1.22s · execution 18.47s · shutdown 0.23s**. There is no fixed
  shutdown wait like Codex's. The cost is full-speed processing each round, not startup or shutdown.
- **The clearest request pattern of the six**: a 100-round script yields **101 requests =
  100 rounds + the final completion entry**, with no title generation, compaction, or prediction.
  In comparison, pi needs 135 script entries, and dsh's title request consumes entry 2.
- **It uses the most resources in this list**: process-tree mean CPU **98.1%**, nearly one core
  throughout; peak RSS **892.0MB**; **31.995 CU**. The next highest, dsh, uses 3.101 CU;
  the lowest, pi, uses 1.271. **It is not efficient, just fast.**
- Startup refreshes the model catalog (`models.dev/api.json` → `filecdn.minimax.chat`, saving
  4.7MB in sandbox `cache/`). This bypasses the mock but adds 1.22s to startup, the slowest of
  the six. Account for this when comparing startup across machines.

## Antigravity CLI (`agy`): integrated, **not yet included in the batch**

> **It is absent from the batch above; these readings must not be placed beside the batch table.**
> The difference is not the script: the same generator creates 100 rounds × 4KB, with its
> `run_command` tool format. The difference is the **run batch**. Three runs took place on
> 2026-09-20 11:47 (`--label agy-probe`, local load 3.3), one night after the fifth batch.
> Across batches, **only CU is comparable**. Percentage scores and other metrics are not;
> scores are relative within a batch.

`agy -p`, the headless mode in 1.2.7, was integrated on 2026-09-20 as the seventh harness.
It uses the **fourth wire protocol, Google Gemini API**:
`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`, implemented by the mock in
`src/gemini.ts`. See “Harness integration” in `CLAUDE.md` for the protocol, sandbox, and request
pattern. The three readings are:

| Run | runId | Elapsed time | Startup · execution · shutdown | CU | Peak RSS · CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260920-114712` | 2.4s | 0.1 · 2.2 · 0.1 | 4.866 | 229.2MB · 221.8% |
| 2 | `20260920-114718` (median) | 2.2s | 0.1 · 2.0 · 0.1 | 4.593 | 225.1MB · 213.0% |
| 3 | `20260920-114723` | 2.1s | 0.1 · 2.0 · 0.0 | 4.508 | 225.8MB · 239.8% |

- **Elapsed time 2.1~2.4s, in peri's range** (peri was 2.2s in the previous batch). All three
  **exit by themselves**, with exit code 0 and no forced termination. Startup is **0.1s** and
  shutdown **0.0~0.1s**. Both fixed costs are nearly zero; almost all time is execution.
- **Request pattern: title first, compaction inserted during execution.** The measured
  105 requests comprise **1 session-title request** (`gemini-3.1-flash-lite-preview`, `tools=0`,
  **first in sequence**, unlike peri's final prediction request), 1 initial main request,
  **100 tool-call rounds**, and **3 context-compaction summaries**, about one every 32 requests,
  with `last=user:"Your main task now is to generate a continuation summary of …"`.
  Thus 100 rounds need **104 script entries** (`gen-long-run.ts --turns 104`): `--turns 100`
  reaches only 96 rounds, and `103` reaches 99. There is no peri-style prediction request,
  so the final blank entry is unused.
- **CU 4.5~4.9**: the same script measured 4.508 / 4.593 / 4.866, **±4%**, more repeatable than
  elapsed time. Under the cross-batch method, it costs more than the previous batch's dsh
  (3.101) and Claude Code (2.828), but remains far below MiniMax Code (31.995).
  Memory is only 9%~10% of its CU; mean RSS is about 207MB, similar to pi's 186MB.
- **Process-tree accounting resembles dsh**: `procs` in `samples.csv` is **always 1** because
  tool shells are too short-lived to be sampled. Their CPU cost is recovered through
  **reaped-child counters** (`child_cpu_pct`): measured 0.32 core·s, 8% of total CPU.
- To add it to the rankings, **repeat the complete batch** with the same `--label`, now
  7 harnesses × 3 runs. Metrics other than CU are comparable only within a batch. The CI workflow
  already installs agy and includes it in batch runs; the next CI batch will use this set.
  The chart page **already shows it**, because `gen-chart-data.ts` selects recent runs under
  `data/runs`, including these three. The page handles mixed batches: each run's payload includes
  its `--label`. If the chart contains two or more batches, a warning at the bottom lists the
  harnesses and labels and states that scores are comparable only within a batch. It disappears
  once the harness joins the batch. To show only batch rankings, generate data with
  `--exclude antigravity`, just like `--exclude opencode`.

## opencode v2 (`opencode2`): integrated, **not yet included in the batch**

> **It is absent from the batch above; these readings must not be placed beside the batch table.**
> As above, three runs took place on 2026-09-20 14:19 (`--label oc2-probe`), at a different time
> and load from the fifth batch. Across batches, **only CU is comparable**. Percentage scores
> and other metrics are not; scores are relative within a batch.

`opencode2 run --standalone` (npm `@opencode/cli` 2.0.10) was integrated on 2026-09-20 as the
eighth harness. It uses **OpenAI Chat Completions**, like peri / opencode v1. It is
**the successor to opencode v1**, from the same project (`github.com/sst/opencode` now redirects
with status 308 to `anomalyco/opencode`) and the same maintainer. Package bins `opencode` and
`opencode2` point to the same v2 binary. **V1 and v2 are separate test subjects**: v1 was removed
from rankings, as noted at the start, and this is a new entry. See “Harness integration” in
`CLAUDE.md` for product details, sandbox, and tool format. Readings:

| Run | runId | Elapsed time | Startup · execution · shutdown | CU | Peak RSS · CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260920-141913` | 9.7s | 0.7 · 8.9 · 0.1 | 9.426 | 695.0MB · 106.2% |
| 2 | `20260920-141926` | 8.9s | 0.4 · 8.4 · 0.1 | 8.440 | 645.7MB · 96.5% |
| 3 | `20260920-141938` (median) | 9.1s | 0.4 · 8.6 · 0.1 | 9.595 | 849.6MB · 105.2% |

- **All three exit by themselves**, with exit code 0 and no forced termination. Startup
  **0.4~0.7s**, shutdown **0.1s**: almost all time is execution.
- **One launcher plus a worker doing the work**: the main CLI uses only **0.20~0.26 core·s**
  over the full run. **95% of CPU is in its spawned child**, `opencode.exe serve --stdio --port 0`,
  at 4.0~4.5 core·s, captured by process-tree sampling rather than reaped-child counters.
  Like Codex, the spawned binary does the work, which is why scoring uses the **process tree**.
  Peak RSS of 645~850MB also comes almost entirely from that child; 2 processes are sampled.
- **Request pattern: title first, no compaction.** There are 102 requests: **1 session title**
  (`messages=2`, no tools, system text "You are a title generator", **first in sequence**),
  **100 tool-call rounds**, and 1 completion response. Therefore 100 rounds require
  **101 script entries** (`--turns 101`); `--turns 100` reaches only 99 rounds.
  It does not insert compaction requests like pi / agy.
- **CU 8.4~9.6**: under the cross-batch method, about 7 times the batch's lowest, pi (1.271),
  and about 6 times Codex (1.383), still far below MiniMax Code (31.995).
  **Memory alone is 50%~54%** of CU. Mean RSS 484~576MB is in the highest CLI range;
  pi 186MB and agy 207MB form one range, while Codex is about 100MB. CPU contributes
  4.2~4.7 core·s.
- **Variation across the three runs is substantial**: elapsed time 8.9~9.7s, CU 8.440~9.595,
  ±7%, worse than agy's ±4%. Running for 9 seconds with hundreds of MB makes readings more
  sensitive to load. However, the three 1-minute load values, 2.8 / 3.8 / 3.8, do not track CU.
  The cheapest run, `…141926` at 8.440, was in the middle; the first run on the least busy
  machine, `…141913`, cost 9.426. **This ±7% looks more like its own variation; do not attribute
  it all to load.** Account for it when citing results across machines.
- Compare only scale with v1: v1 measured **38.6s** when removed, in another, more heavily
  loaded batch; v2 is 9.1s here. **Do not subtract durations across batches.** Ranking v2
  requires repeating the complete batch, now 8 harnesses × 3 runs. CI already installs the
  package and includes it in batch runs; the next CI batch will use this set.

## Hermes Agent (`hermes`): integrated, **not yet included in the batch**

> **It is absent from the batch above; these readings must not be placed beside the batch table.**
> As in the previous two sections, three runs took place on 2026-09-20 14:45~14:46
> (`--label hermes-probe`), one day after the fifth batch. Local 1-minute load was **4.1~4.3**,
> versus 2.9~3.8 in the fifth batch. Across batches, **only CU is comparable**. Percentage scores
> and other metrics are not; scores are relative within a batch.

`hermes -z` (Nous Research's Hermes Agent, v0.21.3 / 2026.9.14, installed by official `install.sh`
at `~/.local/bin/hermes`) was integrated on 2026-09-20 as the ninth harness. It uses
**OpenAI Chat Completions**, like peri / pi / dsh / mcode / opencode2. See “Harness integration”
in `CLAUDE.md` for sandbox, provider injection, and tool format. Three serial runs of the same script:

| Run | runId | Elapsed time | Startup · execution · shutdown | CU | Peak RSS · CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260920-144542` | 10.7s | 5.9 · 4.8 · 0.1 | 10.587 | 203.3MB · 134.2% |
| 2 | `20260920-144556` (median) | 10.8s | 6.0 · 4.7 · 0.1 | 10.706 | 201.1MB · 131.8% |
| 3 | `20260920-144610` | 11.0s | 6.2 · 4.7 · 0.1 | 10.918 | 203.3MB · 133.0% |

- **All three exit by themselves**, with exit code 0 and no forced termination. Shutdown takes
  **0.06~0.11s**: the main flow stops after the final plain-text completion response, without
  peri's 5s wait or Codex's shutdown network timeout. **Repeatability is good**: elapsed time
  ±1.4%, CU ±2%, more stable than agy's ±4% and opencode2's ±7%.
- **Most cost is startup, which saturates one core**: a fixed **5.9~6.2s** before the first
  request. From the first sample at t≈0.3s, **CPU stays near 100%**, 99.7~104.4%, rather than
  waiting idle. RSS remains 102~110MB for the first 3 seconds and reaches 135~174MB only in
  second 5. The segment consumes 5.43~5.67 core·s ≈ **0.93 cores × 6s**, or **6.10~6.38 CU**
  at 1:1, **58% of total CU**. The 100-round execution segment is only 40%, at 4.25~4.44 CU.
  This is the largest startup cost measured in this project, consistent across all three runs;
  the previous highest was MiniMax Code at 1.22s / 1.69 CU. Its `logs/agent.log` records only
  three browser-plugin registration lines about 0.3s after process start, then nothing until
  the first request. **These 5.7s are neither mock cost**, since no request exists yet,
  **nor interpreter cold startup**, since `hermes --version` takes 0.25s. An unused-port proxy
  makes no difference either: 7.87s versus 7.83s in `CLAUDE.md`. The root cause remains unknown;
  record it as Hermes's fixed cost.
- **Accounting resembles dsh**: `procs` in `samples.csv` is **always 1** because tool shells
  are too short-lived to sample. Mean RSS 147~148MB / peak 201~203MB belong to the main process.
  The 100 tool shells appear in **reaped-child counters**, at 1.26~1.35 core·s, 14% of total CPU.
- **Request pattern: 104 script entries = 100 tool rounds.** Include both additional costs:
  1. **Session-title generation** (`stream=false`, `messages=2`, no tools, system text
     "You name chat sessions.") starts almost simultaneously with the main request.
     **Order varies**: in 5 measurements, the title came first 3 times and the main request
     first 2 times. Together they consume one extra initial entry.
  2. **One compaction during execution**: at about 170 context messages, it inserts a
     `messages=1` request with
     `last=user:"You are a summarization agent creating a context checkpoint."`.
     History then falls to 21 messages, followed immediately by a main request that restates
     the original task (`messages=21`). **Both requests consume entries.**
  Thus `--turns 102`, meaning 102 rounds + 2 final entries = 104 entries, gives exactly
  100 tool rounds; `--turns 101`, 103 entries, gives only 99. The 103 requests in this run are:
  1 main request + 1 title + 1 compaction summary + 1 post-compaction restatement +
  **99 continuation requests carrying tool results**. This is one fewer than the round count
  because the tool result immediately before compaction is included in the summary instead
  of being sent separately. **Do not count rounds by `last=tool` requests**; check which
  script entry was executed. **After** the main flow finishes, it may also request a skill-library
  review (`last=user:"Review the conversation above and update the skill library."`).
  This consumes the final **blank** entry, the same position as peri's prediction request.
  It occurred once in 4 measurements, producing 104 requests that time. It never uses a tool
  round, so the blank entry is useful here too.
- **CU 10.6~10.9**: under the cross-batch method, about **8 times** the fifth batch's most
  efficient pi (1.271), **7.7 times** Codex (1.383), and above opencode2's 8.4~9.6 measured
  the same day, though still far below MiniMax Code's 31.995. **CPU contributes 9.03~9.32 core·s**:
  mean 72.6~73.1%, peak 131.8~134.2%, with brief multithreaded concurrency. **Memory is only
  15%**, at 1.56~1.60 GB·s = 1595~1635 MB·s. Mean RSS 148MB is in pi's 186MB range.
  **The cost is CPU × time, not memory.**
- Ranking requires **repeating the whole batch**, under one `--label`, now 9 harnesses × 3 runs.
  Metrics other than CU are comparable only within a batch. CI already installs hermes,
  generates its script, and runs it in the batch; the next CI batch will use this set.
  The chart page **already shows it** because `gen-chart-data.ts` selects recent runs from
  `data/runs`. The page handles mixed batches: every run includes its `--label` in the payload.
  If two or more batches appear, a warning names the harnesses and labels and says scores
  are comparable only within a batch; it disappears after batch integration. To show only
  batch rankings, use `--exclude hermes`, like `--exclude antigravity`.

## Cline (`cline`): integrated, **not yet included in the batch**

> **It is absent from the batch above; these readings must not be placed beside the batch table.**
> As in the previous three sections, three runs took place on 2026-09-20 15:15
> (`--label cline-probe`, local 1-minute load about 2.5), one day after the fifth batch.
> Across batches, **only CU is comparable**. Percentage scores and other metrics are not;
> scores are relative within a batch.

`cline` (npm `cline@3.0.62`, `apps/cli` in the official `cline/cline` repository) was integrated
on 2026-09-20 as the tenth harness. It uses **OpenAI Chat Completions**, like peri / pi / dsh /
mcode / hermes. See “Harness integration” in `CLAUDE.md` for sandbox, provider injection,
tool format, and request pattern. Three serial runs of the same script:

| Run | runId | Elapsed time | Startup · execution · shutdown | CU | Peak RSS · CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260920-151500` (median) | 5.1s | 0.9 · 2.3 · 1.9 | 3.397 | 706.1MB · 138.4% |
| 2 | `20260920-151508` | 4.8s | 0.8 · 2.4 · 1.6 | 3.381 | 707.7MB · 124.5% |
| 3 | `20260920-151516` | 5.2s | 0.9 · 2.5 · 1.8 | 3.814 | 704.3MB · 142.3% |

- **All three exit by themselves**, with exit code 0 and no forced termination.
  Elapsed time **4.8~5.2s**: startup **0.8~0.9s**, execution **2.3~2.5s**, shutdown **1.6~1.9s**.
  **Shutdown is a fixed wait without requests** (`idleTail`), about one-third of total duration.
  It resembles peri's 5.0s and Codex's 10.1s, at a smaller scale. The main flow finishes on
  receiving the final text, but then makes no requests for about 1.8s. The cause is unknown;
  record it as a fixed cost. Runs at different loads remain in the same range: 1.6 / 1.8 / 1.9s.
- **This idle wait costs 33%~43% of total CU**. Segment integrals: startup 0.08 CU / 2%,
  execution 1.78~2.26 CU / 52%~62%, **shutdown 1.12~1.47 CU / 33%~43%**.
  Shutdown is almost entirely memory integral. CPU is nearly idle, at 0.08~0.16 core·s,
  but about 700MB stays resident for 1.8s, giving 1.0~1.3 GB·s under the 1:1 method.
  Like Codex's former 10s wait, **idle waiting with zero CPU still costs resources**, recorded
  in the memory term. Memory is 62%~66% of total CU, mostly from this wait.
- **A Node launcher plus a working child process**: the npm bin is a resolver script,
  at 60MB RSS and nearly zero CPU throughout. Its spawned single-file binary does the work.
  `procs` in `samples.csv` varies between 1~2, with 2 in 30/50 samples. **Root CPU is
  0.035 core·s, child CPU 1.13~1.43 core·s: 97% is in the child.** Like Codex / opencode2,
  this supports using the **process tree** for scoring.
- **Its CU is a lower bound because of an accounting gap; adjust expectations upward**.
  Tool commands create a short-lived shell under that child. A `sleep 2` probe makes `procs`
  reach 3 and shows this structure. Normal shells do not survive the 2s process-tree refresh
  window, while their CPU enters the **child's**, not the root's, `ri_child_*` counters.
  The sampler reads only the **root's** counters, so this cost reaches neither `tree_cpu_pct`
  nor `child_cpu_pct`. Local `sh -c` measurements suggest 2~3ms each × 100 rounds ≈
  0.2~0.3 core·s, roughly one-fifth of total CPU, so true CU should be slightly higher.
  This differs from dsh / agy / hermes, whose shells are direct children of the **root**
  and are therefore captured by its counters.
- **Request pattern: one compaction consumes one script entry**, with default
  `--compaction agentic`. The 102 requests comprise 1 initial request (`messages=2`, system + user),
  99 continuations with tool results, **1 compaction summary** (`messages=2`,
  `last=user:"Summarize this session for continuation. Be concise and fact…"`; the response
  becomes a summary and its tool call is not executed), and 1 post-compaction continuation
  carrying the final tool result (`messages=40`). This is **100 tool rounds + 1 compaction +
  1 completion response**, with no title-generation step, unlike opencode2 / dsh / agy / hermes.
  Thus 100 rounds need **103 script entries** (`--turns 101`, or `101 + 2 final entries`).
  A 200-round measurement compacted twice; allow one extra entry per 100 rounds, rounded up.
- **CU 3.38~3.81**, ±8%: under the cross-batch method, similar to the fifth batch's dsh (3.101),
  slightly above Claude Code (2.828), and far below MiniMax Code (31.995). **Memory is 62%~66%**,
  with mean RSS 440~458MB and peak about 706MB. This exceeds pi (186MB), agy (207MB), and hermes
  (147MB), and is in opencode2's 484~576MB range. **CPU is only 1.16~1.47 core·s**, so most
  cost is hundreds of MB resident × 5 seconds.
- Peak CPU **124.5%~142.3%** shows multithreaded concurrency: one main-process sample is 35%,
  with the rest in the child, so the process tree can temporarily exceed one core.
  The three 1-minute load values are all about 2.5. Variation is ±4% elapsed time and ±8% CU,
  similar to opencode2's ±7% and greater than agy's ±4%.
- Ranking requires **repeating the whole batch** under one `--label`, now 10 harnesses × 3 runs.
  Metrics other than CU are comparable only within a batch. CI already installs cline,
  generates its script, and includes it in the batch; the next CI batch will use this set.
  The chart page **already shows it**, because `gen-chart-data.ts` selects recent runs under
  `data/runs`; the page handles mixed batches as described above. To show only batch rankings,
  generate data with `--exclude cline`.

## Kimi Code (`kimi`): integrated, **not yet included in the batch**

> **It is absent from the batch above; these readings must not be placed beside the batch table.**
> As in the previous four sections, three runs took place on 2026-09-21 (`--label kimi-probe`,
> local 1-minute load about 2.5), two days after the fifth batch. Across batches,
> **only CU is comparable**. Percentage scores and other metrics are not; scores are relative
> within a batch.

`kimi` (Kimi Code CLI, Moonshot's official single-file native binary, measured version **2.0.0**;
`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` installs into `~/.kimi-code/bin`)
was integrated on 2026-09-21 as the eleventh harness. It uses **OpenAI Chat Completions**, like
peri / pi / dsh / mcode / hermes / cline. See “Harness integration” in `CLAUDE.md` for sandbox,
provider injection, tool format, and request pattern. Three serial runs of the same script:

| Run | runId | Elapsed time | Startup · execution · shutdown | CU | Peak RSS · CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260921-153625` (median) | 3.7s | 1.0 · 2.6 · 0.1 | 4.364 | 603.6MB · 176.8% |
| 2 | `20260921-153540` | 3.8s | 1.1 · 2.5 · 0.2 | 4.490 | 561.0MB · 182.4% |
| 3 | `20260921-153640` | 3.5s | 0.9 · 2.5 · 0.1 | 4.206 | 604.8MB · 181.8% |

- **All three exit by themselves**, with exit code 0 and no forced termination.
  Elapsed time **3.5~3.8s**: startup **0.9~1.1s**, execution **2.5~2.6s**, shutdown **0.1~0.2s**.
  Its 100 tool rounds in just over 2.5s are the fastest in the field; the others take
  2.3~18.2s by the same method, as shown in the batch table. There is **no idle shutdown wait**
  (`idleTail=false`), unlike peri's 5.0s, Codex's 10.1s, and cline's 1.8s fixed costs.
  The main flow exits immediately after receiving the completion text.
- **CU 4.206~4.490**, ±7% across three runs, similar to opencode2's ±7%. Under the cross-batch
  method, this is adjacent to cline-probe (3.38~3.81) and slightly below agy-probe (4.59).
  **Memory is 39%~41%**: mean RSS 476~494MB, peak 561~605MB, higher than pi (186MB), agy (209MB),
  and hermes (147MB), in cline's mean 444MB range. **CPU contributes 2.51~2.73 core·s**, including
  about 0.23 core·s of tool-shell cost captured by reaped-child counters. Its CU is substantial
  because it retains ~490MB throughout its 3.5~3.8s run: **fast does not mean efficient**.
- Peak CPU **176.8%~182.4%**, mean **63.5%~65.6%**: multithreaded use briefly exceeds one core,
  but the mean does not exceed one core as agy's does (173.4%). These are brief multicore
  bursts, not sustained saturation.
- Process-tree `procs` is **always 1**: one native process, without a launcher / worker structure.
  Tool shells are direct children of the **root**. They do not survive the 2s refresh window,
  but their CPU enters root `ri_child_*` counters and is captured by `child_cpu_pct`,
  at 0.230~0.238 core·s/100 rounds. This resembles dsh / agy / hermes,
  **without cline's missing grandchild CPU**, so its CU is not a lower bound.
- **Request pattern is tied with mcode for the clearest**: 101 requests = 1 initial request
  (`messages=4`: system + user with an auto-permission system-reminder) + 100 tool rounds +
  1 completion response. **No title generation**, unlike opencode2 / dsh / agy / hermes;
  **no compaction**, since the final `messages=204` request remains below
  `max_context_size = 262144`; and no peri-style prediction. Thus the default
  **102 script entries** (`--turns 100`) complete exactly 100 rounds.
- Ranking requires **repeating the whole batch** under one `--label`, now 12 harnesses × 3 runs.
  Metrics other than CU are comparable only within a batch. CI already installs kimi,
  generates its script, and includes it in the batch; the next CI batch will use this set.
  The chart page **already shows it**, since `gen-chart-data.ts` selects recent runs under
  `data/runs`; the page handles mixed batches. Use `--exclude kimi` to show only batch rankings.

## ccode (`ccode-cli`): integrated, Linux batch readings

`ccode-cli --write --auto-approve -p '<prompt>'` uses OpenAI Chat Completions. Provider settings
come entirely from environment variables: `CCODE_API_BASE` includes `/v1`, `CCODE_API_KEY` is
fake, and `CCODE_MODEL` sets the model. Isolation uses `CCODE_SESSION_DIR` pointing to the
sandbox, instead of its default `~/.ccode/sessions`. `--write` is required because the default
tool set is read-only. `--auto-approve` avoids confirmations that cannot be answered in headless
mode. The tool format is `bash` + `{command}`, like pi / mcode.

**Request pattern: stop at the limit.** `--turns N` maps to ccode's `--max-turns N`.
**The demo always sets this flag explicitly.** Without caller `--turns`, it passes 0, ccode's
unlimited setting. Omitting it would restore ccode's default 50, completing only half a 100-round
script while still drawing a bar; CU alone would not reveal this. The original project's CI
batch does not set `--turns`, so this rule is required. Measurements with `--max-turns N` and
an N-round script produce exactly N requests and omit the final completion response:
3 requests for a 3-round smoke check, 100 for a 100-round long script. With no limit, it runs to
the final script entry, giving rounds + 1 requests. A limit above the script length behaves
the same: a measured 50-round script with `--max-turns 100` produced 51 requests.

**It is the only harness in this batch near the sampler's resolution limit.**
100 rounds take 0.26s, yielding only 24 samples at 10ms. Startup and shutdown cannot be measured;
segment CU is 0.000 / 0.111 / 0.000. **Use CU for this row, not peak CPU**: at 10ms, one tick
represents a full 100%, so any run that does work in the sample window reaches 99%.
This is quantization, not load. CU is unaffected because it integrates differences in cumulative
CPU; both macOS rusage and Linux procfs backends use differences, not a percentage multiplied
by a separately measured interval. It does not depend on peak selection.

Readings: `--label 265k-linux`, 3 serial runs, Linux / Intel Core Ultra 7 265K / 10ms procfs /
process tree. The table shows the median run; all three elapsed times are 0.2~0.3s.
Peak CPU is not meaningful at this duration and is omitted:

| Run | Elapsed time | Requests | CU | Core·s | GB·s | Mean CPU | Mean / peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `20260922-003430` | 0.26s | 100 | **0.114** | 0.1132 | 0.0009 | 47.2% | 3.8MB / 4.4MB |

This is the lowest of 14 harnesses in the same batch; peri is second at 0.606, pi third at 1.417.
At this scale, it resembles the bare cost of startup + 100 HTTP round trips + 100 `sh -c` calls,
rather than runtime overhead.

## Combined score (**Beta**): CPU and memory 1:1

> **Status: Beta, on trial since 2026-09-19.** This project sets the coefficients. The
> implementation is verified: integration at each sample, selection of the larger descendant
> CPU value, and estimation of the final unsampled interval. However, **the method itself is
> not final**. Whether descendant CPU counts as harness overhead, and whether duration should
> cover elapsed time or controlled execution time, remain under discussion. The rankings below
> are therefore **readings under a candidate method**, not a verdict on a harness. Use them to
> inspect trends and cost components; do not treat rank as the conclusion. The method and
> coefficients are defined only in `scripts/perf/score.ts`, whose header also marks them Beta.
> This section only reports readings. To change the method, change that definition and repeat
> a complete batch.

Neither duration nor memory alone answers which harness uses fewer resources. Pi is fastest at
1.3s but retains an average 186.2MB; peri takes 0.9s longer but uses only 54.7MB. Codex is most
expensive per round at 59.8ms, yet ranks second because it runs for only 6 seconds. To obtain
one scalar, the formula structure comes from Alibaba Cloud Function Compute (FC):
“CU usage = ∑(resource usage × CU conversion coefficient)”. CPU and memory are converted to
one unit and added, matching the question here. FC's coefficients for active elastic instances,
checked against its official pricing page on 2026-09-19, are:

```
CU usage = ∑(resource usage × CU conversion coefficient)
Elastic instances (active): vCPU 1.0 CU/(vCPU·s) · memory 0.15 CU/(GB·s)
                            invocations 75 CU/10,000 (= 0.0075 CU/invocation) · disk 0.05 CU/(GB·s)
```

**This project borrows only the formula structure and sets its own coefficients:
CPU and memory have the same cost per second, 1:1.**

```
CU     = 1.0 × core·s + 1.0 × GB·s
core·s = ∫(tree_cpu_pct / 100) dt      GB·s = ∫(tree_rss_kb / 2^20) dt
score  = 100 × smallest CU in this batch / this run's CU   (best = 100; higher cost gives a lower score)
```

For sampled data, the integral is **accumulated sample by sample**, every 100ms with intervals
from actual timestamp differences, not estimated as mean × duration. Memory integral is shown
below in **MB·s** (`GB·s × 1024`). Changing display units does not change the method.
There are **four deliberate differences from FC**, also documented in the `score.ts` header:

1. **The coefficient is not FC's 0.15**: this project measures resource burden, with equal CPU
   and memory cost; see the rationale below.
2. **Memory is measured RSS**, not FC's declared capacity × duration. Only measured data is
   available, and measurement also makes comparison fairer.
3. **Disk is excluded** because there is no data, and **GPU is excluded** because this project
   does not sample GPUs. Duration covers **elapsed time through normal exit**, rather than
   FC's controlled execution time.
4. **Invocation counts are not converted**: the script determines request count, which is not
   harness overhead. This batch has pi at 135 requests versus the others at 101~102.
   Applying FC's 0.0075 CU/request would penalize pi's 34 extra compaction requests,
   which are a strategy choice.

| Harness | CU | Score | Core·s | MB·s | Memory share of CU | Descendant CPU | Startup / execution / shutdown CU (separate integrals) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.271** | **100.0** | 1.031 | 246 | 19% | 0.183 (counter) | 0.140 / 1.037 / 0.000 |
| Codex 0.155.1 | 1.383 | 91.9 | 0.644 | 757 | 53% | 0.618 (sampled) | 0.000 / 1.352 / 0.000 |
| peri 3.17.0 | 2.102 | 60.5 | 1.983 | 122 | 6% | 1.261 (counter) | 0.190 / 1.816 / 0.000 |
| Claude Code 2.1.277 | 2.828 | 45.0 | 2.156 | 688 | 24% | 0.592 (counter) | 0.134 / 2.586 / 0.000 |
| dsh 0.1.5-rc.2 | 3.101 | 41.0 | 2.408 | 710 | 22% | 0.665 (counter) | 0.688 / 2.342 / 0.000 |
| MiniMax Code 0.4.12 | 31.995 | 4.0 | 19.967 | 12316 | 38% | 0.414 (counter) | 1.685 / 29.641 / 0.444 |

Interpretation:

- **This measures resources used to complete the same script, not who finishes first.**
  Codex is second-slowest at 6.1s but second-lowest in CU at 1.383, because it runs for only
  6 seconds. Conversely, peri is tied for second-fastest at 2.2s but third in CU, because of
  the CPU integral for its 100 tool shells. For response speed, use elapsed time; for resource
  cost, use CU. They answer different questions.
- **Codex's rank directly reflects the fix**: previously 3.294 CU, 47.2 points, fourth place,
  including a 1.760 CU shutdown segment waiting with zero CPU and about 160MB resident.
  After the fix: 1.383 CU, 91.9 points, second place, and a zero shutdown integral.
- **Memory is a substantial term under the new method**: it contributes 6%~53% of CU here.
  Codex is the extreme, with only 0.644 core·s, of which 0.618 belongs to a child.
  MiniMax Code has the largest absolute memory integral, 12316 MB·s, 101 times peri's.
  **This is the point of 1:1**: memory is no longer a minor remainder in the total;
  memory efficiency affects the score.
- **Peri ranks third through low memory use**: its 122 MB·s memory integral is the smallest,
  1/6.2 of Codex's. Its CPU term is almost entirely the cost of those 100 tool shells.
  Its 43.7% CPU peak is the only one below a full core.
- **Scores are relative within a batch**: `100 × minimum CU / this run's CU`.
  A different batch, with different load, script, or competitors, changes the scores.
  **Across batches compare only CU**, not scores.

### Why 1:1 instead of copying FC's 0.15

FC's `0.15 CU/(GB·s)` means 1 core ≈ 6.67 GB of memory. That is a cloud provider's price.
The newer AWS Lambda vCPU rates imply **≈7.6**, and Cloud Run **≈9.0**, in the same direction.
At these rates, memory contributes only **1%~8%** of the total, so memory efficiency hardly
influences the score.

This project asks about **resource burden**. For the same script, using one core for a second
and retaining one GB for a second both occupy machine resources; neither is intrinsically
cheaper. State the choice explicitly: **1 core·s = 1 GB·s**, with coefficients in
`CU_COEFFICIENTS` in `score.ts`. Changing them changes the method and must be explicit,
with a complete batch repeated. This choice matters. With the same data, FC's 0.15 gives:
**Codex 0.755 < pi 1.067 < peri 2.001 < Claude Code 2.257 < dsh 2.512 ≪ MiniMax Code 21.771**,
putting Codex first. At 1:1, the order is **pi 1.271 < Codex 1.383 < peri 2.102 < Claude Code 2.828
< dsh 3.101 ≪ MiniMax Code 31.995**. The winner changes: Codex's CPU integral is only 60% of pi's,
0.644 versus 1.031, but its memory integral is 3.1 times larger, 757 versus 246 MB·s.
Increasing memory weight puts pi ahead. The weight at which rankings change is itself useful
data. Explicit coefficients are more honest than hiding behind borrowed numbers.

### Peaks (resource pressure, without conversion)

CU measures **the integral**; peaks measure **the worst moment**. Machine memory capacity is
selected for the peak, so both questions matter. Peaks are not converted to scores:
MB and % are absolute quantities and can be compared directly. A relative score within the
batch would only add another arbitrary number.

| Harness | Peak RSS (process tree) | Peak time | Process count then | Peak CPU |
| --- | --- | --- | --- | --- |
| peri 3.17.0 | **71.7MB** | 2.10s (final sample) | 1 | **43.7%** |
| Codex 0.155.1 | 163.7MB | 3.00s (execution) | 3 | 26.0% |
| dsh 0.1.5-rc.2 | 231.2MB | 3.70s (final sample) | 1 | 128.0% |
| pi 0.85.1 | 234.4MB | 1.00s (execution) | 1 | 128.8% |
| Claude Code 2.1.277 | 351.0MB | 2.10s (final sample) | 1 | 122.4% |
| MiniMax Code 0.4.12 | 892.0MB | 19.60s (execution) | 2 | 177.8% |

Interpretation:

- **Peri is smallest under both memory measures**: integral 122 MB·s and peak 71.7MB.
  Its 43.7% CPU peak is the only one of the six below a full core. Its cost is integrated
  CPU use for 100 tool shells, rather than the resources required at any one moment.
- **Peaks and integrals can point to different harnesses**: Codex's 163.7MB peak is modest,
  but its integral is 6.2 times peri's, 757 versus 122 MB·s. MiniMax Code reaches 892.0MB
  at 19.6s through **continuous growth**, from 170MB at the first sample to 866MB at the last,
  rather than a brief spike.
- **Read the process count at the peak too**: Codex peaks at 3.00s with 3 processes.
  Its 163.7MB includes tool shells, `zsh -lc` and emsdk initialization in local `.zshrc`,
  rather than only its own resident memory. Main-process peak is 41.7MB.
- Peri / dsh / Claude Code peak in the **final sample**. RSS is still growing before exit,
  so the last sample is the maximum. This is another reason to separate peak and integral.

### Method details shared by integrals and peaks

- **Descendant CPU uses the larger of reaped-child counters and sampled descendants**.
  `child_cpu_from` identifies the source. Do not add them: both are lower bounds and may
  overlap when a sampled child is later reaped and its CPU appears again in counters.
  Measurements found that adding them overcounts by 136%. All six recorded descendant CPU
  in this batch. Peri is highest at 1.261 core·s, 64% of its CPU, from shells created for
  each tool call. Codex's 0.618 comes from sampled descendants; the native binary does its work.
- **Estimate the gap from final sample to exit**. Sampling stops when the process disappears,
  leaving about one sampling interval, measured ≈100ms, between the last sample and exit.
  Without an estimate, a fast 1.3s harness such as pi loses about 8% of its cost.
  All six selected runs use the current sampler: `score.tailGapKnown` and `childColumnPresent`
  are true for every run. Each estimate extends the mean rate of the final three samples
  across 100~101ms. Thus **CU in this section is not a lower bound**; older results lacking
  both fields are lower bounds. Peaks are unaffected because they are maxima, independent
  of the unsampled gap.
- **CU accumulates individual samples**, as above. “Startup / execution / shutdown CU” uses
  **segment integrals under the same method**, calculated sample by sample in each segment.
  The only difference from the total is that **the final-gap estimate enters only the total**:
  0.03~0.23 CU in this batch, 0.7%~7.4% per harness. Sample intervals join across segment
  boundaries without overlap or omission. All six measured runs satisfy segment sum + final-gap
  estimate = total. Likewise, select the larger descendant CPU measurement once over the
  whole run, not per segment; per-segment selection can count the same child CPU twice at
  boundaries. Segments show where cost occurs; **do not simply add the three segments**.
- The two sampler measurements in `scripts/perf/sampler.ts` are complementary lower bounds.
  `child_cpu_pct` is the difference in parent rusage `ri_child_user_time` /
  `ri_child_system_time`, cumulative CPU for **reaped children**. Measurements verified offsets
  96/104 and that units are Mach ticks, not nanoseconds. `tree_cpu_pct` covers descendants
  visible in the process table. **Do not add these measurements**; scoring selects the larger.

### CPU calibration: convert local seconds to project standard CPU unit seconds (optional since 2026-09-22)

**Why calibration is needed**: CU is `1.0 × core·s + 1.0 × GB·s`, and core·s uses
**local machine seconds**. The same harness and script might use 0.6 core·s on a fast machine
and 4 core·s on a slow one. That difference reflects machine speed, not harness efficiency.
All batches in the first half of the year came from the same Apple Silicon machine with
18 cores, so the table's CU is comparable only **on the same machine**; across machines,
only structure and rankings can be compared. Calibration addresses this gap: **measure local
speed with a fixed version of the 7-Zip built-in benchmark**, then convert core·s to
**project standard CPU units** of time.

> **This unit is defined by this project; no real reference machine was measured.**
> Baseline = 1000 is the **definition** “1 standard unit·s = 1000 7-Zip normalized benchmark MIPS”,
> not a measurement of a machine. Wording must not say that one local second equals a number
> of seconds on a reference machine. It says how many project standard CPU unit seconds it
> represents. 7-Zip Rating itself estimates relative speed; it is not an instruction count.

```
cpuScale = mean(single-thread R/U) / 1000     ← multiply core·s; CPU term only
standard CPU unit·s = local core·s × cpuScale
CU (rescaled)       = 1.0 × standard CPU unit·s + 1.0 × GB·s     memory is not rescaled (measured locally)
```

**Rescaling can change rankings; it is not merely a unit change.** Only CPU receives the
coefficient; memory remains local GB·s. The terms have different dimensions, so `cu` and
`rawCu` rankings **can differ**. Measurements can reverse ranks: CPU-heavy harnesses move down,
while those using more memory but little CPU move up. The page's percentage `score` also uses
rescaled `cu` and is comparable only within a batch using the same method.

The method is defined in the header of `scripts/perf/calibrate.ts`; its CLI is
`scripts/perf/calibrate-cli.ts`. This section restates it:

- **Fixed 7-Zip 26.01 with fixed arguments `b 1 -mmt1 -md25`**. Read only the `25:` row,
  corresponding to a 2^25 = 32MiB dictionary, with four columns for compression and decompression:
  `Speed / Usage / R/U / Rating`. Changing version or arguments changes the measuring standard.
  Calibration JSON and consumers check both `tool.version` and `tool.args`; approximate matches
  are not accepted.
- **Use the arithmetic mean of single-thread `R/U`**, 7-Zip's processor-frequency-normalized
  millions of instructions per second. Baseline is fixed at **1000 benchmark MIPS per
  CPU-second**: **a project unit based on 7-Zip's historical normalized rating, defined here
  without a real reference machine**, not actual machine instructions or SPEC / cloud vCPUs.
  Floating-point tails affect only display: logs and pages format `cpuScale` to 4 decimal
  places, `9.386899999999999` → `9.3869`; calculations retain full precision.
- **Repeat at least 3 times, default 5, excluding the first warmup run**. Record mean,
  sample standard deviation, and CV for the runs. Warn if CV exceeds the threshold,
  5% single-thread or 10% whole-machine. Such a `cpuScale` represents the machine only as
  observed at measurement time, not a stable standard.
- **A separate `-mmt<threads>` measurement uses mean raw Rating / 1000** as **standard units
  of whole-machine throughput**. Default threads = `availableParallelism()`.
  This is **observed throughput in this measurement**, **not** single-thread reading × logical
  core count. That would be a fabricated measurement; the tool has no such path.
- **Multiply**: on a faster machine, the same core·s becomes **more** standard unit seconds.
  Division would make the faster machine appear cheaper, reversing the intended direction.
  `scripts/perf/calibrate.test.ts` has a specific test for this direction.
- Calibration **does not change CU's 1:1 coefficients**: CPU and memory retain equal cost
  per second. Only the CPU time unit changes, from local seconds to project standard
  CPU unit seconds.

**Usage**:

```sh
bun run cpu:calibrate                                  # → data/calibration/<timestamp>/{calibration.json,*.log}
bun run scripts/perf/run.ts --script … --cpu-calibration data/calibration/<timestamp>/calibration.json
bun run scripts/perf/gen-chart-data.ts --cpu-calibration data/calibration/<timestamp>/calibration.json \
    --out data/perf-chart-calibrated.json              # Save a new file; leave published data/perf-chart.json unchanged
# Preview: http://localhost:8080/docs/perf-chart.html?data=../data/perf-chart-calibrated.json
```

- **Host matching is mandatory**: a calibration is valid only for that machine. Both `run.ts`
  before measurement and `gen-chart-data.ts` before rescaling **compare every field** of the
  calibration JSON host snapshot against the result's `host`: hostname / platform / arch /
  cpuModel / cpus / totalMemBytes. A mismatch fails; **the scale is never silently replaced**.
  Older layouts lack `host` and cannot be used with explicit calibration.
- **Methods must match**: calibrated runs must share `method`, tool version, arguments,
  baseline, and repeat count. **Different machines may have their own scale**, which is the
  purpose of conversion. However, `gen-chart-data.ts` **refuses to generate charts by default**
  when calibrated and uncalibrated runs are mixed, or methods differ. Percentage scores only
  make sense in the same units. Explicit `--allow-mixed-calibration` permits viewing;
  the payload includes `calibration.blocked`, and the page suppresses ranks accordingly.
- **Run results store a summary**: `run.json.cpuCalibration` contains `cpuScale`, baseline,
  raw value, repeat count, binary hash, and method identifier. Raw readings for each run,
  log sha256 values, and all host fields remain in **the calibration JSON itself**, under
  `data/calibration/<ts>/`, with raw warmup/single/machine outputs. The two can be checked
  against each other.

**Historical readings in this section are uncalibrated**: table CU uses local seconds.
The runs above were produced on 2026-09-19~21, before calibration fields existed, so page and
`data/perf-chart.json` values of `cu` equal `rawCu`. Applying calibration to historical results
with `gen-chart-data.ts --cpu-calibration` creates a **local recalculated preview**.
The payload marks `calibration.retrospective = true` / `mode: "local-preview"`, and the page
labels it “historical recalculation”. **Original `run.json` / `samples.csv` remain unchanged**
as an audit requirement.

**Official rankings require a complete new batch**. The user has explicitly permitted only
historical previews for now. This is not because the data is dirty, but because three aspects
of the method have changed: (1) `run.ts` now records calibration in `run.json`, so each result
carries its method; (2) **only CPU is rescaled, while memory remains unchanged, giving different
dimensions and potentially different ranks**, with CPU-heavy harnesses moving down and
memory-heavy, low-CPU harnesses moving up; (3) mixing batches was already prohibited through
`--label`. Thus publication under the new method requires **repeating the complete batch**
on the same machine, with the same `--label` and calibration. Do not combine historical and
new results in one ranking.

## Shutdown and auxiliary requests by harness (measured in this batch)

| Harness | Shutdown segment | Requests during shutdown? | Auxiliary requests measured in this batch |
| --- | --- | --- | --- |
| peri | 0.07s | None | 1 next-input prediction request, sent **after** the main process finishes; it consumes the final blank entry, not a tool round |
| Codex | 0.04s (10.06s before the fix) | None | None |
| Claude Code | 0.06s | — | None |
| dsh | 0.07s | — | 1 session-title request (`messages=2`, consumes script entry 2) |
| pi | 0.02s | — | 34 compaction summaries, one per round from round 70, consuming 34 script entries |
| MiniMax Code | 0.23s | — | None |

- **Peri's 5s was the shutdown grace period for a background Prediction task. The cause is
  known, and the default script removes the wait.** Earlier measurements repeatedly showed
  5.0~5.1s of shutdown, regardless of round count: a 1-round probe also took 5.0s. During this
  quiet interval, CPU was 0%, there were no children or external sockets, and the main thread
  waited in `pthread_cond_wait`. Neither `--bare` nor **killing the mock** removed it.
  Inspection of peri's source and captured stacks located the cause: when `-p` exits, the host
  uses a hard-coded 5s cooperative_grace to wait for tasks it owns. The blocked task is
  `HostTaskKind::Prediction`. After the next-input prediction receives **nonempty** text, it
  falls back to a Placeholder action, continues to write the session title, and stops there
  until the timeout aborts it. The logged interval between prediction completion and
  `aborting host-owned task owner=Session kind=Prediction` is exactly 5.0015s.
  **A claim from the peri side that langfuse environment variables caused the wait did not
  hold in measurements.** This machine has no `LANGFUSE_*` variables, and the code requires
  both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to enable it (`from_env()`, with its only
  initialization in `peri-acp/src/host/assemble.rs`). During shutdown, `lsof` showed no external
  connections. The claim may have come from the langfuse client's coincidental 5s `connect_timeout`.
  **The workaround is a blank response to the prediction request.** When trimmed text is empty,
  `execute_prediction` returns an empty action before acquiring the lock, removing the 5s wait.
  Controlled measurements were 2150 / 2110 / 2149ms with a blank response versus 7096ms with
  nonempty final text: a repeatable 4.95s difference. The long-script generator now always adds
  final text followed by a blank response, in that order. The controlled comparison in that
  batch reduced elapsed time from 7.7s → 2.2s; peri's shutdown in this batch is only 0.07s.
  Remove the final blank entry to reproduce the old readings. A permanent correction still
  requires a peri change: add a timeout to that lock, or reject prediction writes to the session
  during shutdown.
- **Codex's 10s was a network request timeout during shutdown.** With `RUST_LOG=debug`, the log
  appeared exactly 10.0s after the turn ended (`shutdown`):
  `WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=failed to send
  remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex`.
  An export to `https://ab.chatgpt.com/otlp/v1/metrics` also timed out. DNS for `chatgpt.com` on
  this machine was poisoned, returning unreachable addresses such as 108.160.165.189 /
  107.181.166.244. TCP stayed in `SYN_SENT` until reqwest's 10s timeout.
  **This came from the local network environment, not an inherent Codex cost.** Pointing HTTPS
  traffic at an unused port (`HTTPS_PROXY=http://127.0.0.1:9`, leaving the HTTP mock unaffected)
  reduced the same 1-round run from 10.5s to **0.40s**. Each startup also runs
  `git fetch https://github.com/openai/plugins.git` to sync the curated plugin repository.
  This machine cannot complete the transfer; after Codex exits, **the orphan process remains**.
  Check `ps | grep plugins-clone` after a run; abandoned directories accumulate in `$CODEX_HOME/.tmp/`.
  Attempts that **did not help**: `-c features.plugins=false` stops cloning but still waits 10s;
  `-c otel.enabled=false`, `-c chatgpt_base_url=<unused-port>`, and prepopulating `models_cache.json`
  also failed to remove the wait.
  **The fix was applied on 2026-09-19.** The Codex demo now injects uppercase and lowercase HTTPS
  proxy variables only into the harness and its children, pointing to `http://127.0.0.1:9`.
  It also replaces uppercase and lowercase `NO_PROXY` with local addresses to keep the HTTP
  mock connection direct. It does not change system or user global settings. The tradeoff is
  that this sandbox no longer supports scripts that need external HTTPS, and local port 9
  must have no listener. Verification with Codex 0.155.1 and three read-only tool rounds in
  `playground/codex/script.json` showed elapsed time 11.1s / shutdown 10.2s before the fix,
  versus elapsed time 1.0s / shutdown 0.1s after it. Both runs made 4 requests, exited with code 0,
  and successfully executed all three tools. Diagnostic outputs are in
  `data/diagnostics/codex-shutdown/codex/` and are excluded from rankings.
  **The batch in this document is a complete repeat with the new configuration.** For the long
  script, Codex elapsed time changed **16.4s → 6.1s**, shutdown **10.06s → 0.04s**, and
  CU **3.294 → 1.383**, moving from fourth to second. Its CU now arises only during execution.
- **Pi's compaction** proceeds as follows: context reaches its limit, a summary is requested,
  and a new conversation starts with the summary. This occurs progressively, once per round,
  with 34 requests in this batch. **These requests also consume script entries.** Allow for
  main-loop rounds plus compaction requests when preparing the script, or the main loop will
  not complete the expected number of rounds.

## How to interpret the readings

- **Long-script duration includes startup and shutdown deliberately.** A full-run measurement
  should include them, but inspect the segments separately. The `segments` field in `run.json`
  separates startup, execution, and shutdown. **Almost all time in this batch is execution**:
  Codex shutdown is 0.04s after the fix, and MiniMax Code's 0.23s is the largest shutdown cost.
  Do not divide total duration by 100 to calculate cost per round.
- **Shutdown readings have two traps.** They can include a fixed harness wait: peri previously
  had 5.0s, removed by the default script, and Codex had 10.0s, removed by the demo's proxy
  injection in this batch. They can also reflect **the local network environment**: Codex's
  10s was a `chatgpt.com` timeout, which fell to about 0.4s with a working network arrangement;
  see the preceding verification. Check both before comparing durations across machines.
- **Shutdown requires `--exhausted stop`.** A harness does not exit simply because the script
  runs out. `hold` blocks until the fallback timeout, making all duration readings timeout
  values and the measurement useless. `error` returns HTTP 500 instead of task completion.
  With stop, the mock returns plain final text after the script ends, so each harness follows
  its real task-completion path. The generator now writes this response directly into the
  script; stop remains a later fallback. The final blank entry handles peri's extra next-input
  prediction request. **Do not give it nonempty text**, which causes an unnecessary 5s wait.
- **Request count is not round count.** Count requests that include tool results, then inspect
  the number in “consume entry N” to distinguish the main loop from auxiliary requests.
  Each `mock.log` line records `messages=` / `input=` and the final message's role. A script
  that is too short causes a normally working harness to receive the final response too early.
- **Do not divide mean CPU by request count to calculate request overhead.** Harnesses do
  different work each round. Codex starts a new `/bin/zsh -lc` for each tool call, and this
  machine's `.zshrc` also initializes emsdk. MiniMax Code's own processing takes about 185ms
  per round. Use the “Execution per round” column to compare unit costs.
- **The process tree includes tool-call children.** The `procs` column in `samples.csv` shows
  process-count changes: peaks in this batch were Codex 3, MiniMax Code 2, and 1 for the others.
  RSS growth includes the fixed memory of tool children; do not attribute it all to context growth.
- **Peri's `harness.log` is empty after forced termination.** Its `-p` mode flushes only on normal
  exit. This is a known limitation. It exits normally with the long script, so logs are complete.
  The same applies to pi.
- **First and later runs have different initial state.** This batch used already prepared
  sandbox state, including session databases and caches. Cold starts would read higher.
  Sandbox caches were not cleared between rounds; the same rule applied to all six harnesses.
- For individual sample curves, read `data/runs/<harness>/<runId>/samples.csv`
  (`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs,child_cpu_pct`), or use the chart
  page below. Sampling-method verification experiments are in `bun run scripts/perf/verify.ts`.
  The same directory's `run.json` includes `cost` / `peaks`, with separate detailed totals for
  integrated use and peak use.

## Chart page

`docs/perf-chart.html` is a static page. **The combined-score table appears first**, marked
**Beta** because its method is provisional. Its headers group measures by method: combined
score (integrated `CU` / score), components (integrated core·s / MB·s / memory share of CU /
descendant CPU), peak process-tree load (peak RSS / peak CPU), and startup / execution /
shutdown CU, each integrated separately. The formula appears on the page, and rows are sorted
by increasing CU. Below it, line charts show each harness's samples: X is time, and Y can switch
between RSS / CPU and main process / process tree. Lines mark the first and last request times.
Data comes from the repository's `data/perf-chart.json`, fetched as `../data/perf-chart.json`.
`gen-chart-data.ts` selects one run from `data/runs/` and exports a reduced payload.
Scores are **calculated at export time**, so old and new outputs can be compared under the same method.
**Opencode's line is hidden by default and excluded from X-axis scaling**, because it was removed
from the rankings; see the opening note. Click its legend entry to show historical readings.
Its line is dashed, and the horizontal axis extends automatically to 38.6s.

Curves default to a **1s moving-average window**; the page also offers raw / 0.5s / 1s / 2s.
With 100ms sampling, multithreaded harnesses have real CPU spikes: bursts in some samples and
zero in others. Without smoothing, these dominate the chart. In this batch, adjacent samples
differed by more than 30 percentage points at 21 points for MiniMax Code, 3 for Claude Code,
3 for dsh, and 1 for pi, with 0 for peri and Codex. A 1s window reduced all these counts to 0.
Smoothing affects only presentation. Means and peaks in `samples.csv` and the page's summary
table always use raw readings.

Two more chart conventions apply. **Each curve's peak is labelled with its harness name**, for
both CPU and memory. Labels identify the displayed curve, so the indicated peak changes with
the smoothing window. **The memory Y-axis is reversed**, with 0 at the top and greater use lower
down, matching the sense of increasing memory burden. The CPU axis keeps its usual direction.

```sh
bun run scripts/perf/gen-chart-data.ts --exclude opencode   # This batch: select the median of each harness's latest 3 runs.
bun run scripts/perf/gen-chart-data.ts --pick 20260919-204152 --pick 20260919-204208 …   # Or select runs explicitly.
bun run scripts/perf/gen-chart-data.ts --cpu-calibration data/calibration/<ts>/calibration.json \
    --out data/perf-chart-calibrated.json --allow-mixed-calibration   # Calibrated historical preview, saved separately.
cd <repository-root> && python3 -m http.server 8080        # The page fetches JSON; CORS blocks file://.
# → http://localhost:8080/docs/perf-chart.html
# → http://localhost:8080/docs/perf-chart.html?data=../data/perf-chart-calibrated.json   # Preview another payload.
```

**Calibration**, described above: the main CU chart uses the payload's rescaled `score.cu`.
The method section also shows an **original / rescaled comparison table** with `raw CU` /
`standard core·s` / `GB·s` / `cpuScale` / rescaled `CU`, plus the tool version, measurement time,
host, single-thread CV, and measured equivalent whole-machine throughput for `-mmt<n>`.
The formula is still displayed **only from the payload's `scoreFormula.lines`**; the page does
not maintain its own formula. `?data=` **accepts only relative paths from the same origin**.
Absolute URLs, `//host`, and `data:` are rejected. Previewing another payload therefore does
not modify the published `data/perf-chart.json`, including historical fields such as `cu2`
that the generator no longer emits: every byte stays unchanged.

Chart.js first tries the unpkg CDN (`chart.js@4`) with a **2s timeout**, then falls back to
`docs/vendor/chart.umd.min.js` in the repository. That directory is ignored by Git and may
not exist on another machine. With this machine's PAC browser proxy, measurements showed that
the public CDN hung instead of returning an error. The timeout is necessary, and the page
cannot load it with a static script tag: headless loading stalled at the CDN and never rendered
the page. **The fallback is the usual path.** No page build is needed; edit the JSON and refresh.

## Grok Build (`grok`): integrated, **not yet included in the batch**

> **It is not in the batch above, so these readings must not be placed alongside that batch's
> table.** 3 readings were taken on 2026-09-26 with `--label grok-probe`, on an Apple M4 Pro
> with 12 cores and a 1-minute load of about 5.3. **Only CU can be compared across batches.**

`grok` (Grok Build 1.0.41, installed by the official `install.sh` into `~/.grok/bin`) uses
**OpenAI Chat Completions**. The sandbox, `config.toml`, and tool format are described in
the “Grok Build” section of `CLAUDE.md`. The same 100×4KB script ran three times serially;
all runs exited normally with code 0. The first row is the run with median elapsed time:

| Run | runId | Elapsed time | Startup · execution · shutdown | Requests | CU | Peak RSS · CPU |
| --- | --- | --- | --- | ---: | ---: | --- |
| 1 | `20260926-125311` (median) | 5.1s | 0.35 · 4.68 · 0.09 | 103 | **2.357** | 102.6MB · 63.8% |
| 2 | `20260926-125319` | 5.0s | 0.36 · 4.60 · 0.06 | 103 | 2.381 | 104.5MB · 74.5% |
| 3 | `20260926-125327` | 5.1s | 0.35 · 4.62 · 0.15 | 103 | 2.411 | 105.1MB · 75.5% |

The median run used 1.875 core·s + 0.482 GB·s. Mean RSS was 96.7MB and mean CPU was 26.9%.
`procs` stayed at 1. The 0.502 core·s from short-lived shells is included in the root process's
child counters, so CU is not a lower bound.

All three runs consumed entries the same way: **103 requests = 1 session title + 100 tool rounds
+ 1 final response + 1 dashboard line**. The title request has `messages=2`, consumes the first
tool entry, and does not execute that tool call. The dashboard request consumes the final blank
entry (`last=user:"Write an ultra-short dashboard line…"`). With `context_window = 1000000`,
the last tool request has `messages=204` and no compaction occurs. The script therefore uses
`--turns 101`, giving 103 entries.

Including Grok in the rankings requires a complete batch repeat. CI already installs `grok`
1.0.41, generates `long-run-grok.json`, and counts it among the sixteen harnesses.
