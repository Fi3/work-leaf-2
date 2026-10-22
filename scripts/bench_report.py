#!/usr/bin/env python3
"""Render saved benchmark measurements without running a benchmark."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys


BASELINE_PATH = 'benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json'
BASELINE_SHA256 = '744a8b0b470b30dd4d7aad82661197244cd3c13572d28f99763a58575114db1e'
MAX_REGRESSION_PERCENT = 20
MIB = 1024 * 1024


def load_baseline(root):
    data = (Path(root) / BASELINE_PATH).read_bytes()
    if hashlib.sha256(data).hexdigest() != BASELINE_SHA256:
        raise ValueError('The first reference baseline has changed')
    return json.loads(data)


def capacity_event_delta(samples, event):
    counts = []
    for sample in samples:
        events = sample.get('memory_events')
        count = events.get(event) if isinstance(events, dict) else None
        if type(count) is not int or count < 0:
            return 0
        counts.append(count)
    if len(counts) < 2 or any(after < before for before, after in zip(counts, counts[1:])):
        return 0
    if any(count != counts[0] and sample.get('phase') != 'capacity'
           for sample, count in zip(samples, counts)):
        return 0
    return counts[-1] - counts[0] if samples[-1].get('phase') == 'capacity' else 0



def resource_summary(records):
    phases = {}
    for sample in records:
        phases.setdefault(sample['phase'], []).append(sample)
    summary = {}
    for phase, samples in phases.items():
        if len(samples) < 2:
            continue
        first, last = samples[0], samples[-1]
        seconds = last['elapsed_seconds'] - first['elapsed_seconds']
        if seconds <= 0:
            continue
        summary[phase] = {
            'sampled_seconds': round(seconds, 3),
            'mean_cpu_cores': round((last['cpu_usec'] - first['cpu_usec']) / 1_000_000 / seconds, 6),
            'cpu_throttled_seconds': round((last.get('cpu_throttled_usec', 0) - first.get('cpu_throttled_usec', 0)) / 1_000_000, 6),
            'peak_sampled_memory_bytes': max(sample['memory_bytes'] for sample in samples),
        }
    return summary


def number(value, label, positive=False):
    try:
        valid = type(value) in (int, float) and math.isfinite(value) and value >= 0 and (not positive or value > 0)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f'{label} must be a finite {"positive" if positive else "nonnegative"} number')
    return value


def positive_integer(value, label):
    number(value, label, positive=True)
    if type(value) is not int:
        raise ValueError(f'{label} must be an integer')
    return value


def measurements(result, baseline):
    if type(result.get('schema')) is not int or result['schema'] != 1:
        raise ValueError('Unsupported benchmark evidence schema')
    for field, pattern in [('source_fingerprint', r'[0-9a-f]{64}'), ('docker_image_id', r'sha256:[0-9a-f]{64}')]:
        value = result.get(field)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError(f'Invalid benchmark identity: {field}')
    if result.get('profile') != baseline['profile'] or result.get('profile_sha256') != baseline['profile_sha256']:
        raise ValueError('The result does not use the first baseline profile')
    if result.get('docker_limits') != baseline['profile']['resources']:
        raise ValueError('The result does not use the first baseline resource limits')
    exhaustion = result.get('exhaustion', {})
    if (result.get('completed') is not True or exhaustion.get('observed') is not True
            or exhaustion.get('reason') != 'memory_limit' or exhaustion.get('phase') != 'capacity'):
        raise ValueError('A complete run with verified capacity memory exhaustion is required')
    for event in ('oom_delta', 'oom_kill_delta'):
        positive_integer(exhaustion.get(event), event)
    active = [f'load-{count}' for count in baseline['profile']['concurrent_sessions']] + ['hidden-editor']
    stages = result.get('stages', [])
    if not isinstance(stages, list) or [stage.get('phase') for stage in stages] != active:
        raise ValueError('Load stages are missing, duplicated, or out of order')
    tasks = {}
    for stage in stages:
        phase = stage['phase']
        tasks[phase] = positive_integer(stage.get('completed_tasks'), f'{phase} completed tasks')
        quantiles = [number(stage.get(key), f'{phase} {key}', positive=True) for key in ('p50_ms', 'p95_ms', 'p99_ms')]
        if quantiles != sorted(quantiles):
            raise ValueError(f'{phase} task duration percentiles are not in order')
    groups = sample_groups(result.get('measurements', []))
    if len(groups.get('capacity', [])) < 2:
        raise ValueError('Raw capacity samples are missing')
    for event in ('oom', 'oom_kill'):
        if capacity_event_delta(result['measurements'], event) != exhaustion[event + '_delta']:
            raise ValueError(f'Raw capacity {event} counters do not prove the reported exhaustion')
    metrics = {}
    for phase in ['idle', *active]:
        samples = groups.get(phase, [])
        if len(samples) < 2 or samples[-1]['elapsed_seconds'] <= samples[0]['elapsed_seconds']:
            raise ValueError(f'{phase} needs at least two samples with a positive time span')
        metrics[(phase, 'peak memory MiB')] = max(item['memory_bytes'] for item in samples) / MIB
        if phase in tasks:
            cpu_ms = number((samples[-1]['cpu_usec'] - samples[0]['cpu_usec']) / 1000,
                            f'{phase} CPU time', positive=True)
            metrics[(phase, 'estimated CPU ms/task')] = cpu_ms / tasks[phase]
    for stage in stages:
        metrics[(stage['phase'], 'task p95 ms')] = stage['p95_ms']
        metrics[(stage['phase'], 'completed tasks')] = stage['completed_tasks']
    metrics[('capacity', 'retained sessions')] = positive_integer(result.get('capacity_completed_sessions'), 'Retained sessions')
    return metrics


def sample_groups(samples):
    if not isinstance(samples, list) or not samples:
        raise ValueError('Raw resource samples are missing')
    groups = {}
    previous_time, previous_cpu, previous_throttle = -1, -1, -1
    finished = set()
    previous_phase = None
    for sample in samples:
        phase = sample.get('phase')
        if not isinstance(phase, str) or not phase:
            raise ValueError('A sample phase is missing')
        elapsed = number(sample.get('elapsed_seconds'), 'Sample time')
        cpu = number(sample.get('cpu_usec'), 'Sample CPU')
        throttle = number(sample.get('cpu_throttled_usec', 0), 'Sample CPU throttling')
        number(sample.get('memory_bytes'), 'Sample memory')
        if elapsed < previous_time or cpu < previous_cpu or throttle < previous_throttle:
            raise ValueError('Sample time and CPU counters must not decrease')
        if previous_phase != phase:
            if phase in finished:
                raise ValueError('Sample phases must be contiguous')
            finished.add(previous_phase)
        groups.setdefault(phase, []).append(sample)
        previous_time, previous_cpu, previous_phase = elapsed, cpu, phase
        previous_throttle = throttle
    return groups


def evaluate(result, baseline):
    try:
        reference = measurements(baseline, baseline)
        current = measurements(result, baseline)
        checks = []
        for (phase, metric), before in reference.items():
            after = current[(phase, metric)]
            lower = metric in ('completed tasks', 'retained sessions')
            limit = before * (1 - MAX_REGRESSION_PERCENT / 100 if lower else 1 + MAX_REGRESSION_PERCENT / 100)
            passed = (after >= limit if lower else after <= limit) or math.isclose(after, limit, rel_tol=1e-12)
            checks.append({'phase': phase, 'metric': metric, 'baseline': before, 'current': after,
                           'change_percent': (after / before - 1) * 100 if before else None,
                           'limit': limit, 'direction': '>=' if lower else '<=', 'status': 'PASS' if passed else 'FAIL'})
        return {'status': 'PASS' if all(check['status'] == 'PASS' for check in checks) else 'FAIL',
                'max_regression_percent': MAX_REGRESSION_PERCENT, 'checks': checks, 'reasons': []}
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        return {'status': 'UNAVAILABLE', 'max_regression_percent': MAX_REGRESSION_PERCENT,
                'checks': [], 'reasons': [str(error)]}


def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')


def table(headers, rows):
    return '\n'.join('| ' + ' | '.join(map(cell, row)) + ' |' for row in [headers, ['---'] * len(headers), *rows])


def formatted(value):
    return 'not reported' if value is None else f'{value:,.2f}'


def check_table(checks):
    return table(['Phase', 'Measure', 'Baseline', 'Run', 'Change', 'Allowed', 'Result'], [
        [item['phase'], item['metric'], formatted(item['baseline']), formatted(item['current']),
         'n/a' if item['change_percent'] is None else f"{item['change_percent']:+.1f}%",
         f"{item['direction']} {formatted(item['limit'])}", item['status']] for item in checks])


def render_failures(evaluation):
    if evaluation['status'] == 'UNAVAILABLE':
        return '\n'.join(evaluation['reasons'])
    return check_table([item for item in evaluation['checks'] if item['status'] == 'FAIL'])


def resource_table(result):
    summary = resource_summary(result['measurements'])
    stages = {stage['phase']: stage for stage in result['stages']}
    resources = result['profile']['resources']
    cpu_limit, memory_limit = resources['cpus'], resources['memory_bytes'] / MIB
    rows = []
    for phase in ['idle', *stages]:
        item = summary[phase]
        cpu, memory = item['mean_cpu_cores'], item['peak_sampled_memory_bytes'] / MIB
        active = phase.removeprefix('load-') if phase.startswith('load-') else ('1' if phase == 'hidden-editor' else '0')
        tasks = stages[phase]['completed_tasks'] if phase in stages else None
        rows.append([phase, active, f'{cpu:.3f} / {cpu_limit:g}', f'{100 * cpu / cpu_limit:.1f}%',
                     f'{memory:.2f} / {memory_limit:g}', f'{100 * memory / memory_limit:.1f}%',
                     f'{max(0, memory_limit - memory):.2f}', tasks if tasks is not None else '—',
                     f"{tasks / result['profile']['load_seconds']:.1f}" if tasks is not None else '—'])
    return table(['Phase', 'Active chats', 'Mean CPU cores / limit', 'CPU used', 'Peak MiB / limit', 'RAM used',
                  'RAM left MiB', 'Tasks', 'Tasks / configured second'], rows)


def published_tables(published):
    parts = ['Published harness figures — not reproduced', published['warning']]
    for source in published['sources']:
        rows = [item for item in published['measurements'] if item['source_id'] == source['id']]
        parts.extend([f"Source: {source['url']} (revision date {source['published_at']}).", source['method']])
        if rows[0]['group'] == 'scripted_single_session':
            parts.append(table(['Harness', 'Version', 'Batch', 'Mean RSS MiB', 'Peak RSS MiB', 'Mean CPU % of one core', 'Peak CPU %'], [
                [item['harness'], item['version'] or 'not reported', item['batch'], formatted(item['memory']['mean']),
                 formatted(item['memory']['peak']), formatted(item['cpu']['mean']),
                 'artifact' if item['harness'] == 'ccode' else formatted(item['cpu']['peak'])] for item in rows]))
        else:
            parts.append(table(['Harness', 'First session PSS MiB', 'Approx. additional session PSS MiB'], [
                [item['harness'], formatted(item['memory']['first_session']), formatted(item['memory']['additional_session'])] for item in rows]))
        parts.extend(source['limitations'])
        for item in rows:
            notes = '; '.join(item['limitations'])
            parts.append(f"{item['harness']}: {item['workload']} Batch: {item['batch'] or 'not reported'}; {item['os']}; "
                         f"run date: {item.get('measured_at') or 'not reported'}. {notes}")
    parts.extend(published['limitations'])
    parts.append(published['omitted'])
    return '\n\n'.join(parts)


def render(result, baseline, published):
    evaluation = evaluate(result, baseline)
    identity = result if isinstance(result, dict) else {}
    parts = [f"Benchmark resource report: {evaluation['status']}",
             f"Source: {identity.get('source_fingerprint', 'unknown')}; run: {identity.get('started_at', 'unknown')}; "
             f"CPU affinity: {identity.get('cpu_affinity') or 'not recorded'}.",
             f"Reference: {BASELINE_PATH}. Maximum allowed regression: {MAX_REGRESSION_PERCENT}%."]
    if evaluation['status'] == 'UNAVAILABLE':
        parts.extend(evaluation['reasons'])
    else:
        parts.extend([resource_table(result),
            f"Capacity: {result['capacity_completed_sessions']} retained sessions completed before verified memory exhaustion; "
            f"at most {max(result['profile']['concurrent_sessions'])} active chats at once. This is not a concurrent-session capacity.",
            'CPU and RAM values cover the whole container: Rust server, shared Node/Pi worker, driver, tools, editor, '
            'charged shared pages and file cache. RAM left is observed headroom, not a promise of more sessions. '
            'No session count is extrapolated from CPU or RAM.',
            check_table(evaluation['checks']),
            'CPU per task is an estimate: CPU counters cover the interval between samples, while task counts cover the full stage. '
            'Task durations include simulated model delays, tools, storage and editor work; they are not pure harness overhead. '
            'Tasks per second use the configured stage duration because the old profile has no exact stage timer.',
            'PASS means this run is within the 20% budget. FAIL means at least one limit was exceeded. '
            'One run does not establish a regression or an improvement: repeat the same profile and compare medians and variation. '
            'Idle CPU and the forced memory-exhaustion peak have no percentage gate.'])
    parts.append(published_tables(published))
    return '\n\n'.join(parts) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result', type=Path, help='Existing benchmark JSON; no Docker or benchmark is started')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    result = json.loads(args.result.read_text())
    baseline = load_baseline(root)
    published = json.loads((root / 'benchmarks/published-harnesses.json').read_text())
    print(render(result, baseline, published), end='')
    return {'PASS': 0, 'FAIL': 1, 'UNAVAILABLE': 2}[evaluate(result, baseline)['status']]


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f'Report unavailable: {error}', file=sys.stderr)
        sys.exit(2)
