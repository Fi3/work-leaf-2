/**
 * Process sampling: read the harness process's cumulative CPU time and resident memory (RSS)
 * at fixed intervals.
 *
 * ## Why use proc_pid_rusage
 *
 * On macOS, `ps -o %cpu` is the **average over the process lifetime**, not an instantaneous
 * value. Instead, calculate differences in cumulative CPU time. Measurements of two methods
 * on macOS 26.5.1 / Apple Silicon (reproduce with `bun run scripts/perf/verify.ts`):
 *
 *   Method                            Cost per read   Resolution   Reading at full use of one core
 *   ps -p <pid> -o time= differences   1.2 ms          50 ms        98.5% (±50 ms quantization error)
 *   proc_pid_rusage differences        0.8 µs          ~1 µs        98.0%
 *
 * For a 100 ms sample window, the 50 ms quantization error from ps is equivalent to ±50%.
 * Thus, rusage is the default; ps is only a fallback when FFI is unavailable. rusage is a
 * direct function call, creates no child process, and has almost no effect on the measured process.
 *
 * ## Pitfall: returned values are not nanoseconds
 *
 * The documentation gives nanoseconds as the units for ri_user_time / ri_system_time, but
 * local measurements show **ticks of the Mach absolute timebase** (mach_timebase_info:
 * numer=125 denom=3 → 1 tick ≈ 41.67 ns). Without conversion, CPU use is underestimated
 * by a factor of 41.7 (full use of one core reads as 2.4%). Always convert with the actual
 * mach_timebase_info value. On Intel, the timebase is 1/1, so conversion leaves the value unchanged.
 *
 * CPU% uses 100% for one core. Processes with multiple threads can exceed 100%.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

export type SamplerKind = "rusage" | "ps";

/** Mach timebase: 1 tick = numer / denom nanoseconds. */
export interface MachTimebase {
    numer: number;
    denom: number;
}

/** One cumulative reading: cumulative CPU time (nanoseconds) and resident memory (bytes). */
export interface CumulativeReading {
    cpuNs: number;
    rssBytes: number;
    /**
     * Cumulative CPU time (nanoseconds) of **child processes reaped by this process**,
     * from the rusage ri_child_* fields.
     *
     * This is needed because process tree measurement finds descendants by refreshing the PID
     * set every treeRefreshMs. Shells started for each tool call live only tens of milliseconds
     * and almost never appear in that set. In a synthetic workload, the default 2000 ms refresh
     * captured only 33% of actual child CPU time. The harness **reaps** these shells, so their
     * CPU time accumulates in the parent's ri_child_* fields. One read obtains the exact total,
     * regardless of sampling frequency.
     *
     * The ps backend cannot read this value and returns 0. It is only a fallback when FFI is unavailable.
     */
    childCpuNs: number;
}

/** One sample. */
export interface ProcessSample {
    /** Sample time (milliseconds since the epoch). */
    ts: number;
    /** Milliseconds since sampling started. */
    elapsedMs: number;
    /** Instantaneous root process CPU use (100% for one core). */
    cpuPercent: number;
    rssBytes: number;
    /** Total instantaneous CPU use of the root and visible descendants, excluding reaped-child counters. */
    treeCpuPercent: number;
    /**
     * Instantaneous CPU use of **children reaped by the root process** (100% for one core),
     * calculated from differences in rusage counters.
     *
     * This and the parent's visible-descendant reading are complementary lower bounds. This
     * value covers short-lived children missed by process table refreshes. The other covers
     * descendants that remain alive throughout sampling and have not been reaped. They can
     * overlap: a previously visible child can later be reaped, adding its whole lifetime to
     * the counter. **Do not add them.** Use the larger value for a tighter lower bound
     * (see resourceCost in score.ts).
     */
    childCpuPercent: number;
    treeRssBytes: number;
    /** Number of processes in the tree with successful readings, including the root. */
    procs: number;
}

/** Source of sample readings; tests can supply a fake backend. */
export interface SamplerBackend {
    kind: SamplerKind;
    /** One-line description for logs. */
    describe(): string;
    /** Read cumulative values; return null if the process does not exist. */
    read(pid: number): CumulativeReading | null;
}

