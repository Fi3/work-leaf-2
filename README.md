# Harness

Harness runs a personal coding agent on one Linux machine. The Rust server owns
one Pi worker. Neovim and scripts use the same private Unix socket. Pi Durable
stores conversations, inputs, tool results, and final answers in SQLite.
[SPEC.md](SPEC.md) is the requirements source. The files in `dev-docs/` are saved
references. They are not implementation instructions.

## Install

Use Rust **1.94.1**, Node **26.10.0**, npm **12.2.0**, and Neovim **0.12.6**.
The Rust toolchain file selects the required compiler, formatter, and Clippy.
Older editor versions are not supported by the current test evidence.

From this directory, run:

```sh
npm ci --ignore-scripts
sh scripts/install.sh "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds the locked release binary. It installs the worker and its
complete locked dependencies under `share/harness`. It installs the editor files
under `share/harness/nvim`. It does not change your editor configuration.

Create `${XDG_CONFIG_HOME:-$HOME/.config}/harness/config.json` with this content:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "instructions": "Work in the selected workspace. Explain the result."
}
```

Set `ANTHROPIC_API_KEY` in the server environment before startup. Do not put the
key in the configuration file. There is no default paid model. The initial hosted
provider is Anthropic. Tests use Pi's faux provider and need no provider key.

Optional configuration keys are `node_path`, `worker_path`, `state_dir`, and
`socket_path`. Relative configuration paths use the configuration directory.
A custom state directory requires a distinct socket path. Unknown keys fail.

## Use from a script

```sh
harness start
harness session create --id work --workspace "$PWD"
printf '%s\n' 'Run the tests and explain failures.' |
  harness send --session work --request-id tests_001 --stdin
harness wait --session work --request-id tests_001 --text
```

The workspace must be an existing absolute directory. Its canonical path stays
fixed for that session. The model, instructions, and tools also stay fixed.
Create another session to change these settings.

Keep each request identifier until its admission is known. A retry with the same
identifier returns the original submission. Replacement text does not run. Use
a new identifier for a new task. One session can have one active input. Four
sessions can run at the same time.

Use `harness status` to check the server and `harness session list` to list
sessions. `harness watch --session work` prints snapshots. `harness wait` accepts
`--timeout-ms N`. A timeout or client interruption leaves the run active.
To stop a run, use its stored submission identifier:

```sh
harness stop --session work --submission-id ID
harness shutdown
```

Shutdown succeeds only when all sessions are idle. It does not cancel work.
`harness restart-worker` makes an explicit recovery attempt when the worker is
absent or paused by recovery checks. SIGTERM is an administrative server exit.
It preserves unfinished work. Use `harness start` to recover that work.
Changing provider credentials requires a new server environment.

All commands accept `--socket PATH`, `--config PATH`, and `--state-dir PATH`.
Only `start` and the editor startup path start a missing server.
Standard output contains JSON results, NDJSON streams, or the requested answer
text. Diagnostics go to standard error.

| Exit status | Meaning |
| --- | --- |
| 0 | Operation succeeded, or wait returned a final answer. |
| 1 | Run ended without an answer for another reason. |
| 2 | Invalid arguments or configuration. |
| 3 | Connection, compatibility, or availability failure. |
| 4 | Wait timed out; work can continue. |
| 5 | Wait observed explicit cancellation. |
| 6 | Busy, conflict, or resource limit. |
| 130 | Client interrupted; work can continue. |

Stop returns zero after it confirms the target's stored terminal outcome.
Its JSON result distinguishes completion from cancellation.

## Use from Neovim

Add the installed runtime directory to your Neovim configuration:

```lua
vim.opt.runtimepath:append(vim.fn.expand('~/.local/share/harness/nvim'))
require('harness').setup({ executable = vim.fn.expand('~/.local/bin/harness') })
```

Optional settings are `config_path`, `socket_path`, `workspace`, `autostart`,
`width`, and `prompt_height`. Defaults are local autostart, width 72, and prompt
height 6. Loading the plugin starts no process and makes no provider request.

