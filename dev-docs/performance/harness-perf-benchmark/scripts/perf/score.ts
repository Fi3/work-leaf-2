/**
 * English translation of comments from the external harness-perf-benchmark reference.
 * Combined score: express CPU and memory as one number to compare the total resource cost
 * of running the same script.
 *
 * ## Status: Beta (trial started on 2026-09-19)
 *
 * The implementation is stable: integration at each sample, selection of the larger descendant
 * CPU value, and estimation of the final unsampled interval have been verified. However,
 * **the measurement method is not final**. Whether descendant CPU counts as harness overhead,
 * and whether duration means elapsed time or controlled execution time, are still under discussion.
 * This is a **candidate method** for comparing total resource costs, not a verdict on a harness.
 * A change to the method changes the metric: document it in the consuming project first,
 * then repeat a complete batch.
 *
 * ## Method: CPU and memory at 1:1
 *
 *     CU     = 1.0 × core·s + 1.0 × GB·s
 *     core·s = ∫(cpu_pct/100) dt      GB·s = ∫(rss_kb/2^20) dt     (integrate over time)
 *     score  = 100 × smallest CU in this batch / this run's CU
 *              (best = 100; comparisons are valid only within the same batch)
 *
 * The formula structure comes from Alibaba Cloud Function Compute (FC):
 * "CU usage = ∑(resource usage × CU conversion coefficient)". It converts CPU and memory to
 * one unit, then adds them, which matches the question here. The FC coefficients for active
 * elastic instances, checked against its official pricing page on 2026-09-19, are:
 * vCPU 1.0 CU/(vCPU·s), memory 0.15 CU/(GB·s), invocations 75 CU per 10,000,
 * and disk 0.05 CU/(GB·s).
 *
 * **This reference project sets its own coefficients: CPU and memory have the same cost per
 * second (1 core·s = 1 GB·s), instead of FC's memory coefficient of 0.15.**
 * FC's 0.15 means "1 core ≈ 6.67 GB of memory". That is a cloud provider's price. With those
 * rates, memory is only 1%–8% of the total, so memory efficiency has almost no effect on the
 * score. In measurements, reducing the memory weight to zero barely changed the rankings.
 * This reference project measures **resource burden**: per unit of time, one core and one GB
 * of memory each count as one unit; neither is cheaper. For industry context, the newer AWS
 * Lambda vCPU rates imply ≈7.6, and Cloud Run ≈9, in the same direction as FC. To recalculate
 * with a provider's price, change only `CU_COEFFICIENTS.gbSecond`; do not add another formula.
 *
 * ## Peak resource use is not converted to a score
 *
 * The integral answers "how much is used in total"; the peak answers "how much is needed at
 * the worst moment". Memory capacity is selected for the peak, so both questions matter.
 * Peaks (`resourcePeaks`: MB, %) are **absolute quantities** that can be compared directly.
 * A relative score within a batch would add another arbitrary number, so peaks are shown
 * beside CU without conversion to scores.
 *
 * ## Four deliberate differences from FC
 *
 * 1. **The memory coefficient is not FC's 0.15**: this reference project measures resource
 *    burden, with the same cost per second for CPU and memory, for the reasons above.
 * 2. **Memory is measured RSS**, not FC's "declared capacity × duration". Only measured data
 *    is available here, and actual measurements also make the comparison fairer.
 * 3. **Disk is excluded** because there is no data, and **GPU is excluded** because this
 *    reference project does not sample GPUs. Duration is **elapsed time through normal exit**,
 *    rather than FC's controlled execution time.
 * 4. **Invocation counts are not converted**: the script determines the number of requests;
 *    this is not harness overhead.
 *
 * ## Which descendant CPU measurement to use
 *
 * Shells created for tool calls live for only tens of milliseconds. A process table sampled
 * every 2 seconds will usually miss them. The harness **reaps** these shells, so their CPU
 * time enters the parent process's rusage ri_child_* counters. Both methods give lower bounds
 * on the true value, and they can overlap: a sampled child can later be reaped, causing the
 * same CPU time to appear in the counters. **Use the larger value, not their sum.**
 */

import type { ProcessSample } from "./sampler";

/**
 * CU conversion coefficients: **changing these two numbers changes the scoring method**.
 * Do not adjust them to improve the rankings.
 *
 * The structure comes from Alibaba Cloud FC; the values are this reference project's own
 * **CPU-to-memory ratio of 1:1** (see the file header). FC's memory coefficient is
 * 0.15 CU/(GB·s). To recalculate with other prices, change only this location and document
 * the change in docs/perf-compare.md.
 */
