# Agent interface reference index

This collection contains 20 upstream reference documents. It covers terminal display,
agent progress, editor context, and client communication. It does not define the
application specification or select a client protocol.

A TUI is a text user interface. ACP means Agent Client Protocol.

## Read first

1. Read [Pi terminal UI components](pi-tui/components.md) for input, focus, output,
   and responsive rendering.
2. Read the [Pi TUI library](pi-tui/overview.md) for reusable terminal components.
3. Read the [ACP architecture](acp/architecture.mdx) and
   [v1 protocol overview](acp/v1/overview.mdx) for the client and agent boundary.
4. Read [session setup](acp/v1/session-setup.mdx),
   [prompt updates](acp/v1/prompt-turn.mdx), and
   [tool calls](acp/v1/tool-calls.mdx) for interaction examples.
5. Read [file access](acp/v1/file-system.mdx) for the difference between saved
   files and unsaved editor content.

## Scope and status

Pi TUI renders terminal output. A Neovim plugin can use editor buffers, windows,
and APIs. The Pi documents describe a terminal renderer, not a Neovim plugin
renderer. Use them as references for input and agent display behaviour.

ACP is an interface reference. Its architecture describes an editor that starts
an agent process and communicates through standard input and output. Read the
[transport limits](acp/v1/transports.mdx) before treating that model as a remote
server interface. This collection does not recommend adopting ACP.

The Pi snapshot uses package version `1.3.0` at commit
`4dd2b149d155d7369de16ea4dc77c84e9f5ffb24`.

The ACP snapshot uses commit `00c5a02d7ab96b9d6aa214002d408ce9d972b4e4`.
Its [version policy](acp/overview.md#versioning) identifies protocol version `1`
as stable. Its [v2 announcement](acp/v2-draft-status.mdx#draft-status) identifies
protocol version `2` as draft. The v2 migration guide uses the phrase
"stable v2 baseline" for a schema surface, while it still labels the whole v2
protocol as draft. See the upstream
[migration scope](https://github.com/agentclientprotocol/agent-client-protocol/blob/00c5a02d7ab96b9d6aa214002d408ce9d972b4e4/docs/protocol/v2/migration.mdx#scope-stable-v2-and-draft-surfaces).
Schema version numbers alone do not establish release status.

The v1 protocol documents below come from `docs/protocol/v1/`. Files from
`docs/protocol/v1/draft/` were not included. The separate v2 announcement is a
status reference, not a stable protocol specification.

## Pi terminal references

| Document | Use |
| --- | --- |
| [TUI library](pi-tui/overview.md) | Rendering modes, components, overlays, input, display width, images, and caching. |
| [Agent TUI components](pi-tui/components.md) | Integration points, focus, mouse input, themes, and responsive display. |
| [Keybindings](pi-tui/keybindings.md) | Action names, configurable keys, session navigation, and message queues. |
| [Terminal setup](pi-tui/terminal-setup.md) | Keyboard compatibility, input methods, terminal capabilities, and troubleshooting. |

## ACP interface references

All protocol documents in this table describe v1, except the final draft status
announcement.

| Document | Use |
| --- | --- |
| [Repository overview](acp/overview.md) | Protocol versions, schema releases, SDKs, and contribution terms. |
| [Architecture](acp/architecture.mdx) | Editor and agent responsibilities, process startup, and bidirectional requests. |
| [Protocol overview](acp/v1/overview.mdx) | Methods, notifications, errors, path rules, and extension points. |
| [Initialization](acp/v1/initialization.mdx) | Version selection and optional client and agent capabilities. |
| [Session setup](acp/v1/session-setup.mdx) | Create, load, resume, and close sessions; select working directories. |
| [Prompt turn and updates](acp/v1/prompt-turn.mdx) | Stream messages, show progress, report notices, and stop a prompt turn. |
| [Tool calls and permissions](acp/v1/tool-calls.mdx) | Tool status, permission choices, diffs, and source locations. |
| [Request cancellation](acp/v1/cancellation.mdx) | Cancel individual requests and propagate cancellation. |
| [Terminal execution](acp/v1/terminals.mdx) | Create commands, collect output, wait, kill, and release terminal resources. |
| [File access](acp/v1/file-system.mdx) | Read and write through the editor, including unsaved content. |
| [Content blocks](acp/v1/content.mdx) | Text, resources, images, audio, and context attachments. |
| [Agent plans](acp/v1/agent-plan.mdx) | Display plan entries and replace plan state. |
| [Transports](acp/v1/transports.mdx) | Standard input/output, proposed HTTP transport, and custom transports. |
| [Session list](acp/v1/session-list.mdx) | Find previous sessions and handle pagination. |
| [Session configuration](acp/v1/session-config-options.mdx) | Display and change model, mode, and other agent options. |
| [v2 draft status](acp/v2-draft-status.mdx) | Draft status and proposed changes to prompts, updates, diffs, and permissions. |

## Source files and navigation

The document bytes are unchanged. Upstream `README.md` files are stored as
`overview.md`. License files are stored as `LICENSE.txt`.

MDX is Markdown with component markup. MDX files remain readable as source text.
This collection does not run their component imports. Images, component source,
and example programs were not copied.

Links inside source documents keep their original targets. Relative links are
relative to the upstream repository or documentation site. Some targets are not
included in this collection. Use the document's immutable `source_url` in
[manifest.json](manifest.json) to open the original source. Use this index to
open local copies.

The manifest records source paths, revisions, retrieval time, topics, licenses,
and SHA-256 hashes. A SHA-256 hash identifies the saved file bytes.

## Licenses

- Pi documents: [MIT license](pi-tui/LICENSE.txt).
- ACP documents: [Apache License 2.0](acp/LICENSE.txt).

The source licenses and notices remain unchanged.
