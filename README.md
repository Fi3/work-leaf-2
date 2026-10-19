# Harness

Harness runs a personal coding agent on one Linux machine. The Rust server owns
one Pi worker. Neovim and scripts use the same private Unix socket. Pi Durable
stores conversations, inputs, tool results, and final answers in SQLite.
[SPEC.md](SPEC.md) is the requirements source. The files in `dev-docs/` are saved
references. They are not implementation instructions.

## Start

From this directory, run:

```sh
./harness.sh
```

The script installs the locked Pi dependencies if they are absent. It builds the
Rust command and opens Neovim with your normal configuration and the plugin.
Press `;` in normal mode to open the left agent tree. No editor setup is needed.
From another project directory, run `/path/to/work-leaf-2/harness.sh`.
The script keeps that project as the working directory.

Use Rust **1.94.1**, Node **26.10.0**, npm **12.2.0**, and Neovim **0.12.6**.
The Rust toolchain file selects the required compiler, formatter, and Clippy.
Older editor versions are not supported by the current test evidence.

Press `n`, or select **+ New chat** and press Enter. A saved chat opens at once.
No name or setup dialog blocks it. The small message box is at the bottom of the
tab. Type a task and press **Enter** to send it. **Shift-Enter** adds a line.
Use **Ctrl-J** if your terminal does not send Shift-Enter. Ctrl-S also sends.

For the first AI chat, type `\model` and press Enter. Select an Anthropic model
from the list. Type `\login` to enter your API key in a private terminal. Model
use can incur charges. For a test without a key, type `\model demo`. The local
demo gives fixed replies; it does not provide AI coding.

New chats use the settings of the newest chat in that directory that has a model.
A child uses its parent's settings. Model, instructions, and name changes apply
to an idle chat without a server restart. Each chat keeps its own conversation.
An unconfigured chat keeps your draft and shows how to select a model.

The key stays only in the server environment. It is not saved to disk. After the
server stops, use `\login` again, or set `ANTHROPIC_API_KEY` before startup.
Key replacement requires an idle server. Active or unfinished work prevents
replacement and is preserved. Key entry makes no model request; it cannot prove
that the provider accepts the key.

`harness setup` remains available to set startup defaults in
`${XDG_CONFIG_HOME:-$HOME/.config}/harness/config.json`. Chat settings are stored
with their Pi conversation and do not require this file.

Optional configuration keys include `instructions`, `node_path`, `worker_path`,
`state_dir`, and `socket_path`. Relative paths use the configuration directory.
A custom state directory requires a distinct socket path. Unknown keys fail.

## Use the agent tree

An agent is a stored chat session. The tree lists agents in the current directory.
It does not list agents from other directories. A child appears under the agent
that created it. A child has its own task and history. Stopping a parent does not
stop its children.