export const CU_COEFFICIENTS = {
    /** CU/(vCPU·s): core·s and CU have a 1:1 ratio. */
    vCpuSecond: 1.0,
    /** CU/(GB·s): the same cost as CPU (1 core·s = 1 GB·s); FC uses 0.15 here. */
    gbSecond: 1.0,
} as const;

/** Default limit for the final unsampled interval: normally about one sampling interval before exit. */
export const DEFAULT_MAX_TAIL_MS = 500;

export interface CostOptions {
    /** Measurement scope: `tree` (root process and descendants, default) or `root` (main process only). */
    scope?: "tree" | "root";
    /** Gap from the final sample to process exit, in milliseconds; estimated from the final sample rates. */
    tailMs?: number;
    /** Number of final samples whose mean rate is used for the estimate (default 3). */
    tailWindow?: number;
    /** Maximum gap, in milliseconds; cap estimates after a forced or abnormal exit (default 500). */
    maxTailMs?: number;
    /**
     * The elapsedMs of the sample before the first sample here; this determines the first dt.
     * Use 0 for the complete run. For a segment, use the final sample time of the previous
     * segment; otherwise the first dt is measured from zero.
     */
    originMs?: number;
    /**
     * CPU calibration coefficient (`cpuScale`, from calibrate.ts; default 1 means no calibration).
     *
     * **Multiply only the CPU term**. Memory is measured locally in byte·s; machine speed does
     * not affect its units, so it is not rescaled. **Multiply**, rather than divide: on a faster
     * machine, the same core·s corresponds to more standard seconds. Reversing this would make
     * a faster machine appear cheaper. With a coefficient of 1, rescaled fields equal their
     * original values (`standardCpuSeconds === cpuSeconds`, `rawCu === cu`).
     */
    cpuScale?: number;
}

export interface ResourceCost {
    /** Core·s (including descendants when scope=tree): **local machine seconds**, without rescaling. */
    cpuSeconds: number;
    /** GB·s (resident memory × duration). */
    gbSeconds: number;
    /** Total score: `cpuCu + memoryCu`. */
    cu: number;
    cpuCu: number;
    memoryCu: number;
    /**
     * Rescaled CPU term: `cpuSeconds × cpuScale`, in **project standard CPU unit·s**
     * (= 7-Zip benchmark MIPS × seconds / baseline).
     *
     * The baseline is a conversion reference set by this reference project;
     * **no real reference machine was measured**. The value expresses how many project
     * standard CPU unit seconds equal one local machine second, based on its 7-Zip Rating.
     * For old fixtures without this field, use the value without rescaling (= `cpuSeconds`).
     */
    standardCpuSeconds?: number;
    /**
     * CPU calibration coefficient (**multiply** core·s; 1 means no calibration).
     * For old fixtures without this field, use 1.
     */
    cpuScale?: number;
    /**
     * CU **without rescaling**: `CU_COEFFICIENTS.vCpuSecond × cpuSeconds + memoryCu`.
     * Equals `cu` when `cpuScale === 1`. Calibration multiplies only the CPU term, so
     * `cu - rawCu` is exactly `cpuCu × (cpuScale − 1)`; consumers can use this as a check.
     */
    rawCu?: number;
    /** Core·s used by the main process itself. */
    rootCpuSeconds: number;
    /** Descendant core·s (= max(sampled value, reaped-child counter)). */
    childCpuSeconds: number;
    /** Core·s of descendants visible in process-table samples during the sampling window. */
    childSampledSeconds: number;
    /** Core·s from reaped-child counters; requires child_cpu_pct in samples, otherwise 0 for old data. */
    childCounterSeconds: number;
    /** Selected descendant CPU source; `counter` indicates that short-lived children dominate. */
    childCpuFrom: "counter" | "sampled";
    /** Sampling window duration in milliseconds, given by the final sample time. */
    samplingMs: number;
    /** Final unsampled duration actually estimated, in milliseconds, capped by maxTailMs. */
    tailAppliedMs: number;
    /** Number of samples. */
    sampleCount: number;
}

/** Measured intervals between samples, in seconds; the first dt starts at `originMs`. */
function intervalsSeconds(samples: readonly ProcessSample[], originMs: number): number[] {
    const out: number[] = [];
    let previous = originMs;
    for (const sample of samples) {
        out.push(Math.max(0, (sample.elapsedMs - previous) / 1000));
        previous = sample.elapsedMs;
    }
    return out;
}

