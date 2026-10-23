#!/usr/bin/env bun
/**
 * Generate a long load-test script: a finite task with multiple turns that ends naturally.
 * Each of the N turns has a medium text body and one tool call. Use `--exhausted stop`:
 * the main process finishes and exits when it receives the final plain-text task-end message.
 * This measures the full duration and resource use of the complete script.
 *
 * Each turn sends the history in messages, so context grows with each turn. The request for
 * turn N contains the text from the preceding N-1 turns. This affects duration and memory use.
 *
 *   bun run scripts/perf/gen-long-run.ts                            # 50 turns, about 4KB each
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --body-kb 8
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
 *
 * Select the tool name with `--tool` and the argument format with `--args`.
 * See USAGE for generation commands for each harness.
 *
 * The script always has two final entries, in addition to the text turns:
 *   1. A plain-text task-end message, identical to the mock's stop response. The main process
 *      finishes when it receives this text. Both use STOP_MESSAGE from src/script.ts.
 *   2. A blank response for peri's prediction of the next input.
 * The second entry removes peri's 5.0s shutdown wait. Its prediction request occurs after
 * the main process ends. If that request receives nonempty text, the prediction path falls
 * back to a Placeholder action and continues to write the session title. It then blocks
 * against host shutdown until cooperative_grace expires. Measurements show a fixed extra
 * 5.0s; see docs/perf-compare.md. With text that is empty after trim, it returns an empty
 * action before it acquires the lock. Keep this order: the main process must receive the
 * task-end text first.
 * Other harnesses usually consume entries for auxiliary requests during the run, such as
 * dsh's session titles and pi's compaction summaries. Some also send a request after the end:
 * pi's final summary request with `messages=2` received the blank entry in measurements,
 * with no adverse effect.
 * Output defaults to data/scenarios/long-run.json (data/ is excluded by gitignore).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { STOP_MESSAGE } from "../../src/script";
import { REPO_ROOT } from "./config";
import { largeMarkdown } from "./markdown";

const USAGE = `Generate a long script with multiple tool-call turns that ends naturally

Usage:
  bun run scripts/perf/gen-long-run.ts [options]

Options:
  --turns <n>           Turn count: each turn has text and one tool call (default 50; entries = turns + 2 final entries)
  --body-kb <n>         Target text size per turn in KB (default 4; 0 = only a one-line heading)
  --chunk-size <n>      Characters per streamed chunk (default 64)
  --chunk-delay-ms <n>  Delay between chunks in milliseconds (default 0)
  --delay-ms <n>        Delay before the first packet in milliseconds (default 0)
  --tool <name>         Tool name (default Bash; --args exec / commandline have separate defaults below)
  --args <shape>        Tool argument format (default command):
                          command              {command}                peri / opencode / Claude Code / MiniMax Code / opencode2 / hermes
                          command+description  {command, description}   dsh / Grok Build
                          exec                 raw JavaScript source    codex (custom tool)
                          commandline          {CommandLine, Cwd, …}    agy (Antigravity CLI)
                          commands             {commands: [command]}    cline (Cline CLI)
  --cwd <path>          Cwd for the commandline format (default playground/antigravity, relative to the repository root)
  --out <path>          Output path (default data/scenarios/long-run.json, relative to the repository root)
  -h, --help            Show this help

Generation commands for each harness (100 main-loop turns; use --body-kb for text size, default 4KB):
  bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json
    # peri / opencode / Claude Code: all three share this script, with Bash and {command}.
  bun run scripts/perf/gen-long-run.ts --turns 100 --args exec \\
    --out data/scenarios/long-run-codex.json
  bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash \\
    --out data/scenarios/long-run-pi.json
    # pi needs 133 turns (135 script entries = 133 + 2 final entries). Automatic compaction starts
    # at about 140 messages. During compaction, each turn adds a messages=2 summary request that
    # consumes an entry. Measured: 135 requests = 1 initial + 100 tool turns + 34 summaries.
    # With 131 turns, only 99 tool turns complete; with 128, only 98. Increase the count; do not reduce it.
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \\
    --out data/scenarios/long-run-copilot.json
    # GitHub Copilot CLI: OpenAI Chat Completions, with bash + {command} as its shell tool.
    # The standard 100×4KB script adds context-summary requests but still executes returned bash calls.
    # Measured: 102 requests and 100 successful tool turns. It does not need pi's extra tool entries.
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \\
    --out data/scenarios/long-run-dsh.json
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \\
    --out data/scenarios/long-run-minimax-code.json
    # MiniMax Code CLI (mcode) also uses bash + {command}. It consumes entries with no extra requests:
    # a 100-turn script produced 101 requests (100 turns + the final response), with no title or compaction requests.
  bun run scripts/perf/gen-long-run.ts --turns 104 --args commandline \\
    --out data/scenarios/long-run-antigravity.json
    # Antigravity CLI (agy) uses run_command with five required arguments (--args commandline).
    # It needs 104 entries for 100 tool turns for two measured reasons:
    #   1. The first entry is a session-title request (gemini-3.1-flash-lite-preview, same endpoint).
    #      It occurs first, whereas peri's prediction occurs last.
    #   2. Context compaction adds a continuation-summary request about every 32 requests
    #      (last=user:"Your main task now is to generate a continuation summary of …").
    #      These also consume entries. Measured: 104 turns give 3 compactions and exactly 100 tool turns;
    #      103 turns give only 99 tool turns.
  bun run scripts/perf/gen-long-run.ts --turns 101 --tool shell \\
    --out data/scenarios/long-run-opencode2.json
    # opencode v2 (npm package @opencode/cli, binary opencode2) renamed its shell tool to shell
    # (v1's bash is gone). Its arguments are {command}. It first sends a session-title request
    # (messages=2, no tools, system="You are a title generator"), before the main process.
    # This consumes an entry, so add 1: measured 101 turns give 102 requests = 1 title + 100 tool turns + 1 final response.
  bun run scripts/perf/gen-long-run.ts --turns 102 --tool terminal \\
    --out data/scenarios/long-run-hermes.json
    # Hermes Agent (Nous Research) uses terminal with {command}, the same argument format as the others.
    # Include its two extra requests in the count, so add 2:
    #   1. Session-title generation (stream=false, messages=2, no tools, system="You name chat
    #      sessions.") runs almost simultaneously with the main request. Either can be first:
    #      in 5 measurements, the title was first 3 times and the main request first 2 times.
    #      Together they consume one additional initial entry.
    #   2. One context compaction during the run: at about 170 messages, it adds a messages=1 request,
    #      last=user:"You are a summarization agent creating a context checkpoint.".
    #      It then reduces history to 21 messages and sends a main request that repeats the task.
    #      Both the summary and the repeated-task request consume entries.
    # Measured: 102 turns give 103 requests = 1 main + 1 title + 1 summary + 1 repeated task +
    # 99 continuations with tool results = 100 tool turns. One fewer entry gives only 99 turns.
    # Continuations with tool results are one fewer than tool turns because the tool result before
    # compaction is included in the summary instead of sent separately. Count executed script entries, not last=tool.
    # After the main process ends, it can also request a skill-library review: "Review the conversation above and update
    # the skill library." This occurred in 1 of 4 runs of the same script. It consumes the final blank entry,
    # like peri's prediction, so that entry also helps hermes. It does not change the tool-turn count.
  bun run scripts/perf/gen-long-run.ts --turns 101 --args commands \\
    --out data/scenarios/long-run-cline.json
    # Cline (npm cline@3.0.62, apps/cli in the official cline/cline repository) uses run_commands.
    # Its arguments contain a string array, {commands: [...]}, the only array format among the ten harnesses.
    # It therefore needs --args commands. It has no title generation, but context compaction consumes
    # one script entry (default --compaction agentic). At the context limit, it replaces that turn with
    # a continuation-summary request (messages=2,
    # last=user:"Summarize this session for continuation. Be concise and fact…"). The response becomes
    # the summary; that turn's tool call is not executed. It then continues with the compacted context.
    # In the standard 4KB-per-turn script this occurred about every 90 turns. Measured: 101 turns
    # (103 entries) give 102 requests = 1 initial + 99 continuations with tool results + 1 compaction +
    # 1 continuation after compaction = 100 tool turns. A 200-turn run compacted twice, so add 1 per
    # 100 turns, rounding up.
  bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run-kimi.json
    # Kimi Code CLI (kimi, official single-file binary, measured version 2.0.0) uses Bash + {command},
    # like peri and Claude Code. Measured: 100 turns give 101 requests (1 initial + 100 tool turns + 1 final response).
    # There is no title generation or context compaction: messages=204 in the final request stayed below
    # max_context_size 262144. There are no peri-style prediction requests. Like mcode, it needs no extra turns.
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool run_shell_command \
    --out data/scenarios/long-run-qwen-code.json
    # Qwen Code (qwen, npm package @qwen-code/qwen-code) uses run_shell_command with {command}.
    # Measured: 100 turns give 101 requests (1 initial + 100 tool turns + 1 final response), with no title,
    # context-compaction, or prediction requests.
  bun run scripts/perf/gen-long-run.ts --turns 101 --tool run_terminal_command --args command+description \
    --out data/scenarios/long-run-grok.json
    # Grok Build (grok, official install.sh) exposes run_terminal_command to the model.
    # Both {command, description} arguments are required, as with dsh. It first sends a session_title request,
    # so add 1: 101 turns cover 100 tool turns. With context_window set to 1,000,000, 100×4KB causes no compaction.
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \
    --out data/scenarios/long-run-ccode.json
    # ccode (ccode-cli built in this reference repository, pure C, single binary) uses bash + {command}
    # with optional timeout_ms, as do pi and mcode. Its --max-turns limits turns for one prompt
    # (ccode defaults to 50; 0 means unlimited). The playground always supplies this flag: use the
    # caller's --turns value, or 0 if absent, to run the whole script. It stops immediately at the limit.
    # Measured: --max-turns 100 with a 100-turn script gives exactly 100 requests, one per tool turn,
    # with no final request. Without a limit, it consumes the task-end response. A 50-turn script
    # with --max-turns 100 gives 51 requests, following the same rule.
    # There are no title or compaction requests (the default context-tokens 1000000 limit is not reached),
    # so no extra turns are needed.

  Each harness consumes entries for auxiliary requests: titles in opencode / dsh / agy / opencode2 /
  hermes / grok, and compaction summaries in pi / agy / hermes / cline. The script turn count is
  therefore usually at least the actual main-loop turn count. If the script runs out, inspect
  mock.log to see which requests consume entries. Required script turns for 100 tool turns:
  peri 100 · opencode 100 · Claude Code 100 · codex 100 · dsh 100 · mcode 100 · kimi 100 ·
  qwen-code 100 · ccode 100 · pi 133 (one extra entry per turn after compaction starts at about
  140 messages) · agy 104 · opencode2 101 (title consumes the first entry) · hermes 102
  (title and main request compete for the first entry, plus requests before and after compaction) ·
  cline 101 (compaction consumes one entry) · grok 101 (title consumes the first entry; the
  dashboard text after completion consumes the final blank entry).
  The script always adds two final entries beyond the turn count: the main task-end text and
  a blank response for peri's prediction. The blank removes peri's fixed 5.0s shutdown wait;
  see docs/perf-compare.md for the mechanism.
  The agy / opencode2 / grok title requests precede the main process and consume the first entry.
  These harnesses use only the first final entry. Hermes sends the title and main requests
  almost simultaneously, in either order, and likewise uses the first final entry.
  Cline also has no prediction request and uses only the first final entry.
  Peri's prediction, hermes's skill-library review, and grok's dashboard text occur after the
  main process and consume the second, blank final entry. That extra entry serves these requests
  and causes no harm when the harnesses share this generator.

Run commands (each playground's perf-demo.ts defaults to its own script; timeout is a fallback,
and the harness should exit on its own. Relative --script paths use the process cwd, so adjust
paths shown relative to the repository root):
  cd playground/peri  && bun perf-demo.ts --script ../../data/scenarios/long-run.json \\
    --exhausted stop --timeout-ms 1800000 --turns 100
  cd playground/pi    && bun perf-demo.ts --script ../../data/scenarios/long-run-pi.json \\
    --exhausted stop --timeout-ms 1800000
  cd playground/codex && bun perf-demo.ts --script ../../data/scenarios/long-run-codex.json \\
    --exhausted stop --timeout-ms 1800000
  cd playground/minimax-code && bun perf-demo.ts --exhausted stop --timeout-ms 1800000
    # Default script: data/scenarios/long-run-minimax-code.json; sandbox MINIMAX_DATA_DIR=playground/minimax-code/.minimax.
  cd playground/opencode2 && bun perf-demo.ts --exhausted stop --timeout-ms 1800000
    # Default script: data/scenarios/long-run-opencode2.json; sandbox XDG_* points to .data/.state/.cache/.config.
    # Always pass --standalone. Otherwise serve --service stays running, causing unequal cold/warm conditions across three readings.
  cd playground/cline && bun perf-demo.ts --exhausted stop --timeout-ms 1800000
    # Default script: data/scenarios/long-run-cline.json; sandbox --config/--data-dir/--hooks-dir points to .cline/.
    # Write the provider with this run's port to <sandbox>/data/settings/providers.json; it does not expand environment variables.
`;

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        turns: { type: "string" },
        "body-kb": { type: "string" },
        "chunk-size": { type: "string" },
        "chunk-delay-ms": { type: "string" },
        "delay-ms": { type: "string" },
        tool: { type: "string" },
        args: { type: "string" },
        cwd: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
});

if (values.help === true) {
    console.log(USAGE);
    process.exit(0);
}

function positiveInt(raw: string | undefined, label: string, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a nonnegative integer; received ${JSON.stringify(raw)}`);
    }
    return parsed;
}

const turns = positiveInt(values.turns, "--turns", 50);
if (turns < 1) throw new Error("--turns must be at least 1: a script needs at least one turn to run");
const bodyKb = positiveInt(values["body-kb"], "--body-kb", 4);
const chunkSize = positiveInt(values["chunk-size"], "--chunk-size", 64);
const chunkDelayMs = positiveInt(values["chunk-delay-ms"], "--chunk-delay-ms", 0);
const delayMs = positiveInt(values["delay-ms"], "--delay-ms", 0);

/**
 * Tool formats for each harness, checked individually during repeat measurements.
 * These were recorded in the scenario notes before those files were removed:
 *   peri 3.17 / opencode 1.17 / Claude Code 2.1   Bash                   {command}
 *   opencode2 2.0.10                              shell                   {command}
 *   codex 0.155                                   exec                    raw JS source (custom tool)
 *   pi 0.85.1                                     bash                    {command}
 *   dsh 0.1.5-rc.2                                bash                    {command, description}
 *   agy 1.2.7                                     run_command             {CommandLine, Cwd, …}
 *   hermes 0.21.3                                 terminal                {command}
 *   cline 3.0.62                                  run_commands            {commands: [command]}
 *   kimi 2.0.0                                    Bash                   {command}
 *   grok 1.0.41                                   run_terminal_command   {command, description}
 *   ccode c8fb352 (make ccode-cli)                 bash                    {command}
 *   GitHub Copilot CLI 1.0.88                     bash                    {command}
 * The opencode v2 shell tool is named `shell`, not v1's `bash`. Its format is still {command}.
 * Treat v1 (opencode) and v2 (opencode2) as separate harnesses, each with its own script.
 * dsh requires description. The tool rejects requests without it:
 * "invalid arguments: missing required property \"description\"".
 * The generator must therefore supply description as well as command.
 * agy's run_command also rejects missing Cwd, WaitMsBeforeAsync, toolSummary, or toolAction:
 * "missing properties 'Cwd', 'WaitMsBeforeAsync', 'toolSummary', 'toolAction'".
 * Supply all five properties; see toolCall() for their format.
 */