export const CSV_COLUMNS = [
    "ts",
    "elapsed_ms",
    "cpu_pct",
    "rss_kb",
    "tree_cpu_pct",
    "tree_rss_kb",
    "procs",
    // Added 2026-09-19. Append columns only: readers use header names and treat this missing column as 0.
    "child_cpu_pct",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const CSV_HEADER = CSV_COLUMNS.join(",");

// ---------------------------------------------------------------------------
// Pure calculations for unit testing
// ---------------------------------------------------------------------------

/** Mach ticks → nanoseconds. */
export function ticksToNs(ticks: number, timebase: MachTimebase): number {
    return ticks * (timebase.numer / timebase.denom);
}

/** Difference in cumulative CPU time → instantaneous CPU percentage (100% for one core). */
export function cpuPercent(deltaNs: number, elapsedMs: number): number {
    if (!(elapsedMs > 0) || !(deltaNs > 0)) return 0;
    return (deltaNs / (elapsedMs * 1e6)) * 100;
}

/** Parse `[[HH:]MM:]SS[.cc]` from `ps -o time=` into milliseconds; return null for empty or invalid input. */
export function parsePsTimeToMs(raw: string): number | null {
    const text = raw.trim();
    if (text === "" || text === "-") return null;
    const parts = text.split(":");
    if (parts.length > 3) return null;
    let seconds = 0;
    for (const part of parts) {
        const value = Number(part);
        if (!Number.isFinite(value) || value < 0) return null;
        seconds = seconds * 60 + value;
    }
    return seconds * 1000;
}

/** Collect the root and all descendants from a pid/ppid table (breadth-first, pure function). */
export function collectTree(
    rootPid: number,
    processes: ReadonlyArray<{ pid: number; ppid: number }>,
): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const { pid, ppid } of processes) {
        const siblings = childrenOf.get(ppid);
        if (siblings === undefined) childrenOf.set(ppid, [pid]);
        else siblings.push(pid);
    }
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
        const current = queue.shift() as number;
        for (const child of childrenOf.get(current) ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            queue.push(child);
        }
    }
    return [...seen];
}

/** CSV row without a newline. */
export function formatCsvRow(sample: ProcessSample): string {
    return [
        new Date(sample.ts).toISOString(),
        sample.elapsedMs.toFixed(0),
        sample.cpuPercent.toFixed(2),
        (sample.rssBytes / 1024).toFixed(0),
        sample.treeCpuPercent.toFixed(2),
        (sample.treeRssBytes / 1024).toFixed(0),
        String(sample.procs),
        sample.childCpuPercent.toFixed(2),
    ].join(",");
}

/**
 * Optional columns: older results lack them, so readers must use defaults instead of errors.
 * `child_cpu_pct` was added on 2026-09-19. Earlier results always read as 0, and their process
 * tree measurements are too low. Readers (score.ts / gen-chart-data.ts) mark that limitation;
 * do not infer values here.
 */
const OPTIONAL_COLUMNS = new Set<CsvColumn>(["child_cpu_pct"]);

/** Check whether a CSV has a column, to identify the measurement method of older results. */
export function csvHasColumn(text: string, name: CsvColumn): boolean {
    const header = (text.trim().split("\n")[0] ?? "").split(",").map((entry) => entry.trim());
    return header.includes(name);
}

/**
 * Sample CSV → samples. **Map columns by header name, not by fixed index.**
 * Adding a measure must not break readers, but **a missing required column must cause an error**.
 * An error is better than reading CPU as memory and drawing a plausible but incorrect chart.
 */
