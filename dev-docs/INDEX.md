# Development reference index

This library contains source documents for the first application specification.
It covers a Neovim plugin, Pi AI, Pi Durable, and agent user interfaces.
The sources were retrieved on 2026-10-16.

There are 62 reference documents and 8 license or notice files. Each source has
a fixed revision, a source URL, and a SHA-256 hash. The hash identifies the saved
file bytes. Downloaded source text is unchanged.

## Start here

| Order | Reference | Purpose |
| --- | --- | --- |
| 1 | [Neovim plugin guide](neovim/lua-plugin.txt) and [Lua guide](neovim/lua-guide.txt) | Understand plugin structure, configuration, commands, and editor events. |
| 2 | [Pi AI](pi/ai/overview.md) | Find provider interfaces, local model endpoints, streaming, and tool calls. |
| 3 | [Pi Durable](pi/durable/overview.md) | Understand conversations, stored state, requests, tools, and recovery. |
| 4 | [Neovim API](neovim/api.txt) and [Lua API](neovim/lua.txt) | Find buffer, window, process, scheduling, and input interfaces. |
| 5 | [Pi agent UI components](interfaces/pi-tui/components.md) | Study agent input, tool output, focus, and display updates. |
| 6 | [Interface reference index](interfaces/INDEX.md) | Find examples of client communication, session updates, and editor context. |

## Collections

Each collection index lists all its documents and their main uses.

| Collection | Documents | Contents |
| --- | ---: | --- |
| [Pi runtime](pi/INDEX.md) | 12 | Pi AI, Pi Durable, and optional Coding Agent interface references. |
| [Neovim](neovim/INDEX.md) | 22 | Official plugin guides, API references, process control, editor UI, and help tags. |
| [Agent interfaces](interfaces/INDEX.md) | 20 | Pi terminal UI and Agent Client Protocol references. |
| [Neovim UI components](neovim-ui/INDEX.md) | 8 | Optional NUI library references for panels, layouts, prompts, and text. |

Document counts exclude licenses and local indexes. A TUI is a text user
interface. ACP means Agent Client Protocol. NUI is the name of the referenced
Neovim UI library.

## Find a topic

These entries locate evidence for later design work. They do not set application
requirements or select an implementation.