| Command | Action |
| --- | --- |
| `:Harness` | Open the transcript and prompt; start or reconnect. |
| `:Harness new` | Create a session in the source window's workspace. |
| `:Harness sessions` | Select a stored session. |
| `:Harness attach ID` | Attach to a specified session. |
| `:Harness send` | Send the prompt and explicit context snapshots. |
| `:Harness stop` | Stop the displayed active submission. |
| `:Harness status` | Show connection and session state. |
| `:Harness history` | Load an older transcript page. |
| `:Harness context buffer` | Attach the source buffer, including unsaved text. |
| `:'<,'>Harness context selection` | Attach the complete selected lines. |
| `:HarnessQuit` | Request normal editor exit. |

The transcript is read-only. The prompt is editable. Hide either panel with
normal window commands. The draft remains available. The plugin creates no
global key mappings. File context must be inside the session workspace. Context
does not save the buffer. Pi tools read and change server files. Normal Neovim
file-change checks apply to clean buffers.

Final-window `:q`, `:qa`, `:wq`, `:wqa`, and `:HarnessQuit` check every session
attached by this editor. The prompt lists active session and submission IDs.
Type exact lowercase `yes` and press Enter to continue those runs in the
background. Type exact lowercase `no` and press Enter to stop those targets
before exit. Stopping also affects other connected clients. Escape, empty input,
or other text cancels the exit. A failed state check or stop keeps the editor open.
Normal writes and modified-buffer checks still apply. In Neovim 0.12.6, `:wq`
writes before the exit event; `:wqa` writes after it. The guard keeps the original
command and its write intent.

Forced exits, `:noautocmd`, process kills, and crashes can bypass the guard.
They never imply a stop. Reconnect with `:Harness` to get the actual stored state.

## Public protocol

The socket uses a JSON-RPC 2.0 subset. Each UTF-8 JSON object ends with LF.
Call `system.hello` with `api_version: 1` before other operations. Request IDs
are connection-local strings; `request_id` is the durable input identifier.
Notifications are only for watches. Each `session.state` notification replaces
the previous snapshot. A reconnect needs a new watch. There is no event replay.
See [the shared fixtures](tests/fixtures/protocol.json) for exact record shapes.

`harness rpc` proxies these records through standard input and output. Keep its
input open for watches. On input EOF, it drains pending responses, releases its
watches, and exits. It never retries mutations without an explicit request.

This example needs only Python's standard library. Set `HARNESS_SOCKET` to the
socket reported by your configuration. It does not start the server:

```python
import json, os, socket

with socket.socket(socket.AF_UNIX) as connection:
    connection.connect(os.environ['HARNESS_SOCKET'])
    stream = connection.makefile('rwb')
    def request(identifier, method, params):
        record = dict(jsonrpc='2.0', id=identifier, method=method, params=params)
        stream.write(json.dumps(record).encode() + b'\n')
        stream.flush()
        return json.loads(stream.readline())
    print(request('hello', 'system.hello', {'api_version': 1}))
    print(request('sessions', 'session.list', {}))
```

Records are limited to 4 MiB, including LF. Combined input text is limited to
1 MiB and 16 context attachments. Snapshots are limited to 512 KiB. Item previews
are limited to 8 KiB. `entry.read` returns at most 64 KiB on UTF-8 boundaries.
Use it to read complete stored answers. A connection permits 32 pending requests
and eight watches. The server permits 32 clients. Slow watches keep only the
latest pending snapshot. Non-watch output is bounded to 4 MiB per client.

## Storage and recovery

Defaults are `$XDG_CONFIG_HOME/harness/config.json`,
`$XDG_STATE_HOME/harness`, and `$XDG_RUNTIME_DIR/harness/control.sock`.
Without these XDG variables, use `$HOME/.config/harness/config.json`,
`$HOME/.local/state/harness`, and `run/control.sock` below the state directory.
The worker owns `agent.sqlite`. No Rust module opens Pi tables. Directories use
mode 0700; managed files and sockets use mode 0600. Managed symbolic links and
wrong owners are rejected.

An inherited operating-system lock remains held while the server or worker can
own storage. An orphan worker blocks a replacement. The Linux server collects
ordinary tool descendants after worker failure. It permits three automatic
worker restarts in 60 seconds. Further recovery requires `restart-worker`.
Before recovery starts, all unfinished work must restore its fixed configuration.
One blocked session keeps the shared Pi scheduler paused. Stored terminal queries
remain available. Duplicate lookup precedes new-work readiness and capacity checks.

The built-in `read`, `write`, `edit`, and `bash` tools retain Pi's replay policies.
Interrupted unsafe calls are not repeated automatically. Cancellation does not
undo effects that already completed. Deliberately detached processes and external
services are outside this cleanup guarantee. Tools use the server user's rights.
Use trusted workspaces.

