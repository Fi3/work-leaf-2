#!/usr/bin/env bun
/**
 * llm-mock load-test demo: start one harness load test from playground/peri.
 *
 *   cd playground/peri
 *   bun perf-demo.ts                      # Start mock, start peri, sample every 100ms, write records.
 *   bun perf-demo.ts --timeout-ms 600000  # Default: data/scenarios/long-run.json.
 *                                         # The harness exits when the script ends; measure the full duration.
 *   bun perf-demo.ts --timeout-ms 30000   # Same arguments as scripts/perf/run.ts.
 *   bun perf-demo.ts --help
 *
 * Since version 3.17, peri no longer reads `{cwd}/.peri/settings.json` for provider settings.
 * It reads only `~/.peri/settings.json` or `--settings <file|JSON string>`. The demo passes
 * JSON through --settings at runtime, with the provider set to this mock's actual port,
 * so the user's global settings stay unchanged. The local .peri/settings.json remains
 * as a manual reference with the same structure.
 *
 * Output: <repository>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** Do not replace an explicit user option. Use this check before adding defaults below. */
const given = (name: string): boolean =>
    argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log(`Note: This demo accepts the same arguments as run.ts. Relative paths use the repository root (${REPO_ROOT}).`);
    console.log("      Output is in data/runs/<harness>/<runId>/ (run.json is the machine-readable interface).");
    console.log("      The default script is data/scenarios/long-run.json: a long script with Bash tool calls,");
    console.log("      shared by peri, opencode, and Claude Code. --exhausted defaults to stop.");
    process.exit(EXIT_OK);
}

/** Sandbox settings for peri: use this mock's port and map every alias to the llm-mock model. */
function sandboxSettings(port: number): string {
    const models = { fable: "llm-mock", opus: "llm-mock", sonnet: "llm-mock", haiku: "llm-mock" };
    return JSON.stringify({
        config: {
            active_alias: "sonnet",
            providers: [
                {
                    id: "llm-mock",
                    type: "openai",
                    apiKey: "mock-key",
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    models,
                },
            ],
            profiles: Object.fromEntries(
                Object.keys(models).map((alias) => [
                    alias,
                    { provider: "llm-mock", model: "llm-mock", effort: "low" },
                ]),
            ),
        },
    });
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // Default script: the long script with Bash calls, shared by peri, opencode, and Claude Code.
        // Supply it during parsing, which checks that --script is present; see PerfConfigDefaults.
        scriptPath: "data/scenarios/long-run.json",
    });
    // Select the harness name in `data/runs/<harness>/<runId>/`. It can be inferred from
    // the launch command, but an explicit name stays stable with wrappers or path changes.
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "peri";
    }

    // Let the default long script end naturally to measure its full duration. Loop mode
    // continues until the timeout and uses the obsolete fixed-duration measurement method.
    if (!given("--exhausted")) config.exhausted = "stop";
    // The playground/peri workspace snapshot in ~/.peri/threads/threads.db is stale.
    // Direct startup reports "workspace identity changed", so use a separate sandbox database.
    // To select another database, pass --peri-arg=--db-path --peri-arg=<path>.
    const userArgs = argv.filter((arg) => arg.startsWith("--peri-arg"));
    if (!userArgs.some((arg) => arg.includes("db-path"))) {
        config.periArgs.push("--db-path", join(import.meta.dir, ".peri/perf-threads.db"));
    }
    if (!userArgs.some((arg) => arg.includes("settings"))) {
        config.periArgs.push("--settings", sandboxSettings(config.port));
    }
    process.exitCode = await runPerf(config);
} catch (error) {
    console.error(`[perf] Startup failed: ${(error as Error).message}`);
    console.error("For usage, run bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