type ArgShape =
    | "command"
    | "command+description"
    | "exec"
    | "commandline"
    | "commands";

const ARG_SHAPES: readonly ArgShape[] = [
    "command",
    "command+description",
    "exec",
    "commandline",
    "commands",
];

function argShapeOf(raw: string | undefined, tool: string): ArgShape {
    // Keep the old codex usage: `--tool exec` selects the exec format when --args is absent.
    if (raw === undefined || raw === "") return tool === "exec" ? "exec" : "command";
    if ((ARG_SHAPES as readonly string[]).includes(raw)) return raw as ArgShape;
    throw new Error(`--args must be ${ARG_SHAPES.join(" | ")}; received ${JSON.stringify(raw)}`);
}

const argShape = argShapeOf(values.args, values.tool ?? "Bash");
// The argument format fixes the tool name: exec for codex, run_command for agy, run_commands for cline.
const toolName =
    argShape === "exec"
        ? "exec"
        : argShape === "commandline"
          ? (values.tool ?? "run_command")
          : argShape === "commands"
            ? (values.tool ?? "run_commands")
            : (values.tool ?? "Bash");
const outPath = resolve(REPO_ROOT, values.out ?? "data/scenarios/long-run.json");

/**
 * The working directory for the commandline format (agy's run_command) must be inside
 * the workspace. Default to agy's sandbox directory, playground/antigravity; --cwd can
 * override it. Resolve this path at generation time. Scripts are generated locally and
 * data/ is not committed, so each user or machine can generate its own copy.
 */