| Key | Action |
| --- | --- |
| `;` in normal mode | Show or hide the left tree. |
| `Enter` on an agent | Select its chat. |
| `n`, or Enter on **+ New chat** | Open a new chat immediately. |
| `h` / `l` in the tree | Close / expand the selected agent's children. |
| `s` on an agent | Stop that agent's active task. |
| `r` in the tree | Refresh the stored agent list. |
| `q` in the tree | Hide the tree. |
| `Enter` or `Ctrl-S` in the message box | Send the prompt. |
| `Shift-Enter` or `Ctrl-J` in insert mode | Add a line. |
| `Tab` after `\` | Complete a chat command. |
| `p` in the conversation | Move to the message box. |
| `h` in the conversation | Load older messages. |

Type these commands in the message box and press Enter. `/` also works as the
command prefix. Commands are local controls; they are not submitted as tasks.

| Command | Action |
| --- | --- |
| `\model` | Choose a model. `\model provider/model` selects it directly. |
| `\model demo` | Use fixed local replies without a key. |
| `\provider` | Choose a provider, then a model. |
| `\login` | Enter the Anthropic key in a private terminal. `\auth` also works. |
| `\name Review` | Rename this chat to Review. |
| `\instructions Give short answers.` | Set instructions for later tasks. No text clears them. |
| `\new` | Open another chat in this directory. An optional name follows. |
| `\child` | Open a child of this agent. An optional name follows. |
| `\context buffer` | Attach the source buffer, including unsaved text. |
| `\context selection` | Attach the last visual selection as complete lines. |
| `\stop` | Stop this chat's active task. |
| `\history` | Load older messages. |
| `\status` | Show local model and credential readiness. |
| `\upgrade` | Replace an idle older server and reconnect. |
| `\help` | Show chat commands. |

The conversation uses the normal file area. The three-line message box is below
it. Files and chats are normal listed buffers: use `:buffers`, `:buffer NAME`,
`:bnext`, or **Ctrl-^** to switch between them. From the message box, press Escape
before a normal command. Ctrl-^ also works directly in the message box.
The message box closes when you select a file and returns when you select a chat.
Opening a chat preserves unsaved file text. Normal Neovim write checks still
apply when you switch away from a modified file.

Each chat keeps its own draft. Each tab restores its selected chat. The tree
follows that tab's directory.
During startup, the first action waits for chat creation. Later text stays in
the box. It cannot replace that action or become a task in another chat.

The conversation shows streamed replies, tool activity, and task state. At
narrow widths, a terminal resize hides the tree to leave room for the conversation.
Press `;` to show it again. Normal Neovim window commands still work.

The interface uses the saved [Pi TUI guidance](dev-docs/interfaces/pi-tui/overview.md)
and [Neovim layout guidance](dev-docs/neovim-ui/layout.md): native input, visible
controls, retained drafts, and layouts that fit the terminal. Key entry uses a
native terminal. Rust reads the key directly; Lua does not receive it.

## Watch the demonstration

[Open the screen recording](tests/evidence/harness-demo.mp4). Text below the
recording explains each action. It shows the actual Neovim window, Rust server,
and Pi adapter. The recording starts without a configuration file or key and
uses the Pi faux provider for repeatable replies and tool calls. It makes no
paid model request. See the [recording report](tests/evidence/harness-demo.json)
for the action times, checks, and video hash.

## Install the command

For use without the source launch script, run:

```sh
sh scripts/install.sh "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds the locked release binary. It installs the worker and its
complete locked dependencies under `share/harness`. It installs the editor files
under `share/harness/nvim`. It does not change your editor configuration.

From your project directory, run:

```sh
harness nvim
```

This opens the same editor interface. Press `;` to show the tree. Opening the
tree starts or connects to the server. Loading the plugin alone starts no work.

Use `harness nvim --config PATH` for another server configuration. The launcher
also accepts `--socket PATH`. Put a custom `state_dir` in the configuration file.
The source script accepts the same options: `./harness.sh --config PATH`.

After an update, an older running server can use an incompatible chat interface.
Harness detects this before it sends a task. Run `harness upgrade`, or use
`:Harness upgrade` in Neovim. The chat command `\upgrade` also works. Upgrade
keeps stored chats and unsent editor drafts. It replaces the server only when all
work is finished. It waits for the old worker to release storage before startup.
An active task, a different state directory, or a newer unknown interface blocks
the upgrade. After replacement, use `\login` if a provider key is needed.

## Use from a script

```sh
harness start
harness session create --id work --workspace "$PWD"
harness session configure --session work --provider faux --model test
printf '%s\n' 'Run the tests and explain failures.' |
  harness send --session work --request-id tests_001 --stdin
harness wait --session work --request-id tests_001 --text
```

The workspace must be an existing absolute directory. Its canonical path stays
fixed for that session. Use `session configure` to change the model, instructions,
or name while the chat is idle. The example selects the local demo. Select an
Anthropic catalog model and supply a key to perform AI tasks.

`session create` accepts `--name` and `--parent`. `session list --workspace "$PWD"`
filters by the canonical directory. Built-in Bash tools receive the current
`HARNESS_SESSION_ID`, `HARNESS_SOCKET`, and `HARNESS_EXECUTABLE`. A `session create`
command from that tool uses the current session as its parent unless `--parent`
is supplied. The agent can use the existing send, wait, and stop commands for
children. No second tool system is required.

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

Server and script commands accept `--socket PATH`, `--config PATH`, and `--state-dir PATH`.
`start`, `auth`, `setup`, and the editor startup path can start a missing server.
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

