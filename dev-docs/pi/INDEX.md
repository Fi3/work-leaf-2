# Pi reference index

Read the runtime references first. Use the Coding Agent references only when you
need examples of an existing client interface.

All saved sources use Pi commit
`4dd2b149d155d7369de16ea4dc77c84e9f5ffb24`. The package manifests at this commit
report version `1.3.0`. This is a source snapshot from `main`, not a release tag.
See [source records and file hashes](manifest.json) and the [MIT license](LICENSE.txt).

## Runtime references

| Read | Reference | Content |
|---|---|---|
| 1 | [Pi AI overview](ai/overview.md) | Providers, authentication, local endpoints, model calls, streaming, tools, and cancellation. |
| 2 | [Pi Durable overview](durable/overview.md) | Harness setup, conversations, tools, stored state, recovery, and observation. |
| 3 | [Pi Durable design reference](durable/design-reference.md) | The upstream specification for transactions, tasks, documents, storage, and execution rules. |

The design reference is a saved upstream document. It is not a specification for
this application.

## Find a runtime topic

| Topic | Start here |
|---|---|
| Hosted providers and model discovery | [Providers and models](ai/overview.md#providers-and-models) |
| Local and compatible model servers | [Custom providers](ai/overview.md#custom-providers) and [compatibility settings](ai/overview.md#openai-compatibility-settings) |
| Credentials and provider login | [Authentication](ai/overview.md#auth) and [OAuth providers](ai/overview.md#oauth-providers) |
| Streamed model responses and tool calls | [Tools](ai/overview.md#tools) and [event reference](ai/overview.md#complete-event-reference) |
| Model errors and cancellation | [Error handling](ai/overview.md#error-handling) |
| Stored conversations and repeated requests | [Persist and resume](durable/overview.md#persist-and-resume) |
| Client attachment and reconnect state | [Watching a conversation](durable/overview.md#watching-a-conversation) |
| Agent events | [Agent events](durable/overview.md#agent-events-experimental) |
| Requests while an agent is busy | [Busy conversations](durable/overview.md#busy-conversations) |
| Stop work and manage child agents | [Abort and subagents](durable/overview.md#abort-and-subagents) |
| Tools and restart behaviour | [Tools](durable/overview.md#tools) and [tasks a restart abandons](durable/overview.md#tasks-a-restart-abandons) |
| Work directories and execution environment | [Environment](durable/overview.md#environment) |
| Reduce conversation context | [Compaction](durable/overview.md#compaction) |
| Storage adapters and ownership | [Storage](durable/overview.md#storage) |
| Runnable upstream examples | [Examples](durable/overview.md#examples) |

## Optional Coding Agent references

These documents describe `pi-coding-agent`. Its SDK, RPC protocol, events, and
session files are separate from the Durable API. They do not define an HTTP API
for a custom server.

| Reference | Content |
|---|---|
| [How Pi works](coding-agent/how-pi-works.md) | Existing agent loop, context, sessions, and interface boundaries. |
| [SDK](coding-agent/sdk.md) | Embed the existing Coding Agent in a host process. |
| [RPC protocol](coding-agent/rpc.md) | JSON record framing, subprocess lifecycle, errors, and shutdown. |
| [RPC commands](coding-agent/rpc-commands.md) | Prompt, steer, inspect, configure, and stop work. |
| [RPC user interaction](coding-agent/rpc-extension-ui.md) | Dialog requests, replies, notifications, and interface limits. |
| [JSON events](coding-agent/json.md) | Message updates, tool output, state changes, and completion signals. |
| [Message types](coding-agent/message-types.md) | Content blocks, tool calls, usage, and Coding Agent messages. |
| [Session file format](coding-agent/session-format.md) | Existing Coding Agent JSONL records and conversation branches. |
| [Model configuration](coding-agent/models.md) | Local model servers and compatible endpoints in the existing CLI. |

## Source limits

- Pi Durable marks its API as experimental. Check the saved revision when using
  an API example.
- The design reference includes a note about pi-ai PR #9548. Check that note
  against the implementation before using the affected message contract.
- Recovery of stored tasks does not make all external tool actions safe to repeat.
  Read the tool replay rules before using recovery guarantees.
- These files preserve upstream prose. Code blocks are reference examples. The
  collection adds no application dependencies. Source examples were not executed.
- The collection does not contain the complete repository. Examples, source files,
  images, and other documents may require access to their upstream links.