/**
 * Convert a sample sequence to resource cost (the central formula).
 *
 * Return zero values for an empty sequence. The caller must detect runs without samples;
 * do not throw an error here.
 */
export function resourceCost(
    samples: readonly ProcessSample[],
    options: CostOptions = {},
): ResourceCost {
    const scope = options.scope ?? "tree";
    const tailWindow = Math.max(1, options.tailWindow ?? 3);
    const maxTailMs = Math.max(0, options.maxTailMs ?? DEFAULT_MAX_TAIL_MS);
    const tailMs = Math.min(Math.max(0, options.tailMs ?? 0), maxTailMs);
    const cpuScale = options.cpuScale ?? 1;
    if (!Number.isFinite(cpuScale) || cpuScale <= 0) {
        throw new Error(`cpuScale 必须是有限正数（1 = 未校准），收到 ${JSON.stringify(options.cpuScale)}`);
    }

    const empty: ResourceCost = {
        cpuSeconds: 0,
        gbSeconds: 0,
        cu: 0,
        cpuCu: 0,
        memoryCu: 0,
        standardCpuSeconds: 0,
        cpuScale,
        rawCu: 0,
        rootCpuSeconds: 0,
        childCpuSeconds: 0,
        childSampledSeconds: 0,
        childCounterSeconds: 0,
        childCpuFrom: "sampled",
        samplingMs: 0,
        tailAppliedMs: 0,
        sampleCount: 0,
    };
    if (samples.length === 0) return empty;

    const deltas = intervalsSeconds(samples, options.originMs ?? 0);
    let rootCpuSeconds = 0;
    let childSampledSeconds = 0;
    let childCounterSeconds = 0;
    let gbSeconds = 0;

    samples.forEach((sample, index) => {
        const dt = deltas[index] as number;
        rootCpuSeconds += (sample.cpuPercent / 100) * dt;
        if (scope === "tree") {
            // The tree value includes the root process; subtract it to obtain descendant CPU use.
            childSampledSeconds += Math.max(0, sample.treeCpuPercent - sample.cpuPercent) / 100 * dt;
            childCounterSeconds += (sample.childCpuPercent / 100) * dt;
            gbSeconds += (sample.treeRssBytes / 2 ** 30) * dt;
        } else {
            gbSeconds += (sample.rssBytes / 2 ** 30) * dt;
        }
    });

    // Estimate the final unsampled interval: sampling stops when the process disappears, leaving about one interval.
    // Measurements on 2026-09-19 found a consistent ≈100 ms gap, or ≈7% missed CPU for a fast 1.5 s harness such as pi.
    let tailAppliedMs = 0;
    if (tailMs > 0) {
        const tail = samples.slice(-tailWindow);
        const rate = (pick: (sample: ProcessSample) => number) =>
            tail.reduce((total, sample) => total + pick(sample), 0) / tail.length;
        const [rootRate, sampledRate, counterRate, rssRate] = [
            rate((sample) => sample.cpuPercent),
            rate((sample) => Math.max(0, sample.treeCpuPercent - sample.cpuPercent)),
            rate((sample) => sample.childCpuPercent),
            rate((sample) => (scope === "tree" ? sample.treeRssBytes : sample.rssBytes)),
        ];
        const seconds = tailMs / 1000;
        rootCpuSeconds += (rootRate / 100) * seconds;
        if (scope === "tree") {
            childSampledSeconds += (sampledRate / 100) * seconds;
            childCounterSeconds += (counterRate / 100) * seconds;
        }
        gbSeconds += (rssRate / 2 ** 30) * seconds;
        tailAppliedMs = tailMs;
    }

    // Both descendant measurements are lower bounds and can overlap; use the larger value, not their sum.
    const childCpuSeconds =
        scope === "tree" ? Math.max(childSampledSeconds, childCounterSeconds) : 0;
    const cpuSeconds = rootCpuSeconds + childCpuSeconds;
    // Rescale only the CPU term: standard CPU unit·s = local core·s × cpuScale.
    // Memory stays in locally measured byte·s. The two terms therefore have different units, so rankings can change.
    const standardCpuSeconds = cpuSeconds * cpuScale;
    const cpuCu = CU_COEFFICIENTS.vCpuSecond * standardCpuSeconds;
    const memoryCu = CU_COEFFICIENTS.gbSecond * gbSeconds;

    return {
        ...empty,
        cpuSeconds,
        gbSeconds,
        cu: cpuCu + memoryCu,
        cpuCu,
        memoryCu,
        standardCpuSeconds,
        cpuScale,
        rawCu: CU_COEFFICIENTS.vCpuSecond * cpuSeconds + memoryCu,
        rootCpuSeconds,
        childCpuSeconds,
        childSampledSeconds,
        childCounterSeconds,
        childCpuFrom: childCounterSeconds > childSampledSeconds ? "counter" : "sampled",
        samplingMs: (samples[samples.length - 1] as ProcessSample).elapsedMs,
        tailAppliedMs,
        sampleCount: samples.length,
    };
}