export function parseSamplesCsv(text: string): ProcessSample[] {
    const lines = text.trim().split("\n");
    const header = (lines[0] ?? "").split(",").map((name) => name.trim());
    const columnIndex = new Map(header.map((name, index) => [name, index]));
    const missing = CSV_COLUMNS.filter(
        (name) => !columnIndex.has(name) && !OPTIONAL_COLUMNS.has(name),
    );
    if (missing.length > 0) {
        throw new Error(
            `Sample CSV is missing required columns ${missing.join(", ")} (header: ${header.join(",")})`,
        );
    }
    const cell = (cells: string[], name: CsvColumn): string =>
        columnIndex.has(name) ? (cells[columnIndex.get(name)!] ?? "0") : "0";

    const samples: ProcessSample[] = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "") continue;
        const cells = line.split(",");
        const ts = Date.parse(cell(cells, "ts"));
        samples.push({
            ts: Number.isNaN(ts) ? 0 : ts,
            elapsedMs: Number(cell(cells, "elapsed_ms")),
            cpuPercent: Number(cell(cells, "cpu_pct")),
            rssBytes: Number(cell(cells, "rss_kb")) * 1024,
            treeCpuPercent: Number(cell(cells, "tree_cpu_pct")),
            treeRssBytes: Number(cell(cells, "tree_rss_kb")) * 1024,
            procs: Number(cell(cells, "procs")),
            childCpuPercent: Number(cell(cells, "child_cpu_pct")),
        });
    }
    return samples;
}

export interface SampleSummary {
    count: number;
    durationMs: number;
    cpuMean: number;
    cpuMax: number;
    rssMeanBytes: number;
    rssMaxBytes: number;
    rssLastBytes: number;
    treeCpuMean: number;
    treeCpuMax: number;
    treeRssMeanBytes: number;
    treeRssMaxBytes: number;
}

/** Summary: averages and peaks; return zeros for an empty sample set. */
export function summarize(samples: readonly ProcessSample[]): SampleSummary {
    const empty: SampleSummary = {
        count: 0,
        durationMs: 0,
        cpuMean: 0,
        cpuMax: 0,
        rssMeanBytes: 0,
        rssMaxBytes: 0,
        rssLastBytes: 0,
        treeCpuMean: 0,
        treeCpuMax: 0,
        treeRssMeanBytes: 0,
        treeRssMaxBytes: 0,
    };
    if (samples.length === 0) return empty;
    const sum = (pick: (sample: ProcessSample) => number) =>
        samples.reduce((total, sample) => total + pick(sample), 0);
    const max = (pick: (sample: ProcessSample) => number) =>
        samples.reduce((peak, sample) => Math.max(peak, pick(sample)), 0);
    const last = samples[samples.length - 1] as ProcessSample;
    return {
        count: samples.length,
        durationMs: last.elapsedMs,
        cpuMean: sum((s) => s.cpuPercent) / samples.length,
        cpuMax: max((s) => s.cpuPercent),
        rssMeanBytes: sum((s) => s.rssBytes) / samples.length,
        rssMaxBytes: max((s) => s.rssBytes),
        rssLastBytes: last.rssBytes,
        treeCpuMean: sum((s) => s.treeCpuPercent) / samples.length,
        treeCpuMax: max((s) => s.treeCpuPercent),
        treeRssMeanBytes: sum((s) => s.treeRssBytes) / samples.length,
        treeRssMaxBytes: max((s) => s.treeRssBytes),
    };
}

// ---------------------------------------------------------------------------
// Backend implementations
// ---------------------------------------------------------------------------

/** Field offsets used in rusage_info_v4, verified on real hardware. */
const RUSAGE_INFO_V4 = 4;
const OFF_RI_USER_TIME = 16;
const OFF_RI_SYSTEM_TIME = 24;
const OFF_RI_RESIDENT_SIZE = 64;
/**
 * Cumulative CPU time of reaped children (ri_child_user_time / ri_child_system_time in rusage_info_v4).
 * Verified on 2026-09-19: a child used Time::HiRes to consume exactly 2 s of CPU time and was
 * reaped by its parent. The parent read [96]+[104] = 1.995 s, while [32]/[40]
 * (ri_pkg_idle_wkups / ri_interrupt_wkups) were approximately 0.
 * **The units are also Mach ticks, not the documented nanoseconds.** Convert with the timebase,
 * as for [16]/[24].
 */
const OFF_RI_CHILD_USER_TIME = 96;
const OFF_RI_CHILD_SYSTEM_TIME = 104;
/** Buffer large enough for all v4 fields (v4 is approximately 296 bytes). */
const RUSAGE_BUFFER_BYTES = 512;