To use Harness when you open Neovim directly, add the installed runtime directory
to your Neovim configuration. This is optional with `harness nvim`:

```lua
vim.opt.runtimepath:append(vim.fn.expand('~/.local/share/harness/nvim'))
require('harness').setup({ executable = vim.fn.expand('~/.local/bin/harness') })
require('harness').enable_sidebar()
```

Optional settings are `config_path`, `socket_path`, `workspace`, `autostart`,
`width`, and `prompt_height`. Defaults are local autostart, width 72, and prompt
height 3. The legacy `width` option is accepted; chat panels use the tab width.
Loading the plugin starts no process and makes no provider request.

| Command | Action |
| --- | --- |
| `:Harness` | Open the chat in the file area; start or reconnect. |
| `:Harness sidebar` | Show or hide the agent tree. |
| `:Harness new` | Open a new chat in the source window's directory. |
| `:Harness login` or `:Harness setup` | Open the private credential terminal. |
| `:Harness upgrade` | Replace an idle older server and reconnect. |
| `:Harness sessions` | Select a stored session. |
| `:Harness attach ID` | Attach to a specified session. |
| `:Harness send` | Send the prompt and explicit context snapshots. |
| `:Harness stop` | Stop the displayed active submission. |
| `:Harness status` | Show connection and session state. |
| `:Harness history` | Load an older transcript page. |
| `:Harness context buffer` | Attach the source buffer, including unsaved text. |
| `:'<,'>Harness context selection` | Attach the complete selected lines. |
| `:HarnessQuit` | Request normal editor exit. |

Chat history is read-only. Each chat is a listed `harness://chat/ID` buffer.
Its editable input is an unlisted `harness://prompt/ID` buffer. Use normal buffer
commands to switch between chats and files. The draft remains available.
The launcher enables the normal-mode `;` mapping. A direct plugin load adds it only when you call
`enable_sidebar()`. File context must be inside the session workspace. Context
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
The current reply includes `api_revision: 2`. Clients check this revision before
they use chat settings or directory filters. The explicit upgrade command also
accepts the known older revision for identity checks and idle shutdown only.
Notifications are only for watches. Each `session.state` notification replaces
the previous snapshot. A reconnect needs a new watch. There is no event replay.
See [the shared fixtures](tests/fixtures/protocol.json) for exact record shapes.

`configuration.get` takes an optional `session_id`. It returns the chat settings
when supplied, or the server defaults otherwise: provider and model, local
readiness, an explanatory message, and the supplied Anthropic model list. Its `issue` is `missing_model`, `invalid_model`, `missing_key`, or
null. It never returns a key or calls the model. This local configuration status
is separate from the recovery status in `system.hello`.

`session.create` accepts optional `name` and `parent_session_id`. It can create a
chat without a model or key. A supplied parent must be in the same canonical
workspace. The parent link stays fixed. `session.configure` accepts `session_id`
and one or more of `name`, `instructions`, or the `provider`/`model` pair. It
updates Pi settings and metadata in one transaction. Active chats reject changes.
`session.list` accepts an optional `workspace`; its cursor belongs to that filter.

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

The complete release gate passed on **2026-10-19** with the final source files. It passed
formatting, Clippy with warnings denied, 54 Rust tests, the release build, four
adapter syntax checks, and 61 Node tests. The Node tests include 48 adapter tests,
three actual server script tests, and ten actual server recovery tests. Independent
Node test files run concurrently with separate temporary directories and sockets.

Neovim passed both headless suites, **60 actual terminal cases with the Rust
server and Pi faux provider**, and 43 terminal cases with controlled protocol
fixtures. The actual tests cover each normal exit command, exact answers, write
failures, hidden modified buffers, multiple sessions, another client, completion
and new work during the prompt, connection failure, and Escape during a pending
stop. They also cover streamed text, tool output, editor response, unsaved context,
startup, retained drafts, duplicate retries, and forced-exit recovery.

The new interface checks start without a configuration file or key. They verify
immediate chat creation, model/name/instruction commands, retained input when a
model is missing, Enter to send, Shift-Enter for a new line, and 120-, 80-, and
60-column layouts. They check exact directory filtering, real child branches,
selection, folding, targeted stop, and separate drafts and source windows in two
tabs. A real Bash tool creates a child through the Rust command client; Enter
then opens that child's separate conversation.