/** Calibration coefficient from the cost; use 1 for old fixtures and uncalibrated data. */
export function scaleOf(cost: ResourceCost): number {
    return cost.cpuScale ?? 1;
}

/** Rescaled core·s in project standard CPU units; old fixtures without this field use unscaled values. */
export function standardCpuSeconds(cost: ResourceCost): number {
    return cost.standardCpuSeconds ?? cost.cpuSeconds * scaleOf(cost);
}

/** CU without rescaling; old fixtures fall back to `cu`, which is valid only without calibration. */
export function rawCu(cost: ResourceCost): number {
    return cost.rawCu ?? cost.cu;
}

/**
 * Display format for `cpuScale` (**format only; do not change calculations**):
 * `9.386899999999999` → `9.3869`. Extra digits are an effect of binary fractions, not useful
 * information. Use this format in logs and pages.
 */
export function formatCpuScale(scale: number): string {
    if (!Number.isFinite(scale)) return String(scale);
    return String(Number(scale.toFixed(4)));
}

/** Display a byte count in MB with one decimal place. */
export function formatBytesMb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Peak resource use over the complete window (the worst moment), which complements the
 * integral used for resource cost.
 *
 * Provide this centrally instead of making each consumer use `Math.max`: peak measurement
 * also needs one method. Define in one place whether to use the process tree or main process,
 * and whether to record the process count at the peak to identify tool-child contributions.
 * As with integration, these choices need one owner. **Do not convert peaks to scores**:
 * MB and % are absolute quantities that can be compared directly.
 */
export interface ResourcePeaks {
    /** Peak process-tree RSS, in bytes. */
    treeRssBytes: number;
    /** Peak process-tree CPU use, as a percentage where one core is 100%. */
    treeCpuPercent: number;
    /** Peak main-process RSS, in bytes. */
    rootRssBytes: number;
    /** Peak main-process CPU use, as a percentage where one core is 100%. */
    rootCpuPercent: number;
    /** Time of peak process-tree RSS, in milliseconds, to distinguish growth during work from a final peak. */
    treeRssAtMs: number;
    /** Process count at the RSS peak; >1 means tool children were present and included in the peak. */
    treeRssProcs: number;
    sampleCount: number;
}

/** Peak options select only the scope; duration and estimates of the final interval do not affect peaks. */
export interface PeakOptions {
    /** Measurement scope: `tree` (default) or `root`. */
    scope?: "tree" | "root";
}

/** Convert samples to peaks; return zero values for an empty sequence. */
export function resourcePeaks(
    samples: readonly ProcessSample[],
    options: PeakOptions = {},
): ResourcePeaks {
    const scope = options.scope ?? "tree";
    const peaks: ResourcePeaks = {
        treeRssBytes: 0,
        treeCpuPercent: 0,
        rootRssBytes: 0,
        rootCpuPercent: 0,
        treeRssAtMs: 0,
        treeRssProcs: 0,
        sampleCount: samples.length,
    };
    for (const sample of samples) {
        peaks.rootRssBytes = Math.max(peaks.rootRssBytes, sample.rssBytes);
        peaks.rootCpuPercent = Math.max(peaks.rootCpuPercent, sample.cpuPercent);
        if (scope !== "tree") continue;
        if (sample.treeRssBytes > peaks.treeRssBytes) {
            peaks.treeRssBytes = sample.treeRssBytes;
            peaks.treeRssAtMs = sample.elapsedMs;
            peaks.treeRssProcs = sample.procs;
        }
        peaks.treeCpuPercent = Math.max(peaks.treeCpuPercent, sample.treeCpuPercent);
    }
    return peaks;
}

/** Three cost segments: startup to first request, first to last request, and last request to exit. */
export interface SegmentCosts {
    startup: ResourceCost;
    span: ResourceCost;
    tail: ResourceCost;
}