/** Load the two required libSystem symbols; return null on failure (not macOS or missing symbols). */
function loadLibSystem(): {
    proc_pid_rusage: (pid: number, flavor: number, buffer: unknown) => number;
    mach_timebase_info: (out: unknown) => number;
} | null {
    try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
            proc_pid_rusage: {
                args: [FFIType.i32, FFIType.i32, FFIType.ptr],
                returns: FFIType.i32,
            },
            mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
        });
        return lib.symbols as never;
    } catch {
        return null;
    }
}

/** Read the Mach timebase; return null on failure. */
function readTimebase(symbols: {
    mach_timebase_info: (out: unknown) => number;
}): MachTimebase | null {
    const buffer = new Uint8Array(8);
    if (symbols.mach_timebase_info(ptr(buffer)) !== 0) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    const numer = view.getUint32(0, true);
    const denom = view.getUint32(4, true);
    if (!(numer > 0) || !(denom > 0)) return null;
    return { numer, denom };
}

/** Preferred backend: call proc_pid_rusage through FFI without creating child processes. */
export function createRusageBackend(): SamplerBackend | null {
    const symbols = loadLibSystem();
    if (symbols === null) return null;
    const timebase = readTimebase(symbols);
    if (timebase === null) return null;
    const buffer = new Uint8Array(RUSAGE_BUFFER_BYTES);
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    return {
        kind: "rusage",
        describe: () =>
            `proc_pid_rusage (1 tick = ${(timebase.numer / timebase.denom).toFixed(2)} ns, about 0.8µs per call)`,
        read(pid: number): CumulativeReading | null {
            if (symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buffer)) !== 0) return null;
            const ticks = Number(
                view.getBigUint64(OFF_RI_USER_TIME, true) +
                    view.getBigUint64(OFF_RI_SYSTEM_TIME, true),
            );
            const childTicks = Number(
                view.getBigUint64(OFF_RI_CHILD_USER_TIME, true) +
                    view.getBigUint64(OFF_RI_CHILD_SYSTEM_TIME, true),
            );
            return {
                cpuNs: ticksToNs(ticks, timebase),
                childCpuNs: ticksToNs(childTicks, timebase),
                rssBytes: Number(view.getBigUint64(OFF_RI_RESIDENT_SIZE, true)),
            };
        },
    };
}

/** Fallback backend: differences from `ps -p <pid> -o time=,rss=` (about 1.2 ms per read, 50 ms resolution). */
export function createPsBackend(): SamplerBackend {
    return {
        kind: "ps",
        describe: () => "ps -p <pid> -o time=,rss= differences (fallback: about 1.2ms per call, about 50ms resolution)",
        read(pid: number): CumulativeReading | null {
            const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "time=,rss="]);
            if (result.exitCode !== 0) return null;
            const fields = result.stdout.toString().trim().split(/\s+/);
            if (fields.length < 2) return null;
            const cpuMs = parsePsTimeToMs(fields[0] as string);
            const rssKb = Number(fields[1]);
            if (cpuMs === null || !Number.isFinite(rssKb)) return null;
            // ps cannot read cumulative values for reaped children; only rusage has those fields. Use 0.
            // This backend is only a fallback when FFI is unavailable, so child_cpu_pct is always 0.
            return { cpuNs: cpuMs * 1e6, childCpuNs: 0, rssBytes: rssKb * 1024 };
        },
    };
}