| Topic | References |
| --- | --- |
| Hosted providers and model selection | Pi AI [providers and models](pi/ai/overview.md#providers-and-models). |
| Local model servers | Pi AI [custom providers](pi/ai/overview.md#custom-providers) and [compatibility settings](pi/ai/overview.md#openai-compatibility-settings). |
| Credentials and provider login | Pi AI [authentication](pi/ai/overview.md#auth) and [OAuth providers](pi/ai/overview.md#oauth-providers). |
| Model streaming and tools | Pi AI [tools](pi/ai/overview.md#tools) and [events](pi/ai/overview.md#complete-event-reference). |
| Stored sessions and repeated requests | Pi Durable [persist and resume](pi/durable/overview.md#persist-and-resume). |
| Current state and reconnect updates | Pi Durable [watching a conversation](pi/durable/overview.md#watching-a-conversation) and [agent events](pi/durable/overview.md#agent-events-experimental). |
| Requests while an agent is busy | Pi Durable [busy conversations](pi/durable/overview.md#busy-conversations). |
| Stop a run | Pi Durable [abort and subagents](pi/durable/overview.md#abort-and-subagents); ACP [prompt turns](interfaces/acp/v1/prompt-turn.mdx) and [request cancellation](interfaces/acp/v1/cancellation.mdx). |
| Tool actions after a restart | Pi Durable [tools](pi/durable/overview.md#tools) and [tasks a restart abandons](pi/durable/overview.md#tasks-a-restart-abandons). |
| Runtime storage and execution rules | Pi Durable [storage](pi/durable/overview.md#storage), [environment](pi/durable/overview.md#environment), and [upstream design reference](pi/durable/design-reference.md). |
| Start a process or connect to a server | Neovim [job control](neovim/job_control.txt), [channels](neovim/channel.txt), and [function reference](neovim/vimfn.txt). Find `jobstart()`, `sockconnect()`, and `chansend()` in the help-tag index. |
| Async callbacks and editor changes | Neovim [Lua API](neovim/lua.txt) and [Libuv bindings](neovim/luvref.txt). Find `vim.schedule()`, `vim.system()`, and `uv.close()`. |
| Client close prompts and editor exit | Neovim [autocommands](neovim/autocmd.txt) and [input APIs](neovim/lua.txt). Find `QuitPre`, `ExitPre`, `VimLeavePre`, and `vim.ui.input()`. |
| Response panels and highlighted output | Neovim [buffers, windows, and extmarks](neovim/api.txt), [window behavior](neovim/windows.txt), and [buffer options](neovim/options.txt). |
| Reusable editor UI components | NUI [split windows](neovim-ui/split.md), [layouts](neovim-ui/layout.md), [input](neovim-ui/input.md), and [lines](neovim-ui/line.md). |
| Agent tool status and permissions | ACP [tool calls](interfaces/acp/v1/tool-calls.mdx); Pi Coding Agent [RPC interaction](pi/coding-agent/rpc-extension-ui.md). |
| Code locations and change review | Neovim [diagnostics](neovim/diagnostic.txt), [quickfix](neovim/quickfix.txt), and [diff mode](neovim/diff.txt). |
| Unsaved editor content | ACP [file access](interfaces/acp/v1/file-system.mdx); Neovim [buffer APIs](neovim/api.txt). |
| Terminal input, display width, and redraw | Pi [TUI library](interfaces/pi-tui/overview.md), [components](interfaces/pi-tui/components.md), [keybindings](interfaces/pi-tui/keybindings.md), and [terminal setup](interfaces/pi-tui/terminal-setup.md). |
| Embedded terminal output | Neovim [terminal buffers](neovim/terminal.txt) and ACP [terminal execution](interfaces/acp/v1/terminals.mdx). |
| Client and agent communication | ACP [architecture](interfaces/acp/architecture.mdx), [initialization](interfaces/acp/v1/initialization.mdx), and [transports](interfaces/acp/v1/transports.mdx). |
| Existing Pi client interfaces | Pi Coding Agent [SDK](pi/coding-agent/sdk.md), [RPC](pi/coding-agent/rpc.md), and [message types](pi/coding-agent/message-types.md). |

## Search and parsed indexes

All JSON file paths are relative to `dev-docs/`. Line numbers start at 1.

| Index | Contents |
| --- | --- |
| [catalog.json](catalog.json) | All 70 source and license records, document IDs, topics, source URLs, revisions, formats, hashes, and license paths. |
| [sections.json](sections.json) | 659 Markdown and MDX headings, with local file paths, line numbers, and source links. |
| [neovim/tags.json](neovim/tags.json) | 3970 native help-tag definitions and 360 help section headings. |
| [links.json](links.json) | 495 parsed Markdown links and images, with upstream URLs and local targets where a copy is available. |

MDX is Markdown with component markup. The parser reads headings, ordinary
Markdown links, and frontmatter fields. Frontmatter is the metadata block at the
start of a document. The parser does not run code or MDX components.

Use these commands from the project directory:

```sh
# Find runtime state, recovery, and request handling.
rg -n -i 'requestId|watch|resume|abort|replay' dev-docs/pi/durable

# Find editor process, socket, and exit interfaces.
rg -n 'jobstart|sockconnect|detach' dev-docs/neovim/vimfn.txt
rg -n 'QuitPre|ExitPre|VimLeavePre' dev-docs/neovim/autocmd.txt

# Find terminal display and input guidance.
rg -n -i 'focus|unicode|width|scroll|render|input' dev-docs/interfaces/pi-tui
```

For exact help locations, find a tag in `neovim/tags.json`. Open its `file` at
its `line`. The same tag works with `:help` in the matching Neovim release when
that help file is installed.

## Source revisions

| Source | Saved revision | Status at retrieval |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/4dd2b149d155d7369de16ea4dc77c84e9f5ffb24) | `4dd2b149d155d7369de16ea4dc77c84e9f5ffb24` | Main branch snapshot. Package manifests report `1.3.0`. Durable is experimental. |
| [Neovim](https://github.com/neovim/neovim/tree/779c36969e31080503be2dfccbcc3f999e289606) | `779c36969e31080503be2dfccbcc3f999e289606` | Stable release `v0.12.6`, published 2026-10-09. |
| [ACP](https://github.com/agentclientprotocol/agent-client-protocol/tree/00c5a02d7ab96b9d6aa214002d408ce9d972b4e4) | `00c5a02d7ab96b9d6aa214002d408ce9d972b4e4` | v1 protocol references. One v2 draft announcement records its status. |
| [NUI](https://github.com/MunifTanjim/nui.nvim/tree/10fc361835c856ba4233ef5ea135b919bf3dce97) | `10fc361835c856ba4233ef5ea135b919bf3dce97` | Main branch snapshot. Optional component reference. |

The collection manifests retain retrieval times and download URLs:
[Pi](pi/manifest.json), [Neovim](neovim/manifest.json),
[agent interfaces](interfaces/manifest.json), and
[Neovim UI](neovim-ui/manifest.json). Supplemental Luv license revisions are
recorded in the Neovim manifest. Each catalog entry identifies its license file.

## Navigation and source limits

- Use the collection indexes to open local documents. Links inside downloaded
  sources keep their upstream targets. In `links.json`, `local_target` identifies
  a saved copy, and `source_url` identifies the upstream target. Other targets can
  require network access. External link availability was not checked.
- Markdown heading anchors use GitHub-style rules. MDX site anchors can differ.
  Use the recorded line number when an anchor does not work. MDX component
  attributes and JavaScript imports are not part of the link index.
- Native Neovim `|tag|` links can refer to help files outside this collection.
  This snapshot does not set the minimum supported Neovim version.
- Pi Coding Agent SDK, RPC, and session documents describe that package. They
  are not Pi Durable API contracts. The saved Durable design document is an
  upstream specification. Read its notes about experimental behavior and tool
  replay before using its guarantees.
- Pi TUI is a terminal renderer. Neovim buffer and window APIs describe the
  native editor interface. ACP and NUI are optional references; their inclusion
  does not select a protocol or a dependency.
- The collection contains selected text documents and license notices. Source
  repositories, images, executable examples, and MDX component code are not
  copied. Upstream examples and instructions are reference material.