/**
 * Split samples at the first and last request, and calculate each of the three segment costs.
 *
 * This matters because almost all of peri / Codex's apparent startup overhead is **waiting
 * at shutdown**: peri waits a fixed ≈5 s, and Codex waits ≈10 s for a DNS timeout. CPU use
 * is nearly zero during that time, but memory still contributes GB·s. Separate segments
 * make that cost visible.
 *
 * **The sum of the three segments deliberately differs from the `resourceCost` total**.
 * The difference is the final unsampled interval, which is estimated only in the total.
 * Measurements of six harnesses confirmed that the three segments plus that estimate equal
 * the total in each case. Likewise, select the larger descendant CPU value only once for
 * the complete run. Selecting it separately per segment can count sampled child CPU again
 * in the segment where the child is reaped.
 *
 * Forward `cpuScale` unchanged from `options`: each segment must use the same coefficient
 * for the segment sum to agree with the total.
 */
export function segmentCosts(
    samples: readonly ProcessSample[],
    marks: { first: number; last: number },
    options: CostOptions = {},
): SegmentCosts {
    const inRange = (from: number, to: number) =>
        samples.filter((sample) => sample.elapsedMs > from && sample.elapsedMs <= to);
    const startupSamples = inRange(Number.NEGATIVE_INFINITY, marks.first);
    const spanSamples = inRange(marks.first, marks.last);
    const tailSamples = inRange(marks.last, Number.POSITIVE_INFINITY);
    const sampleAt = (list: readonly ProcessSample[], fallback: number) =>
        list.length > 0 ? (list[list.length - 1] as ProcessSample).elapsedMs : fallback;

    // Start the first dt of each segment at the previous segment's final sample, rather than at zero.
    const startupEnd = sampleAt(startupSamples, 0);
    const spanEnd = sampleAt(spanSamples, startupEnd);
    // Do not estimate the final unsampled interval per segment; it belongs to the full window and would be counted twice.
    const base = { ...options, tailMs: 0 };
    return {
        startup: resourceCost(startupSamples, { ...base, originMs: options.originMs ?? 0 }),
        span: resourceCost(spanSamples, { ...base, originMs: startupEnd }),
        tail: resourceCost(tailSamples, { ...base, originMs: spanEnd }),
    };
}

/** A record to score requires only an id and CU. */
export interface ScoredInput {
    id: string;
    cu: number;
}

/** Formula for one row, shared by generated payloads and logs to avoid separate definitions. */
export interface ScoreFormulaCalibration {
    /** Conversion coefficient for this batch or run; **multiply** core·s by this value. */
    cpuScale: number;
    baselineMips: number;
    /** Raw calibration value: the mean of single-thread R/U. */
    cpuScaleValue: number;
    toolVersion: string;
    measuredAt: string;
    /** Whether calibration came from this local run; false means a later preview recalculated from external JSON. */
    appliedFromRunMeta?: boolean;
}

export interface ScoreFormula {
    /** Source of the formula structure. */
    source: string;
    expression: string;
    /** Explanation lines ready for display on pages or in logs. */
    lines: string[];
    coefficients: typeof CU_COEFFICIENTS;
    scope: string;
    score: string;
    deviations: string[];
    /** Calibration details, or null if no calibration was applied. */
    calibration: {
        cpuScale: number;
        baselineMips: number;
        cpuScaleValue: number;
        toolVersion: string;
        measuredAt: string;
        expression: string;
        note: string;
    } | null;
    peaks: { label: string; note: string };
}

/**
 * Formula block: **one definition of the measurement method** for logs, chart payloads,
 * and page text. Do not duplicate it; separate formulas can produce separate methods.
 */
