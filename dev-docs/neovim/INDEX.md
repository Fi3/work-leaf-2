# Neovim reference index

This collection contains 22 official help files for Neovim v0.12.6. The files are reference material for Lua plugins and agent interfaces. They do not define this project's specification.

The source revision is `779c36969e31080503be2dfccbcc3f999e289606`. The release was published on 2026-10-09. These files were retrieved on 2026-10-16. All help files come from this stable release.

[Release](https://github.com/neovim/neovim/releases/tag/v0.12.6) · [Source manifest](manifest.json) · [Help tags and headings](tags.json) · [Main document index](../INDEX.md)

## Read in this order

1. Read [Lua plugin development](lua-plugin.txt) for plugin layout, configuration, and user interface guidance.
2. Read [Lua guide](lua-guide.txt) for modules, mappings, commands, and autocommands.
3. Use [Neovim API](api.txt) and [Lua API](lua.txt) for buffers, windows, scheduling, and input.
4. Read [channels](channel.txt) and [job control](job_control.txt). Use [built-in functions](vimfn.txt) for process and socket options.
5. Read [windows](windows.txt), [options](options.txt), and [autocommands](autocmd.txt) for buffer lifetime and editor events.
6. Use [diagnostics](diagnostic.txt), [quickfix](quickfix.txt), and [diff mode](diff.txt) for code locations and review displays.
7. Read [terminal buffers](terminal.txt), [terminal UI](tui.txt), and [external UI events](api-ui-events.txt) when the interface needs those facilities.

## Documents by topic

| Reference | Contents |
| --- | --- |
| [Lua plugin development](lua-plugin.txt) | Plugin layout, deferred loading, configuration, keymaps, user interface, documentation, and version checks. |
| [Lua guide](lua-guide.txt) | Lua modules, options, mappings, commands, and autocommands. |
| [Lua API reference](lua.txt) | Lua runtime, scheduling, JSON, process execution, input, selection, and notification APIs. |
| [Neovim API](api.txt) | Buffer and window operations, floating windows, extmarks, API contracts, and RPC. |
| [Asynchronous channels](channel.txt) | Raw bytes, partial callback data, channels, sockets, RPC, and prompt buffers. |
| [Job control](job_control.txt) | Child processes, standard streams, and exit callbacks. |
| [Autocommands](autocmd.txt) | Editor events, buffer events, quit events, and autocommand groups. |
| [Windows and buffers](windows.txt) | Window layout, buffer lifetime, hidden buffers, and navigation. |
| [Terminal buffers](terminal.txt) | Embedded terminals, input modes, terminal events, and terminal output. |
| [External UI protocol](api-ui-events.txt) | External UI attachment, redraw events, grid updates, command lines, and messages. |
| [Built-in terminal UI](tui.txt) | Terminal capabilities, input, colors, cursor shape, and resize behavior. |
| [Diagnostics](diagnostic.txt) | Diagnostic records, namespaces, signs, virtual text, and quickfix integration. |
| [Quickfix and location lists](quickfix.txt) | Search result lists, error locations, list updates, and navigation. |
| [Mappings and commands](map.txt) | Mappings, user commands, completion, and command arguments. |
| [Remote plugins](remote_plugin.txt) | Remote plugin hosts, registration, manifests, and an example. |
| [Standard plugins](plugins.txt) | Built-in plugins, including diff and undo-tree tools. |
| [Packages](pack.txt) | Runtime search paths, package layout, loading, and package management. |
| [Health checks](health.txt) | Health check development and health report APIs. |
| [Editor options](options.txt) | Option definitions, including scratch buffers, buffer lifetime, wrapping, and status display. |
| [Built-in function reference](vimfn.txt) | Function definitions for jobs, sockets, channels, input, prompts, and quickfix lists. |
| [Diff mode](diff.txt) | Diff windows, updates, navigation, and file comparison. |
| [Libuv Lua bindings](luvref.txt) | Event loop bindings, TCP sockets, pipes, timers, process handles, and cleanup. |

## Entry points for agent interfaces

Each link opens a saved help file. The line number identifies the tag definition in that file. The same tag can be used with `:help` in a matching Neovim release.

| Topic | Help tags |
| --- | --- |
| Plugin structure and configuration | [`lua-plugin-new`](lua-plugin.txt), line 19; [`lua-plugin-init`](lua-plugin.txt), line 120; [`lua-plugin-config`](lua-plugin.txt), line 245 |
| Plugin user interface and compatibility | [`lua-plugin-ui`](lua-plugin.txt), line 262; [`lua-plugin-versioning`](lua-plugin.txt), line 314; [`api-contract`](api.txt), line 223 |
| Keymaps and commands | [`vim.keymap.set()`](lua.txt), line 3662; [`nvim_create_user_command()`](api.txt), line 2912; [`lua-guide-commands`](lua-guide.txt), line 649 |
| Run a process | [`vim.system()`](lua.txt), line 4925; [`jobstart()`](vimfn.txt), line 5465; [`jobstop()`](vimfn.txt), line 5565 |
| Read streamed process data | [`channel-callback`](channel.txt), line 45; [`channel-lines`](channel.txt), line 75; [`channel-buffered`](channel.txt), line 65 |
| Connect to a server | [`sockconnect()`](vimfn.txt), line 10080; [`chansend()`](vimfn.txt), line 895; [`channel-bytes`](channel.txt), line 39 |
| Schedule editor changes | [`vim.schedule()`](lua.txt), line 719; [`vim.schedule_wrap()`](lua.txt), line 1461 |
| Parse server messages | [`vim.json.decode()`](lua.txt), line 3583 |
| Update response buffers | [`nvim_buf_set_lines()`](api.txt), line 2712; [`nvim_buf_set_text()`](api.txt), line 2779 |
| Observe editor changes | [`api-buffer-updates`](api.txt), line 260; [`nvim_buf_attach()`](api.txt), line 2316 |
| Create windows and marks | [`nvim_open_win()`](api.txt), line 3820; [`api-floatwin`](api.txt), line 411; [`nvim_buf_set_extmark()`](api.txt), line 3198 |
| Set buffer lifetime | [`'buftype'`](options.txt), line 1222; [`'bufhidden'`](options.txt), line 1190; [`'swapfile'`](options.txt), line 6525 |
| Prompt and select | [`vim.ui.input()`](lua.txt), line 5119; [`vim.ui.select()`](lua.txt), line 5195; [`prompt-buffer`](channel.txt), line 174 |
| Editor exit events | [`QuitPre`](autocmd.txt), line 995; [`ExitPre`](autocmd.txt), line 639; [`VimLeavePre`](autocmd.txt), line 1340 |
| Configure autocommands | [`nvim_create_autocmd()`](api.txt), line 2105; [`lua-guide-autocommands-group`](lua-guide.txt), line 575 |
| Show review findings | [`vim.diagnostic.set()`](diagnostic.txt), line 993; [`quickfix`](quickfix.txt), line 12; [`setqflist()`](vimfn.txt), line 9213 |
| Compare changes | [`diff-mode`](diff.txt), line 7; [`difftool`](plugins.txt), line 45 |
| Use low-level I/O | [`uv.new_tcp()`](luvref.txt), line 1749; [`uv.new_pipe()`](luvref.txt), line 2007; [`uv.new_timer()`](luvref.txt), line 794; [`uv.close()`](luvref.txt), line 622 |
| Check installation and dependencies | [`health-dev`](health.txt), line 78; [`vim.health.error()`](health.txt), line 125 |
| Package and load a plugin | [`package-create`](pack.txt), line 142; [`runtime-search-path`](pack.txt), line 23 |
| Check terminal input and redraw | [`tui-input`](tui.txt), line 136; [`ui-linegrid`](api-ui-events.txt), line 287; [`ui-messages`](api-ui-events.txt), line 825 |

## Scope and source limits

- The Neovim API can be called from Lua and from external clients. The external UI protocol describes clients that render Neovim itself. It is a separate reference from ordinary buffer and window APIs.
- The remote-plugin guide describes Neovim plugin hosts. It does not specify an application server for an agent.
- Exit event documentation is included for later analysis of the close prompt. This index makes no claim that every exit path can be intercepted or cancelled.
- Native help links use `|tag|` notation. Some links point to help files outside this selected collection. Use the matching installed help or the pinned source repository for those links.
- The Luv reference retains its upstream credits and source-date statement. Read those credits before treating it as a complete reference for newer Libuv features.
- This snapshot does not set the project's minimum supported Neovim version. API entries retain their upstream version information.

## Search and provenance

Use `tags.json` to find a help tag or a section heading. Its file paths are relative to `dev-docs`, and its line numbers start at 1. The file contains 3970 tag definitions and 360 section headings.

For example, search the saved source text with:

```sh
rg -n 'vim.system|jobstart|detach' dev-docs/neovim/{lua,vimfn}.txt
rg -n 'QuitPre|ExitPre|VimLeavePre' dev-docs/neovim/autocmd.txt
rg -n 'nvim_open_win|nvim_buf_set_extmark' dev-docs/neovim/api.txt
```

The manifest records each source URL, immutable revision, retrieval date, format, and SHA-256 hash. The downloaded files preserve the original bytes. The index and parsed tag data are local navigation files.

## Licenses

- [Neovim license](LICENSE.txt): Apache 2.0 and Vim license terms.
- [Vim copyright and license](uganda.txt): original copyright, distribution terms, and notice.
- [Luv license](LICENSE-luv.txt): terms at the source revision cited in the Luv reference.
- [Luv Vim documentation license](LICENSE-luv-vimdocs.txt): supplemental terms for the credited documentation project.