/** List pid/ppid for all processes (one `ps -axo` call, about 13 ms). */
export function listProcesses(): Array<{ pid: number; ppid: number }> {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
    if (result.exitCode !== 0) return [];
    const rows: Array<{ pid: number; ppid: number }> = [];
    for (const line of result.stdout.toString().split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 2) continue;
        const pid = Number(fields[0]);
        const ppid = Number(fields[1]);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

export interface SamplerOptions {
    /** Root process (the harness). */
    pid: number;
    backend: SamplerBackend;
    /** Include descendant processes, such as MCP children started by the harness. */
    withTree?: boolean;
    /** Process tree refresh interval in milliseconds, default 2000; reuse the last PID set between refreshes. */
    treeRefreshMs?: number;
    /** Source of the process table; tests can supply it. */
    listProcesses?: () => Array<{ pid: number; ppid: number }>;
    /** Time source; tests can fix its value. */
    now?: () => number;
}

export class ProcessSampler {
    private readonly previous = new Map<number, CumulativeReading>();
    private readonly options: Required<Omit<SamplerOptions, "now">> & { now: () => number };
    private tree: number[] = [];
    private treeRefreshedAt = Number.NEGATIVE_INFINITY;
    /** Previous root process counter for reaped children, set by prime as the baseline for differences. */
    private childCpuBaselineNs: number | null = null;

    constructor(options: SamplerOptions) {
        this.options = {
            withTree: false,
            treeRefreshMs: 2000,
            listProcesses,
            ...options,
            now: options.now ?? Date.now,
        };
        this.tree = [options.pid];
    }

    /** Set baseline readings before the first sample; otherwise the first difference is 0. */
    prime(): boolean {
        const reading = this.options.backend.read(this.options.pid);
        if (reading === null) return false;
        this.previous.set(this.options.pid, reading);
        this.childCpuBaselineNs = reading.childCpuNs;
        return true;
    }

    /** Refresh the process tree; use only the root if the full table cannot be read. */
    refreshTree(): number[] {
        if (!this.options.withTree) {
            this.tree = [this.options.pid];
            return this.tree;
        }
        const processes = this.options.listProcesses();
        this.tree =
            processes.length === 0 ? [this.options.pid] : collectTree(this.options.pid, processes);
        this.treeRefreshedAt = this.options.now();
        return this.tree;
    }

    /**
     * Take one sample. elapsedMs is the measured time since sampling started, saved to CSV for
     * charts. deltaMs is the measured interval since the last sample and is the denominator
     * for CPU differences. Do not use the nominal interval, or timer variation will appear
     * as changes in CPU use. Return null if the root process no longer exists.
     */
    sample(timing: { elapsedMs: number; deltaMs: number }): ProcessSample | null {
        const now = this.options.now();
        if (this.options.withTree && now - this.treeRefreshedAt >= this.options.treeRefreshMs) {
            this.refreshTree();
        }

        const current = new Map<number, CumulativeReading>();
        let root: CumulativeReading | null = null;
        let rootCpuNs = 0;
        let childCpuNs = 0;
        let treeCpuNs = 0;
        let treeRssBytes = 0;
        let procs = 0;

        for (const pid of this.tree.length > 0 ? this.tree : [this.options.pid]) {
            const reading = this.options.backend.read(pid);
            if (reading === null) continue;
            current.set(pid, reading);
            procs += 1;
            treeRssBytes += reading.rssBytes;
            const before = this.previous.get(pid);
            // A new process has no baseline. Use 0 for this sample, not its cumulative time since startup.
            const delta = before === undefined ? 0 : Math.max(0, reading.cpuNs - before.cpuNs);
            treeCpuNs += delta;
            if (pid === this.options.pid) {
                root = reading;
                rootCpuNs = delta;
                // Reaped-child counters only increase. The difference includes short-lived children missed by the table.
                childCpuNs =
                    this.childCpuBaselineNs === null
                        ? 0
                        : Math.max(0, reading.childCpuNs - this.childCpuBaselineNs);
                this.childCpuBaselineNs = reading.childCpuNs;
            }
        }
        this.previous.clear();
        for (const [pid, reading] of current) this.previous.set(pid, reading);

        if (root === null) return null;
        return {
            ts: now,
            elapsedMs: timing.elapsedMs,
            cpuPercent: cpuPercent(rootCpuNs, timing.deltaMs),
            rssBytes: root.rssBytes,
            treeCpuPercent: cpuPercent(treeCpuNs, timing.deltaMs),
            // --no-tree means only the main process, so exclude descendant readings from this column.
            childCpuPercent: this.options.withTree ? cpuPercent(childCpuNs, timing.deltaMs) : 0,
            treeRssBytes,
            procs,
        };
    }
}