export function scoreFormula(calibration: ScoreFormulaCalibration | null = null): ScoreFormula {
    const scale = calibration === null ? 1 : calibration.cpuScale;
    if (calibration !== null && (!Number.isFinite(scale) || scale <= 0)) {
        throw new Error(`cpuScale 必须是有限正数，收到 ${JSON.stringify(calibration.cpuScale)}`);
    }
    const expression =
        scale === 1
            ? "CU = 1.0 × core·s + 1.0 × GB·s"
            : `CU = 1.0 × core·s × cpuScale + 1.0 × GB·s     (cpuScale = ${formatCpuScale(scale)}, ` +
              "项目标准 CPU 单位)";
    const calibrationLines =
        calibration === null
            ? []
            : [
                  `core·s_std = core·s × ${formatCpuScale(scale)}   (cpuScale = ` +
                      `${calibration.cpuScaleValue} / ${calibration.baselineMips}; 7-Zip ` +
                      `${calibration.toolVersion}, ${calibration.measuredAt})`,
                  "the CPU term is rescaled into this project's standard CPU units (a project-defined " +
                      "unit, no real reference machine was measured); the memory term stays raw GB·s, " +
                      "so the two terms are in different units and the ranking can change",
              ];
    const calibrationBlock =
        calibration === null
            ? null
            : {
                  cpuScale: calibration.cpuScale,
                  baselineMips: calibration.baselineMips,
                  cpuScaleValue: calibration.cpuScaleValue,
                  toolVersion: calibration.toolVersion,
                  measuredAt: calibration.measuredAt,
                  expression: `core·s_std = core·s × ${formatCpuScale(scale)} = core·s × (${calibration.cpuScaleValue} / ${calibration.baselineMips})`,
                  note:
                      "the host's own speed is measured with the 7-Zip built-in benchmark " +
                      "(fixed version and arguments) and one local CPU-second is expressed in " +
                      "**this project's standard CPU units** — a unit this project defines, not a " +
                      "measured real reference machine; the memory term is not rescaled and stays " +
                      "the locally measured GB·s",
              };
    return {
        source:
            "formula structure borrowed from Alibaba Cloud FC's \"resource usage × conversion " +
            "coefficient\"; the coefficients are this project's own CPU-to-memory 1:1",
        expression,
        lines: [
            expression,
            "core·s = ∫ tree CPU% / 100 dt     GB·s = ∫ RSS / 2^20 dt     (over the whole run)",
            ...calibrationLines,
            calibration === null
                ? "100 × smallest CU in the batch / this run's CU (best = 100)"
                : "100 × smallest CU in the batch / this run's CU (best = 100)  — 注意：只有 CPU 项被折算、" +
                  "内存项不变，**名次与未折算时可能不同**（不是等比例缩放，别读成「只是换了个单位」）",
            "scope: process tree (the harness plus everything it spawns)",
        ],
        coefficients: { ...CU_COEFFICIENTS },
        scope: "process tree (the harness plus everything it spawns)",
        score: "100 × smallest CU in the batch / this run's CU (best = 100)",
        deviations: [
            "memory is measured RSS, not FC's \"declared size × duration\"",
            "no disk term (no data) and no GPU term (no GPU sampling)",
            "the coefficients are not FC's 0.15: to FC one core ≈ 6.67 GB (a memory term worth " +
                "1%~8% of the bill), while this project reads the bill as resource burden — " +
                "a core-second and a GB-second cost the same",
            "call count is not converted (how many requests a script takes is the harness's " +
                "strategy, not its overhead)",
            ...(calibration === null
                ? []
                : [
                      "the CPU term is rescaled with the host's measured 7-Zip benchmark rating " +
                          "(per-host factor, applied as a multiplication on core·s) into this " +
                          "project's standard CPU units; the memory term is not rescaled — a GB·s of " +
                          "RSS stays a locally measured GB·s, so raw and rescaled rankings can differ",
                  ]),
        ],
        calibration: calibrationBlock,
        peaks: {
            label: "Peaks (stress view)",
            note:
                "the maximum over the whole window (process-tree RSS / CPU), not converted into a " +
                "score — a peak is an absolute quantity and compares directly; it answers \"how much " +
                "is held at the worst moment\", complementing CU's \"how much is burned in total\"",
        },
    };
}

/**
 * Relative score: `100 × smallest CU in this batch / this run's CU`.
 * The best score is 100; higher cost gives a lower score.
 *
 * Compare scores **only within the same batch**: coefficients are absolute, but machine
 * state, background load, and scripts depend on the batch. Give records with cu ≤ 0 a score
 * of 0; missing samples must not produce a perfect score.
 */
export function relativeScores(entries: readonly ScoredInput[]): Map<string, number> {
    const scores = new Map<string, number>();
    const positive = entries.filter((entry) => entry.cu > 0);
    if (positive.length === 0) {
        for (const entry of entries) scores.set(entry.id, 0);
        return scores;
    }
    const best = Math.min(...positive.map((entry) => entry.cu));
    for (const entry of entries) {
        scores.set(entry.id, entry.cu > 0 ? (100 * best) / entry.cu : 0);
    }
    return scores;
}