The file and chat tests use the normal content window. They check `:buffer`,
`:bnext`, and Ctrl-^ from chat history and input, separate drafts, modified files
with `nohidden`, preserved file settings, multiple tabs, and focus during streamed
output. The screen recording also shows these file and chat transitions.

Headless tests delay startup and receipts. They verify that the first action
keeps its text and target, later text stays in the draft, empty Enter does not
block commands, and queued model changes cannot be overtaken by a task. They also
check native command completion, private key entry callbacks, and reconnection.
They check a queued settings command after switching during creation, and clear
upgrade errors when autostart is disabled.
Eleven Rust setup tests use actual terminal devices and Pi. They check hidden
key input, restored terminal flags, private writes, retained settings, credential
precedence, write failures, and rejection while work is active.
An additional [actual key-entry test](tests/evidence/nvim-auth.json) uses Neovim,
the Rust server, Pi, and a synthetic key. It checks cancellation, retry, retained
drafts, server readiness, hidden input, and zero model requests. Its compressed
[terminal recording](tests/evidence/nvim-auth-terminal.raw.gz) contains no key.

Regression tests cover the `admission` session name, unchanged caller output
flags, default configuration state identity, late receipts after session changes,
and retained history across new snapshots. New backend tests cover atomic chat
settings through process kills, metadata watch updates, inherited settings,
directory-scoped cursors, response capacity, and nested child recovery. A child
continues when its parent is stopped. No test makes a paid model request.

An additional [prior-server test](tests/evidence/legacy-upgrade.json) reproduces
`Unknown parameter field` when Enter uses the previous chat client with an old
server.
The fixed client detects the mismatch before admission. The actual terminal test
then checks refusal during active work, explicit idle upgrade, retained history
and draft, and one successful Enter submission with its final answer. Unknown
newer interfaces are rejected without shutdown. Rust tests also check state
identity and storage ownership release during upgrade.

The [installed-server check](tests/evidence/live-runtime.json) records replacement
of the old local server with the checked release binary. The state directory is
unchanged. The server and Pi worker report ready, and the chat configuration
request succeeds. This check creates no chat and makes no model request. The
default server has no model selected; use `\model` in a new chat.

The clean-install check built and installed into a new temporary prefix. It used
the complete locked npm tree with install scripts disabled. The installed Rust
binary, installed Pi worker, and installed Neovim runtime passed the smoke test.
The installed `harness nvim` command loaded the normal user configuration without
manual plugin setup. Pressing `;` opened the tree; Enter opened the selected agent.
Enter then sent a task and displayed its final answer. Normal buffer commands
switched between the installed chat and a file in the same content window.
A separate first-use source check started with no npm packages or build output.
The script installed the locked packages and used its own Rust toolchain, even
when the caller's project selected another compiler and target. Actual Neovim
retained the caller's directory and started no server before the first command.
All 70 saved reference hashes still match the catalog. `SPEC.md` is unchanged.

See the [release report](tests/evidence/release.json),
[complete check output](tests/evidence/release.log),
[actual terminal results](tests/evidence/nvim-real.json),
[fixture terminal results](tests/evidence/nvim-fixture.json),
[clean-install report](tests/evidence/clean-install.json), and
[first-use source report](tests/evidence/source-launch.json) with its
[installation log](tests/evidence/source-launch.log).
The terminal reports link to compressed recordings and include their byte hashes.
The release report records hashes of the checked source files.

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo build --locked --release
node --test adapter/test/*.test.mjs
nvim --headless -u NONE -l tests/nvim/run.lua
nvim --headless -u NONE -l tests/nvim/view.lua
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
| A24 | Idle startup, no generation before input, stored metadata, and credential exclusion in the script and adapter tests. |
| A25 | Four active sessions, client/request/watch bounds, worker restart limits, independent sessions, and output limits. |
| A26 | Paused recovery rejects every operation that can resume pending work; terminal reads remain available. |
| A27 | Shutdown races and state-directory identity in the actual recovery and server tests. |