const toolCwd = resolve(REPO_ROOT, values.cwd ?? "playground/antigravity");

/**
 * The harness displays description from the command+description format; it is not part
 * of the measurement. A fixed string lets two scripts be compared exactly except for
 * the turn numbers, without unrelated changes from generated descriptions.
 */
const TOOL_DESCRIPTION = "Long-script load test: inspect the current directory without changes (llm-mock perf)";

/**
 * Cycle through four small read-only commands. Include the turn number where applicable
 * so turns can be counted in harness.log and mock.log. The commands do not write files
 * or leave changes in the sandbox.
 */
function commandFor(round: number): string {
    const probe = `long-run-tick-${round}`;
    switch ((round - 1) % 4) {
        case 1:
            return `echo ${probe}`;
        case 2:
            return "pwd";
        case 3:
            return "ls -la";
        default:
            return "ls";
    }
}

/**
 * Generate one tool call in the format selected by `--args`:
 * - `command`: arguments is a `{command}` JSON object (peri / opencode / Claude Code / pi).
 * - `command+description`: also includes the required description property (dsh).
 * - `exec`: uses codex's custom tool. Arguments is raw JavaScript source, not JSON or
 *   a quoted string. See the exec declaration in the header comment of src/responses.ts.
 * - `commandline`: uses agy's run_command with all five required properties; see ArgShape.
 *   Its property names use an initial capital, as in `CommandLine`, instead of the other
 *   harnesses' snake_case. Preserve this case.
 * - `commands`: uses cline's run_commands with a string array, `{commands: [...]}`.
 *   It can queue several commands. Its measured schema requires only commands, with string items.
 */
