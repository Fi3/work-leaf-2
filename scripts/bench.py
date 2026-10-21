#!/usr/bin/env python3
"""Build an exact source snapshot and measure it in a fixed Docker container."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time


def evidence_module():
    path = Path(__file__).with_name('bench-evidence.py')
    spec = importlib.util.spec_from_file_location('bench_evidence', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def docker(*arguments):
    return subprocess.check_output(['docker', *map(str, arguments)], text=True).strip()


def inspect_container(identifier):
    return json.loads(docker('inspect', identifier))[0]


def limits(configuration):
    return {'cpus': configuration['NanoCpus'] / 1_000_000_000,
            'memory_bytes': configuration['Memory'], 'memory_swap_bytes': configuration['MemorySwap'],
            'pids_limit': configuration['PidsLimit']}


def collect(output, path, records):
    with path.open('w') as saved:
        for line in output:
            saved.write(line)
            saved.flush()
            try:
                record = json.loads(line)
            except ValueError:
                continue
            records.append(record)
            if record.get('type') == 'phase':
                print(f"Benchmark phase: {record['name']}", flush=True)
            elif record.get('type') == 'capacity' and record['completed_sessions'] % 16 == 0:
                print(f"Capacity: {record['completed_sessions']} completed sessions", flush=True)


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


def recover_result(records, state, profile):
    phase = next((item['name'] for item in reversed(records) if item.get('type') == 'phase'), None)
    samples = [item for item in records if item.get('type') == 'sample']
    stages = [item for item in records if item.get('type') == 'stage_result']
    expected = [f'load-{count}' for count in profile['concurrent_sessions']] + ['hidden-editor']
    complete_stages = [item.get('phase') for item in stages] == expected and all(
        type(item.get('completed_tasks')) is int and item['completed_tasks'] > 0 for item in stages)
    oom_delta = capacity_event_delta(samples, 'oom')
    kill_delta = capacity_event_delta(samples, 'oom_kill')
    complete = state.get('OOMKilled') is True and phase == 'capacity' and complete_stages and oom_delta > 0 and kill_delta > 0
    capacity = next((item['completed_sessions'] for item in reversed(records) if item.get('type') == 'capacity'), 0)
    return {'completed': complete, 'error': None if complete else 'Workload ended without complete capacity exhaustion evidence',
            'measurements': samples, 'stages': stages, 'capacity_completed_sessions': capacity,
            'exhaustion': {'observed': complete, 'reason': 'memory_limit', 'phase': phase,
                           'oom_delta': oom_delta, 'oom_kill_delta': kill_delta}}


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


def run_container(image, profile, directory, source):
    resources = profile['resources']
    identifier = docker('create', '--init', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--platform', profile['platform'],
        '--cpus', resources['cpus'], '--memory', resources['memory_bytes'],
        '--memory-swap', resources['memory_swap_bytes'], '--pids-limit', resources['pids_limit'], image)
    records = []
    timed_out = False
    try:
        configuration = inspect_container(identifier)
        actual_limits = limits(configuration['HostConfig'])
        if actual_limits != resources or configuration['HostConfig']['NetworkMode'] != 'none':
            raise RuntimeError('Docker did not apply the required resource and network limits')
        with (directory / f'{source}.stderr.log').open('w') as errors:
            process = subprocess.Popen(['docker', 'start', '--attach', identifier], stdout=subprocess.PIPE,
                                       stderr=errors, text=True)
            reader = threading.Thread(target=collect, args=(process.stdout, directory / f'{source}.jsonl', records))
            reader.start()
            try:
                process.wait(timeout=profile['timeout_seconds'])
            except subprocess.TimeoutExpired:
                timed_out = True
                docker('kill', identifier)
                process.wait(timeout=15)
            finally:
                reader.join(timeout=15)
                process.stdout.close()
        final = inspect_container(identifier)
        result = next((item for item in reversed(records) if item.get('type') == 'result'), None)
        if result is None:
            # A killed driver needs both Docker and sampled cgroup evidence.
            result = recover_result(records, final['State'], profile)
        elif final['State'].get('ExitCode') != 0:
            result.update(completed=False, error=f"Workload reported a result but Docker exited with status {final['State'].get('ExitCode')}")
        if timed_out:
            result.update(completed=False, error='Benchmark timed out; exhaustion was not established')
        result.pop('type', None)
        result.update(docker_image_id=configuration['Image'], docker_limits=actual_limits,
                      docker_state=final['State'], resources_by_phase=resource_summary(result.get('measurements', [])))
        return result
    finally:
        docker('rm', '--force', identifier)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true', help='Also save accepted evidence in benchmarks/results for review')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('The capacity-v1 baseline requires a native Linux x86_64 host')
    evidence = evidence_module()
    root = evidence.project_root()
    revision = evidence.git(root, 'rev-parse', 'HEAD').decode().strip()
    directory = root / '.bench-results'
    directory.mkdir(exist_ok=True)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='harness-bench-source-') as temporary:
        snapshot = Path(temporary) / 'source'
        source = evidence.snapshot(root, snapshot)
        profile_bytes = (snapshot / evidence.PROFILE_PATH).read_bytes()
        profile = json.loads(profile_bytes)
        profile_hash = hashlib.sha256(profile_bytes).hexdigest()
        image = f'harness-benchmark:{source[:16]}'
        print(f'Build benchmark image for source {source}.', flush=True)
        build_log = directory / f'{source}.build.log'
        with build_log.open('w') as log:
            status = subprocess.run(['docker', 'build', '--platform', profile['platform'], '--tag', image,
                '--file', str(snapshot / 'benchmarks/Dockerfile'), str(snapshot)], stdout=log, stderr=subprocess.STDOUT)
        if status.returncode:
            raise RuntimeError(f'Docker build failed. Read {build_log}')
        print('Run with two CPUs, 512 MiB RAM, no swap, and no network.', flush=True)
        result = run_container(image, profile, directory, source)
    result.update(schema=1, source_fingerprint=source, profile_sha256=profile_hash, profile=profile,
                  source_revision=revision,
                  started_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(started)),
                  elapsed_seconds=round(time.time() - started, 3),
                  host={'kernel': platform.release(), 'machine': platform.machine(), 'logical_cpus': os.cpu_count()})
    try:
        evidence.validate_result(result, source, profile_hash, profile)
    except ValueError as error:
        failed = directory / f'{source}.failed.json'
        failed.write_text(json.dumps(result, indent=2) + '\n')
        raise RuntimeError(f'No baseline recorded: {error}. Read {failed}') from error
    serialized = json.dumps(result, indent=2) + '\n'
    target = directory / f'{source}.json'
    target.write_text(serialized)
    if args.publish:
        published = root / 'benchmarks/results' / target.name
        published.parent.mkdir(parents=True, exist_ok=True)
        published.write_text(serialized)
    print(f'Accepted benchmark evidence: {target}', flush=True)
    print(json.dumps({'capacity_completed_sessions': result.get('capacity_completed_sessions'),
                      'exhaustion': result['exhaustion'], 'stages': result['stages'],
                      'resources_by_phase': result['resources_by_phase']}, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        print(f'Benchmark failed: {error}', file=sys.stderr)
        sys.exit(1)
