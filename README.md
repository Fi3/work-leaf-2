# Harness

Harness runs a personal coding agent on one Linux machine. The Rust server owns
one Pi worker. Neovim and scripts use the same private Unix socket. Pi Durable
stores conversations, inputs, tool results, and final answers in SQLite.
[SPEC.md](SPEC.md) is the requirements source. The files in `dev-docs/` are saved
references. They are not implementation instructions.

## Start

Run from this directory, including in an ordinary SSH session:

```sh
./harness.sh
```

The script installs the locked Pi dependencies if they are absent. It builds the
Rust command and opens Neovim with your normal configuration and the plugin.
Press `;` in normal mode to open the left agent tree. No editor setup is needed.
From another project directory, run `/path/to/work-leaf-2/harness.sh`.
The script keeps that project as the working directory.
After an editor update, close Neovim and run the script again to load the changes.
**Through SSH, browser login uses copy and paste.** No local Harness install or
port forwarding is needed. Follow [Use through SSH](#use-through-ssh).

Use Rust **1.94.1**, Node **26.10.0**, npm **12.2.0**, and Neovim **0.12.6**.
The Rust toolchain file selects the required compiler, formatter, and Clippy.
Older editor versions are not supported by the current test evidence.

Press `n`, or select **+ New chat** and press Enter. A saved chat opens at once.
No name or setup dialog blocks it. The small message box is at the bottom of the
tab. Type a task and press **Enter** to send it. **Shift-Enter** adds a line.
Use **Ctrl-J** if your terminal does not send Shift-Enter. Ctrl-S also sends.

Press **F1** in the chat or message box to open **Chat actions**. Use this menu
to connect an account, choose a model, attach source text, stop work, or create
a chat. The menu keeps the complete draft. Escape returns to the previous input.
You can also use `:Harness actions`.

For the first AI chat, select **Connect an account**. Select your provider, then
the account or API key method. For a ChatGPT account, select **OpenAI**, then
**Sign in with ChatGPT**. The login opens in a terminal that accepts input at
once. **On a local desktop**, Firefox, or your default browser, opens automatically.
Complete sign-in in the browser and keep the Neovim login window open until it
finishes. No return address needs to be copied on a local desktop.
**Through SSH**, use **Copy link** and follow the copy-and-paste steps below.
Empty or space-only input keeps login open.

On a local desktop, click **Open browser** or press **Ctrl-O** to open the
current sign-in page again.
The short control uses the complete address. It does not depend on the terminal
detecting an address in the visible text. **Copy link** or
**Ctrl-X** copies the complete browser link when you need it. The browser
link stays complete when it wraps or the window size changes. For device login,
**Ctrl-Y** copies the separate device code. Follow the provider's instructions.
Escape leaves terminal input mode and keeps sign-in open. Press `i` to enter
input mode again. **Cancel** or **Ctrl-C** cancels and returns to the retained
draft. On a local desktop, Neovim opens one browser tab for each new login link.
The server does not open an extra browser tab. A local browser launch failure
leaves the login open and shows the retry and copy actions. Through SSH,
Neovim waits for you to copy the link to your local browser.

On a local desktop, Copy uses your configured Neovim clipboard. Without one,
it uses Neovim's bundled terminal clipboard writer. Through SSH, Copy always
uses that writer to reach your local terminal's clipboard. No clipboard
configuration is required in a terminal that permits these writes. The notice
says **Copy requested** because a terminal can refuse the request.

**Ctrl-L**, or **Full link**, shows the complete URL in a normal text buffer
and puts it in the Vim register. Use `y$` to copy the complete logical line.
Enter or Escape returns to login input. Login accepts a pasted
callback or code when the provider requests one. The `\login` command remains
available.
In standalone `harness auth`, Ctrl-O opens the browser on a local desktop, or
copies the link through SSH. Ctrl-L shows the complete address. The normal
terminal display uses the same short control.

**Through SSH, “Unable to connect” at `127.0.0.1:1455` after browser sign-in is
expected.** Copy the full address from the browser address bar. Paste it into
the open Neovim login terminal and press Enter. Do not close that login window.
For other providers, follow the displayed code or return-address prompt.
On a local desktop, a cancelled or closed login cannot receive a callback. Close
that old browser tab and start a new login.

After login, choose a model for the new chat. Use **F1 → Choose a model**, or
type `\model`, to see
all models from the providers supplied by the pinned Pi release. Each row names
its provider and shows if login is needed. Use arrow keys, Page Up, Page Down, or the mouse wheel.
Use `/` to search, `G` to reach the last choice, and Enter or a double-click to
select. Escape cancels. The list marks the current model and shows your position
and the total number of choices. Model use can incur charges.
For a test without an account, type `\model demo`. The local
demo gives fixed replies; it does not provide AI coding.

New chats use the settings of the newest chat in that directory that has a model.
A child uses its parent's settings. Model, instructions, and name changes apply
to an idle chat without a server restart. Each chat keeps its own conversation.
An unconfigured chat keeps your draft and shows how to select a model.

Pi stores account tokens and API keys in the private application database. They
remain available after a restart. Login does not replace the worker or stop
existing work. API key entry makes no model request; it cannot prove that the
provider accepts the key. Provider environment variables also remain available.
Saved login credentials take precedence over the provider's environment variable.
The provider list shows **API key** or **account login** to identify the method
currently in use. `\status` also identifies the method. A cancelled or failed
account login keeps the previous credentials, including an environment API key.
Credential presence does not prove that the account has access or available usage.
Pi's OpenAI account method uses the subscription token flow documented in
[OpenAI's sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
On a local desktop, the browser returns to Pi automatically. Through SSH, paste
the complete browser return address into the active login window to finish.
If a run fails, the chat shows the cause and a recovery action after your message.
For a quota or credit error, check the provider's billing or use `\login` to
connect another account. For an OpenAI account login, use `\login openai` and
select **Sign in with ChatGPT**. Login does not resend a failed task. Send it again
after you correct the account. Partial replies and unsent drafts remain available.
The login menu contains the methods supplied by the pinned Pi release: 41 key
or environment methods and nine account methods across 42 providers. The local
demo is a separate choice and needs no login.

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
| `F1` in the chat or message box | Open chat actions and keep the draft. |
| `Shift-Enter` or `Ctrl-J` in insert mode | Add a line. |
| `Tab` after `\` | Complete a chat command. |
| `p` in the conversation | Move to the message box. |
| `h` in the conversation | Load older messages. |

Type these commands in the message box and press Enter. `/` also works as the
command prefix. Commands are local controls; they are not submitted as tasks.

| Command | Action |
| --- | --- |
| `\actions` | Open the same menu as F1. |
| `\model` | Choose a model. `\model provider/model` selects it directly. |
| `\model demo` | Use fixed local replies without a key. |
| `\provider` | Choose a provider, then a model. |
| `\login` | Choose a provider and account or API key method. `\login openai` selects the provider directly. `\auth` also works. |
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
In a split layout, it stays below that chat and uses only that chat's width.
Native file explorer commands retain their normal behavior. In NERDTree, Enter
replaces the file or chat in the content window, `s` opens a vertical split, and
`i` opens a horizontal split. The replaced chat stays in the buffer list.
Opening `:new`, `:vnew`, or `:split` from the input uses the main editor area.
`:q` in the input closes only that box. Press `p` in the chat to open it again.
Closing the chat removes its input box. Drafts remain available when you reopen
the chat. Opening a chat preserves unsaved file text. Normal Neovim write checks still
apply when you switch away from a modified file.

Each chat keeps its own draft. Each tab restores its selected chat. The tree
follows that tab's directory.
During startup, the first action waits for chat creation. Later text stays in
the box. It cannot replace that action or become a task in another chat.

The conversation shows streamed replies, tool activity, and task state. If the
chat column is too narrow, Harness hides its own tree to leave room for the chat.
Press `;` to show it again. Normal Neovim window commands still work.
When another tree closes, the agent tree keeps its normal width. It does not take
the space needed by file and chat windows.

The interface uses the saved [Pi TUI guidance](dev-docs/interfaces/pi-tui/overview.md)
and [Neovim layout guidance](dev-docs/neovim-ui/layout.md): native input, visible
controls, retained drafts, and layouts that fit the terminal. Login uses a
native terminal. The Pi adapter reads it directly. API keys and stored account
tokens do not pass through Lua state or public protocol records. Lua handles the displayed login
link and device code for the explicit clipboard actions.

## Watch the demonstration

[Watch the current chat workflow](tests/evidence/chat-workflow.mp4).
Captions above the screen explain each action. The recording shows the source
launcher, a new chat, F1 actions, model search, cancellation with the full draft
retained, unsaved source attachment, streamed output, and a real Bash tool that
creates a child agent. It then opens a file with NERDTree `s` and returns to the
child's own input and draft. The [report](tests/evidence/chat-workflow.json)
records each action and the video hash. Responses use the Pi faux provider.

[Watch SSH copy-and-paste login](tests/evidence/ssh-manual-login.mp4).
The recording shows the SSH instructions, a click on **Copy link**, local
Firefox sign-in, the expected callback error, and the full return address
pasted into Neovim. The retained draft then receives a controlled reply.
Captions explain each action. The [recording report](tests/evidence/ssh-manual-login.json)
records the checks and video hash. The test sets the editor's SSH environment
and uses a local proxy to refuse the browser callback. It uses actual Neovim,
Rust, Pi, and Firefox with synthetic account replies; it does not test an SSH
connection or a real subscription. Playback is half speed.

[Watch local browser sign-in](tests/evidence/browser-login.mp4).
This recording uses actual Firefox, Neovim, Rust, and Pi. It shows the
automatic browser launch, empty input, explicit cancellation, and a fresh attempt.
It then uses Escape and a normal click on **Open browser**. After a
15-second browser wait, Firefox returns to Pi's local callback page. A task with
`openai/gpt-5.6-luna` uses the saved account instead of the environment API key.
The reply uses controlled test data. Captions explain each action.
Playback is half speed. The first frame stays for three seconds; the last
frame stays for four seconds so the result can be read.
The [report](tests/evidence/browser-login.json) records the actions and hashes.
The account page and token replies are test responses. This test does not
validate a real subscription.

[Watch the earlier clipboard controls](tests/evidence/login-controls.mp4).
The recording shows the complete link copied into the actual system clipboard,
native selection, mouse controls, a narrow terminal, and return to the retained
draft. Playback is one-third speed. The last frame stays for four seconds so the
result can be read. Captions explain the actions.
The [report](tests/evidence/login-controls.json)
records the exact copied URL length and hash. Provider replies and browser
completion are controlled test responses; this is not a real account sign-in.

The [earlier full walkthrough](tests/evidence/harness-demo.mp4) has captions below
the recording. It shows the actual Neovim window, Rust server,
and Pi adapter. The recording starts without a configuration file or key and
uses the Pi faux provider for repeatable replies and tool calls. It makes no
paid model request. It also shows OpenAI account login with synthetic provider
replies, model selection, and normal NERDTree Enter, `s`, and `i` actions.
See the [recording report](tests/evidence/harness-demo.json)
for the action times, checks, and video hash.

The [account recovery recording](tests/evidence/provider-recovery.mp4) shows the
reported OpenAI failure, account login, a second task, streamed output, and a
Bash tool result. It uses the actual OpenAI SDK with synthetic provider replies.
It also checks typing after Enter, opening a file, and restoring the chat draft.
Captions explain each action. The [report](tests/evidence/provider-recovery.json)
identifies the test responses and records the checked source hashes.

The separate [real provider recording](tests/evidence/real-provider-failure.mp4)
uses the available OpenAI API key. The provider rejects it for billing or credits.
The corrected interface shows that error and keeps the next draft. A successful
real reply remains unverified until a working account is connected.
The [real provider report](tests/evidence/real-provider-failure.json) records
this limit explicitly.

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
the upgrade. Saved accounts remain available after replacement.

## Use through SSH

Connect with your normal `ssh` command. Start `./harness.sh` in the remote
project, or run the installed `harness nvim`. No local Harness program, special
SSH command, or port forwarding is required. The application detects SSH and
uses copy and paste for browser login. It does not open a remote browser.

For ChatGPT login:

1. In Neovim, use **F1 → Connect an account**, or `:Harness login openai`.
   Select **Sign in with ChatGPT**. Keep this login window open.
2. Click **Copy link**, or press **Ctrl-X**. Paste the complete link into your
   local browser's address bar and open it. **Ctrl-O** also copies through SSH.
3. Complete sign-in in the browser. The browser can then show **Unable to
   connect** at `127.0.0.1:1455`. **This is expected through SSH.** The address
   refers to your local computer; the login waits on the remote computer.
4. Copy the **complete address from the browser address bar**, including the
   query after `?`. Return to the Neovim login window. Paste it and press
   **Enter**. The pasted value is hidden because it contains login data.
5. Wait for login to finish. Neovim returns to your chat. Select a model and
   send your task.

Do not copy the browser's error text or reuse an address from an old login.
Use your terminal's paste command, usually **Ctrl-Shift-V** on Linux.
If clipboard copying is unavailable, use **Full link** or **Ctrl-L**. This
shows the complete link as selectable text. Enter or Escape returns to the
login input. **Ctrl-C** cancels and keeps your draft and saved credentials.
An empty Enter keeps login open.

Other providers can ask for a code instead of a return address. Follow the
prompt in the login window. For **device-code login**, copy the link to your
local browser, enter the displayed code, and approve access. **Ctrl-Y** copies
the device code. No return address needs to be pasted; keep Neovim open until
it reports the result. Radius uses its Pi device-code method through SSH
because its browser method does not accept a pasted return address.
API key entry remains private and does not open a browser.

Automatic browser opening and automatic return remain available when Neovim
and the browser run on the same computer outside SSH.

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
or name while the chat is idle. The example selects the local demo. Select a
provider and model from the catalog, then connect that provider to perform AI tasks.

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
Use `harness auth` in a terminal to select a provider and login method. You can
select them directly, for example:

```sh
harness auth --provider openai --method oauth
harness auth --provider openai --method api_key
harness logout --provider openai
```

Login keeps the running server and stored chats. Logout removes that provider's
saved credentials. It is blocked while the provider has unfinished work.
Credentials supplied by environment variables still apply after logout.

The table below lists every provider in Pi AI **1.3.0**. Harness uses Pi's
existing login and token refresh functions. An account login uses OAuth, a
standard method that lets the provider grant access without giving Harness your
account password. Browser and device-code choices are steps in the listed
account method. API key methods also use the environment variables that Pi
supports for that provider.

| Provider ID | Supported login methods |
| --- | --- |
| `amazon-bedrock` | Bearer token, AWS profile, or existing AWS credential chain. |
| `ant-ling` | API key. |
| `anthropic` | API key; Claude Pro/Max account through browser or copied code. |
| `azure` | Azure OpenAI API key. |
| `baseten` | API key. |
| `cerebras` | API key. |
| `cloudflare-ai-gateway` | API key with Cloudflare account and gateway settings. |
| `cloudflare-workers-ai` | API key with Cloudflare account settings. |
| `deepseek` | API key. |
| `fireworks` | API key. |
| `github-copilot` | Token; GitHub Copilot account through a device code. |
| `google` | Gemini API key. |
| `google-vertex` | Google Cloud API key, Application Default Credentials, or service account file. |
| `groq` | API key. |
| `huggingface` | Hugging Face token. |
| `kimi-coding` | API key; Kimi Code account through a device code. |
| `meta` | API key; Meta account through a device code. |
| `minimax` | API key. |
| `minimax-cn` | API key. |
| `mistral` | API key. |
| `moonshotai` | API key. |
| `moonshotai-cn` | API key. |
| `nvidia` | API key. |
| `openai` | API key; **Sign in with ChatGPT** through the browser. |
| `openai-codex` | Legacy ChatGPT Plus/Pro account through browser or device code. |
| `opencode` | OpenCode API key. |
| `opencode-go` | OpenCode API key. |
| `openrouter` | API key; OpenRouter account through the browser. |
| `qwen-token-plan` | API key. |
| `qwen-token-plan-cn` | API key. |
| `qwen-token-plan-individual` | API key. |
| `radius` | API key; Radius account through browser or device code. |
| `together` | API key. |
| `typesafe` | API key; this release has no TypeSafe chat models. |
| `vercel-ai-gateway` | API key. |
| `xai` | API key; SuperGrok or X Premium account through a device code. |
| `xiaomi` | API key. |
| `xiaomi-token-plan-ams` | API key. |
| `xiaomi-token-plan-cn` | API key. |
| `xiaomi-token-plan-sgp` | API key. |
| `zai` | API key. |
| `zai-coding-cn` | API key. |

Cloud and gateway providers can require project, region, or endpoint settings in
addition to login. Follow the prompts supplied by Pi and the provider's setup
instructions. The initial catalog contains 1,614 chat models. Radius can update
its model list after login; the saved list is available after a restart without
a network request. The separate `faux` demo adds one local model.

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
| `:Harness actions` | Open chat actions without changing the draft. |
| `:Harness login` or `:Harness setup` | Choose a provider and login method. An optional provider ID skips the first menu. |
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
Chat writes, including forced writes to another path, are blocked. `:wall` and
`:wqa` still save modified files. Use `:q` to close a chat window.
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
The current reply includes `api_revision: 4`. Clients check this revision before
they use chat settings, provider catalogs, or login. The explicit upgrade command
also accepts known older revisions for identity checks and idle shutdown only.
Notifications are only for watches. Each `session.state` notification replaces
the previous snapshot. A reconnect needs a new watch. There is no event replay.
See [the shared fixtures](tests/fixtures/protocol.json) for exact record shapes.

`configuration.get` takes an optional `session_id`. It returns the chat settings
when supplied, or the server defaults otherwise: provider and model, local
readiness, an explanatory message, and the supplied provider and model catalogs.
Each model includes its provider ID. Each provider includes its login methods
and local credential status. The `issue` is `missing_model`, `invalid_model`,
`missing_key`, or null. It never returns a key or calls the model. This local
configuration status is separate from the recovery status in `system.hello`.

`auth.login` accepts a provider, method, private terminal path, and optional
`remote` boolean. The login client sets `remote: true` for an SSH session; its
default is false. The worker reads credentials from that terminal; they are not
RPC parameters. `auth.logout`
accepts a provider ID. Both return status without credential values.

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

Pi stores provider credentials, refresh tokens, a device identifier, and saved
model catalogs in the same database. They are separate from public session
metadata and transcripts. Database backups contain these private values.
Pi handles account login and token refresh.

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
fixes. The application uses the published artifacts without a Pi fork.

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
The provider-import probe loaded 938 files, with 3,230,982 source bytes.
The built-in Pi provider catalog and login methods are available. Provider SDKs
load when required. Unused mandatory features include image WASM, code-mode WASM
(including its `.so` extension files), and telemetry support. They remain in the
audited tree.

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

The desktop checks require [Kitty 0.49.2](https://github.com/kovidgoyal/kitty/releases/tag/v0.49.2),
[Firefox 157.0.1](https://archive.mozilla.org/pub/firefox/releases/157.0.1/),
Xvfb, FFmpeg, and the X11 test extension library (`libXtst`).
CI checks the published Kitty and Firefox archive hashes before extraction.
Set `HARNESS_TEST_XVFB` or `HARNESS_TEST_FIREFOX` to select executables outside
`PATH`. These are test tools, not application dependencies. The desktop check
fails if they are absent. Set `HARNESS_GUI_VIDEO=1` to record the desktop checks.

The complete release gate passed on **2026-10-21** with the final source files. It passed
formatting, Clippy with warnings denied, 56 Rust tests, the release build, five
adapter syntax checks, and 136 Node tests. The Node tests include 72 adapter tests,
35 OAuth tests, 15 OpenAI generation tests, three actual server script tests,
ten actual server recovery tests, and one process exit test. Independent
Node test files run concurrently with separate temporary directories and sockets.

Neovim passed four headless suites, **73 actual terminal cases with the Rust
server and Pi**, six desktop login cases, and 43 terminal cases with controlled
protocol fixtures. The independent terminal groups run concurrently. The actual
tests cover each normal exit command, exact answers, write
failures, hidden modified buffers, multiple sessions, another client, completion
and new work during the prompt, connection failure, and Escape during a pending
stop. They also cover streamed text, tool output, editor response, unsaved context,
startup, retained drafts, duplicate retries, and forced-exit recovery.
These tests use the faux provider or synthetic replies to the actual OpenAI SDK.

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
Additional cases check new files and chats from the input, mouse clicks between
file and chat columns, input width, and `:q` cleanup. The model list checks cover
the complete catalog, page keys, search, mouse scrolling, selection, cancellation,
resize, and retained drafts. A late catalog response cannot take focus from a file.
Native NERDTree checks compare Enter, `s`, and `i` with ordinary Neovim windows.
They cover 40-column and 70-column trees, file focus, window sizes, retained
drafts, and active work. To include these six checks with an existing NERDTree
installation, run:

```sh
HARNESS_TEST_NERDTREE="$HOME/.local/share/nvim/plugged/nerdtree" sh scripts/check.sh
```

NERDTree is used by this additional test. It is not an application dependency.
Chat write checks cover `:wall`, `:write! PATH`, `:wq`, and `:wqa`.

Headless tests delay startup and receipts. They verify that the first action
keeps its text and target, later text stays in the draft, empty Enter does not
block commands, and queued model changes cannot be overtaken by a task. They also
check native command completion, private key entry callbacks, and reconnection.
They check a queued settings command after switching during creation, and clear
upgrade errors when autostart is disabled.
Rust setup tests use actual terminal devices and Pi. They check hidden input,
restored terminal flags, private storage, retained settings, saved accounts
after restart, write failures, and login while work remains active.
Adapter tests exercise all pinned login methods with synthetic credentials and
local responses. They cover browser callbacks, device codes, denied login,
cancellation, token refresh, multiple accounts, and exclusion of secrets from
public records. Actual Neovim login tests type `\login`, select the provider and
method, then type into the terminal immediately. They check cancellation, retry,
browser callback completion without Enter, retained drafts, and unchanged chats.
The desktop tests use actual Kitty, Neovim, Rust, and Pi. A separate terminal
pastes from the system clipboard and checks the complete URL bytes. The tests
also copy the device code with default Neovim settings, without changing
`g:clipboard` or showing a false clipboard error. They check keyboard and mouse
controls, native text selection, narrow windows, a terminal that denies clipboard
writes, and browser completion while an unsaved file has focus.
The clipboard case checks the complete URL passed to the desktop handler.
Its local callback uses only the URL obtained from the clipboard.
The Firefox case opens automatically and uses an actual desktop mouse click on
**Open browser**, without copying the link. It submits
the local test account form through native browser input. Firefox follows an
HTTP redirect to the actual Pi listener at `127.0.0.1:1455`. The successful
attempt waits at least 15 seconds in Firefox before approval. Empty and
space-only Enter keep the listener open. A successful callback from a cancelled
attempt cannot complete a later login; only the current attempt exchanges a code. The exact unsent draft
remains available for typing. Each Firefox attempt uses a temporary profile
and a local proxy that rejects external requests. The user's browser profile
is unchanged. These tests use synthetic account replies; they do not prove that
a real subscription is valid.

The login regression checks use actual X11 mouse events through the terminal.
They click the short browser control in input mode, after Escape, and after a
narrow resize. They also test a terminal with hyperlink support disabled.
The earlier tests injected mouse sequences directly into Neovim and missed the
terminal's own URL detector. A [separate reproduction](tests/evidence/native-link-before.json)
produced the exact reported truncated address ending in the window border `│`.
The normal login display now contains no long address for that detector to truncate.
Escape keeps the callback listener open; Ctrl-C and the Cancel button close it.
The browser case starts with a synthetic environment API key. After the Firefox
callback, the provider status changes from `api_key` to `oauth`. The next
`gpt-5.6-luna` request uses the saved account token through the actual OpenAI SDK.
No real credential is used by this test.

The manual SSH login check sets the client's SSH environment while the server
has no SSH environment. It uses actual Kitty, Neovim, Rust, Pi, and Firefox.
It copies the complete sign-in link, completes the controlled browser form,
and pastes the complete return address into Neovim. A test proxy refuses the
local callback to reproduce the browser error. The test checks that the remote
browser command is not called. This check tests SSH detection and manual login;
it does not start an SSH server or test network forwarding.

An additional [Alacritty and tmux check](tests/evidence/native-login.json) uses
the actual Rust server, Pi, and Neovim with controlled device-login responses.
Automatic opening and a normal desktop click both pass the complete 1,640-byte
address to the browser launcher. Ctrl-Shift-click cannot open a truncated address.
The [screen image](tests/evidence/native-login.png) shows the short control.
Run this optional check with Alacritty and tmux installed:

```sh
python3 tests/nvim/native_login.py
```

The pinned Pi login has a separate known limit: an error callback from an older
browser attempt can end a newer attempt. Close old sign-in tabs before starting
again. The browser test rejects a cancelled attempt's successful callback; it
does not establish correct handling of every old error callback. Harness uses
Pi's login code without a modified fork.

A separate callback probe reproduced the reported connection refusal when
empty input closed the previous login. This is a reproduced cause, not a record
of the user's keystrokes. The fixed adapter keeps waiting on empty input and
still accepts a pasted callback or Ctrl-C to cancel. The
[browser report](tests/evidence/browser-login.json) includes the before and
after results.

The chat action tests keep the task while selecting settings. They check exact
typing after menu and terminal cancellation, delayed settings without focus
changes, and forced terminal closure without a Pi worker restart. The open agent
tree discovers a tool-created child when the parent finishes. Refresh keeps the
highlighted agent, and normal tree entry refreshes agents created by another client.

The OpenAI tests exercise the actual SDK and Pi through controlled HTTP responses
and streamed events. They check API keys, ChatGPT account tokens, Unicode,
Bash execution, the next request with its tool result, retries, cancellation,
and stored outcomes after restart. Failure cases include login, access, models,
quota, billing, request format, network loss, and incomplete streams.
The terminal recovery case sends with Enter, connects a ChatGPT account, and
sends with Ctrl-S. It checks every character of the next draft after each send.
Recorded requests prove that the saved account replaces the environment key.
All these checks reject unexpected network requests and use synthetic credentials.

The separate real-provider screen check reproduced the reported billing or credit
failure with the available key. It verified the visible error, complete next
draft, and native file/chat switching. It did not obtain a successful real reply.
This account restriction remains outside the passing deterministic release gate.

Regression tests cover the `admission` session name, unchanged caller output
flags, default configuration state identity, late receipts after session changes,
and retained history across new snapshots. New backend tests cover atomic chat
settings through process kills, metadata watch updates, inherited settings,
directory-scoped cursors, response capacity, and nested child recovery. A child
continues when its parent is stopped. These regression tests make no paid model request.

An earlier [prior-server test](tests/evidence/legacy-upgrade.json) reproduces
`Unknown parameter field` when Enter uses the previous chat client with an old
server.
The fixed client detects the mismatch before admission. The actual terminal test
then checks refusal during active work, explicit idle upgrade, retained history
and draft, and one successful Enter submission with its final answer. Unknown
newer interfaces are rejected without shutdown. Rust tests also check state
identity and storage ownership release during upgrade.

The [installed-runtime check](tests/evidence/live-runtime.json) verifies the local
release binary, worker, and editor files. The idle server was restarted with its
original environment. Its state directory, saved chats, metadata, and recent
entries were preserved.
The server and Pi worker report ready. This check creates no chat and makes no
model request. Reopen Neovim to load the updated editor files.

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
All 70 saved reference hashes still match the catalog.

See the [release report](tests/evidence/release.json),
[complete check output](tests/evidence/release.log),
[actual terminal results](tests/evidence/nvim-real.json),
[desktop login results](tests/evidence/nvim-desktop.json),
[manual SSH login results](tests/evidence/ssh-manual-login.json),
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
nvim --headless -u NONE -l tests/nvim/select.lua
nvim --headless -u NONE -l tests/nvim/setup.lua
sh scripts/check-dependencies.sh
```

The terminal test commands use Python 3's standard library, without added
packages:

```sh
python3 tests/nvim/interactive.py
python3 tests/nvim/real.py --group exit
python3 tests/nvim/real.py --group integration
python3 tests/nvim/login_gui.py
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