function toolCall(round: number): {
    id: string;
    type: "function";
    function: { name: string; arguments: unknown };
} {
    const callId = `call_long_run_${round}`;
    const command = commandFor(round);
    if (argShape === "exec") {
        return {
            id: callId,
            type: "function",
            function: {
                name: "exec",
                arguments: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} });\ntext(r.output);`,
            },
        };
    }
    if (argShape === "commandline") {
        return {
            id: callId,
            type: "function",
            function: {
                name: toolName,
                arguments: {
                    CommandLine: command,
                    Cwd: toolCwd,
                    WaitMsBeforeAsync: 10000,
                    toolSummary: TOOL_DESCRIPTION,
                    // The harness displays toolAction to explain this step; use the same command as CommandLine.
                    toolAction: command,
                },
            },
        };
    }
    if (argShape === "commands") {
        return {
            id: callId,
            type: "function",
            function: { name: toolName, arguments: { commands: [command] } },
        };
    }
    // Match the observed requests: command before description, for easier visual comparison.
    const args: Record<string, string> = { command };
    if (argShape === "command+description") args.description = TOOL_DESCRIPTION;
    return {
        id: callId,
        type: "function",
        function: { name: toolName, arguments: args },
    };
}

const targetBytes = bodyKb * 1024;
/** N text turns with tool calls. Text totals and context estimates count only these turns. */
const roundEntries = Array.from({ length: turns }, (_, i) => {
    const round = i + 1;
    return {
        message: {
            role: "assistant",
            content: largeMarkdown(
                `## Work record for turn ${round}`,
                targetBytes,
                round * 1000,
            ),
            tool_calls: [toolCall(round)],
        },
        finish_reason: "tool_calls",
    };
});