Pi's SQLite WAL NORMAL mode protects committed state against process failure.
It does not promise that the newest commits survive power loss. Logs exclude
input bodies, tool output, and credential values. They use two files of at most
10 MiB each. Transcript content can contain sensitive user or workspace text.

## Dependency baseline

The published Pi Durable, Pi AI, and Chord **1.3.0** artifacts come from source
commit `71023aec1546d6d677a65669c5665c0927ce0dd0`. The saved reference commit,
`4dd2b149d155d7369de16ea4dc77c84e9f5ffb24`, is ten commits later. The direct
package manifests match. The reviewed changes add optional compaction settings,
tool-control typing, Google retry recognition, and OpenAI/Google tool-output
fixes. They do not block the selected Anthropic provider. No Pi fork is used.

| Inventory | Measured count |
| --- | ---: |
| Rust direct dependencies | 3 |
| Rust transitive dependencies | 9 |
| Rust distinct external package/version pairs | 12 |
| Rust separate application build/test dependency declarations | 0 |
| npm direct dependencies | 3 |
| npm transitive dependencies | 88 |
| npm distinct installed package/version pairs | 91 |
| npm optional-only, development, or test installs | 0 |
| Lua external dependencies | 0 |

Rust uses only `serde` 1.0.229 with derive, `serde_json` 1.0.154, and `libc`
0.2.190. They provide typed JSON, JSON values, and missing Linux process
operations. Five transitive crates support derive compilation. Seven crates
contain build scripts. These scripts inspect the compiler or target and generate
local output; they do not download code or invoke a native compiler.

Installed npm package files total **78,677,813 bytes**. The audited Rust registry
sources total **10,498,438 bytes**. These are file-byte totals, not disk allocation.
The direct provider-import probe loaded 792 files, with 2,124,184 source bytes,
from Pi Durable, Pi AI, Chord, TypeBox, and diff. Anthropic's SDK loads when used.
Selective imports do not remove mandatory packages. Unused mandatory features
include other provider SDKs, OAuth support, image WASM, code-mode WASM (including
its `.so` extension files), and telemetry support. They remain in the audited tree.

The three duplicate npm package names have reviewed causes.
`@aws-sdk/token-providers` 3.1127.0 and 3.1150.0 come from Bedrock and newer SSO
dependencies. `https-proxy-agent` 7.0.6 and 9.1.0, and `agent-base` 7.1.4 and
9.0.0, come from Google's gaxios tree and Pi AI's proxy versions. Direct Pi
packages use MIT. Direct Rust crates use MIT OR Apache-2.0. The npm tree uses
MIT, Apache-2.0, BSD-3-Clause, Unlicense, and 0BSD licenses.

Both npm lifecycle scripts were reviewed. The Google preinstall script prints
a message. The protobufjs postinstall script prints a version warning. Neither
is needed here. Install scripts stay disabled. On 2026-10-16, `npm audit` reported
zero known vulnerabilities, npm signature/provenance checks passed, and the
RustSec database had no advisory entries for the selected crates.

Machine evidence records exact licenses, repositories, versions, integrity
values, duplicate versions, and scripts:
[npm inventory](tests/evidence/npm-dependencies.json),
[Rust inventory](tests/evidence/rust-dependencies.json),
[npm security report](tests/evidence/npm-security.json),
[Rust security report](tests/evidence/rust-security.json),
[Pi artifact provenance](tests/evidence/pi-provenance.json),
[npm load report](tests/evidence/npm-loaded.json),
[reviewed baseline](tests/evidence/dependency-baseline.json), and both lockfiles.
`sh scripts/check-dependencies.sh` rejects changes outside the reviewed baseline.

## Verification

Run `sh scripts/check.sh` for the deterministic release checks. Each integration
test uses temporary workspaces, state directories, and sockets. No test needs
paid provider access. The faux provider controls responses and actual coding
tools execute local test commands.

The initial integration probes passed atomic metadata creation and rollback,
SQLite reopen, duplicate lookup before busy checks, atomic watch attachment,
stored cancellation, paused preflight reads, and safe/unsafe replay. The initial
editor proof passed 35 real terminal cases on Neovim 0.12.6. It also proved that
scheduled callbacks continue during the modal prompt. Source review confirmed
that invalidating the original window cancels the original exit command.