/**
 * The final two entries must stay in this order; see the file header:
 * - Task-end text: the same text as the mock's stop response; it ends the main process.
 * - Blank response: peri's execute_prediction treats it as empty and returns an empty
 *   action before it acquires the lock. Use one space, which was tested, instead of an
 *   empty string, which was not tested and can be treated as an invalid response by some adapters.
 */
const tailEntries = [
    { message: { role: "assistant", content: STOP_MESSAGE }, finish_reason: "stop" },
    { message: { role: "assistant", content: " " }, finish_reason: "stop" },
];

const responses = [...roundEntries, ...tailEntries];

const script = {
    note:
        `Generated by scripts/perf/gen-long-run.ts: ${turns} turns, each with about ${bodyKb}KB of text and one ` +
        `${toolName} tool call (argument format ${argShape}); two final entries follow: plain task-end text ` +
        "(ends the main process) and a blank response (for peri's prediction request, removing its fixed 5.0s shutdown wait). " +
        "Each turn sends history in messages; request N contains text from the preceding N-1 turns, so context grows with each turn.",
    defaults: { delayMs, chunkDelayMs, chunkSize },
    responses,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(script, null, 2);
writeFileSync(outPath, json + "\n");

const bodyBytes = roundEntries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.message.content, "utf8"),
    0,
);
console.log(`[gen-long-run] Wrote ${outPath}`);
console.log(
    `[gen-long-run] ${turns} turns × about ${bodyKb}KB of text (total text ${(bodyBytes / 1024).toFixed(0)}KB, ` +
        `file ${(Buffer.byteLength(json, "utf8") / 1024).toFixed(0)}KB, ${responses.length} entries = ${turns} turns + 2 final entries); ` +
        `tool ${toolName} (${argShape}); timing chunkSize=${chunkSize} chunkDelayMs=${chunkDelayMs} delayMs=${delayMs}`,
);
console.log(
    `[gen-long-run] Context growth estimate: final request body ≈ ${((bodyBytes * (turns - 1)) / turns / 1024).toFixed(0)}KB` +
        " (text from the preceding N-1 turns) + tool results",
);
console.log(
    "[gen-long-run] Run: cd playground/peri && bun perf-demo.ts --script " +
        outPath.replace(`${REPO_ROOT}/`, "") +
        " --exhausted stop --timeout-ms 1200000",
);