The complete release gate passed locally on **2026-10-16** with the final source
files. It passed formatting, Clippy with warnings denied, 27 Rust tests, the
release build, four adapter syntax checks, and 44 Node tests. The Node tests
include 33 adapter tests, three actual server script tests, and eight actual
server recovery tests. Independent Node test files ran concurrently with separate
temporary workspaces and sockets.

Neovim passed its headless checks, **52 actual terminal cases with the Rust server
and Pi faux provider**, and 43 terminal cases with controlled protocol fixtures.
The actual tests include each normal exit command, exact answers, write failures,
hidden modified buffers, multiple sessions, another client, run completion and
new work during the prompt, connection failure, and Escape during a pending stop.
They also cover layout, streamed text, tool output, editor response, unsaved
context, startup, retained drafts, duplicate retries, and forced-exit recovery.

The clean-install check built and installed into a new temporary prefix. It used
the complete locked npm tree with install scripts disabled. The installed Rust
binary, installed Pi worker, and installed Neovim runtime passed the smoke test.
All 70 saved reference hashes still match the catalog. `SPEC.md` is unchanged.

See the [release report](tests/evidence/release.json),
[complete check output](tests/evidence/release.log),
[actual terminal results](tests/evidence/nvim-real.json),
[fixture terminal results](tests/evidence/nvim-fixture.json), and
[clean-install report](tests/evidence/clean-install.json).
The terminal reports link to compressed recordings and include their byte hashes.
The release report records hashes of the checked source files.

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo build --locked --release
node --test adapter/test/*.test.mjs
nvim --headless -u NONE -l tests/nvim/run.lua
sh scripts/check-dependencies.sh
```

The terminal test commands use Python 3's standard library, without added
packages:

```sh
python3 tests/nvim/interactive.py
python3 tests/nvim/real.py --group exit
python3 tests/nvim/real.py --group integration
```

The release gate also includes each adapter's `node --check`, the real-server
script and recovery groups, real terminal Neovim tests, and a clean installation.

The tests cover the acceptance criteria as follows. The terminal tests send real
keys through a terminal device. They inspect editor state, disk contents, and
stored Pi outcomes. They also retain the terminal output.

| Criteria | Evidence |
| --- | --- |
| A01 | Simultaneous starters, one worker, private paths, and ownership checks in `tests/server.rs`. |
| A02, A06 | Proxy EOF, client death, forced editor exit, and reconnect in the script, recovery, and real terminal tests. |
| A03–A05 | Exact exit answers, window closure, modified buffers, hidden buffers, and write failures in the terminal tests. |
| A07–A09 | Lost receipts, duplicate text, busy sessions, and duplicate lookup after process restart in the adapter, script, and editor tests. |
| A10 | Watch attachment during generation, complete initial state, and convergence to the stored answer in the adapter tests. |
| A11 | Slow public clients, worker output pressure, retained stop replies, and bounded invalid-request streams in the server and worker tests. |
| A12 | Wait timeout, disconnected waits, later stored outcomes, and client SIGINT in the adapter, client, and script tests. |
| A13–A16 | Stops during generation and shell execution; descendant cleanup; old targets; process kills before and after abort and result storage. |
| A17 | Actual process kills with safe and unsafe Pi tool policies in `adapter/test/replay.test.mjs`. |
| A18–A19 | Orphan ownership, delayed lock release, unsafe storage paths, and injected commit failure in the server, recovery, and adapter tests. |
| A20 | Unsaved buffer and selection text, unchanged disk and buffer state, and workspace containment in the real editor and adapter tests. |
| A21 | Actual create, send, wait, watch, full text, stop, and proxy operations in `tests/scripts.test.mjs`. |
| A22 | Shared invalid requests, frame boundaries, combined records, versions, and byte limits in Rust and Node; shared Unicode snapshots and transport in Neovim. |
| A23 | Complete Unicode answers larger than previews, with byte chunks and invalid-offset checks. |
| A24 | Idle startup, no generation before input, fixed metadata, and credential exclusion in the script and adapter tests. |
| A25 | Four active sessions, client/request/watch bounds, worker restart limits, independent sessions, and output limits. |
| A26 | Paused recovery rejects every operation that can resume pending work; terminal reads remain available. |
| A27 | Shutdown races and state-directory identity in the actual recovery and server tests. |
