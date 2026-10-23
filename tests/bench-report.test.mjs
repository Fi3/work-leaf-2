import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = 'benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json';
const python = code => execute('python3', ['-c', `
import copy, json, pathlib, sys
sys.path.insert(0, 'scripts')
import bench_report as report
baseline = report.load_baseline(pathlib.Path('.'))
${code}`], { cwd: root, timeout: 5000 });

test('resource budget compares saved raw observations to the immutable first baseline', async () => {
  await python(`
assert report.evaluate(baseline, baseline)['status'] == 'PASS'
assert report.evaluate(baseline, baseline)['policy'] == 'process-pss-v2'
result = copy.deepcopy(baseline)
result['comparison'] = {'status': 'PASS'}
result['resources_by_phase'] = baseline['resources_by_phase']
for sample in result['measurements']:
    if sample['phase'] == 'load-4':
        for process in sample['processes']:
            process['pss_bytes'] *= 1.21
            process['rss_bytes'] *= 1.21
evaluation = report.evaluate(result, baseline)
assert evaluation['status'] == 'FAIL'
failed = [item for item in evaluation['checks'] if item['status'] == 'FAIL']
assert [(item['phase'], item['metric']) for item in failed] == [('load-4', 'peak total process PSS MiB')]
assert 'load-4' in report.render_failures(evaluation)
import tempfile
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / report.BASELINE_PATH
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(baseline))
    try:
        report.load_baseline(pathlib.Path(directory))
    except ValueError:
        pass
    else:
        raise AssertionError('Changed reference file was accepted')
`);
});

test('memory, CPU and task duration pass at twenty percent and fail beyond it', async () => {
  await python(`
for metric in ['peak total process PSS MiB', 'estimated CPU ms/task', 'task p95 ms']:
    for factor, expected in [(1.2, 'PASS'), (1.2001, 'FAIL')]:
        result = copy.deepcopy(baseline)
        if metric == 'peak total process PSS MiB':
            for sample in result['measurements']:
                if sample['phase'] != 'capacity':
                    for process in sample['processes']:
                        process['pss_bytes'] *= factor
                        process['rss_bytes'] *= factor
        elif metric == 'estimated CPU ms/task':
            for sample in result['measurements']:
                sample['cpu_usec'] *= factor
        else:
            for stage in result['stages']:
                stage['p95_ms'] *= factor
                stage['p99_ms'] = max(stage['p99_ms'], stage['p95_ms'])
        evaluation = report.evaluate(result, baseline)
        assert evaluation['status'] == expected, (metric, evaluation)
        assert all(item['status'] == expected for item in evaluation['checks'] if item['metric'] == metric)
`);
});

test('process memory uses simultaneous totals and permits incomplete startup and exhaustion samples', async () => {
  await python(`
result = copy.deepcopy(baseline)
idle = [sample for sample in result['measurements'] if sample['phase'] == 'idle']
for index, sample in enumerate(idle):
    sample['processes'] = [
        {'pid': 1, 'role': 'driver_or_tool', 'rss_bytes': 40, 'pss_bytes': 40 if index % 2 else 10},
        {'pid': 2, 'role': 'worker', 'rss_bytes': 40, 'pss_bytes': 10 if index % 2 else 40},
        {'pid': 3, 'role': 'server', 'rss_bytes': 10, 'pss_bytes': 10},
        {'pid': 4, 'role': 'editor', 'rss_bytes': 10, 'pss_bytes': 10},
        {'pid': 5, 'role': 'driver_or_tool', 'rss_bytes': 10, 'pss_bytes': 10},
        {'pid': 6, 'role': 'server', 'rss_bytes': 10, 'pss_bytes': 10},
    ]
for sample in result['measurements']:
    if sample['phase'] in ('startup', 'capacity'):
        sample.pop('processes', None)
evaluation = report.evaluate(result, baseline)
assert evaluation['status'] == 'PASS', evaluation
check = next(item for item in evaluation['checks'] if item['phase'] == 'idle' and item['metric'] == 'peak total process PSS MiB')
assert check['current'] == 90 / 1048576, check
`);
});

test('missing or invalid normal-load process memory prevents a passing comparison', async () => {
  await python(`
mutations = [
    lambda s: s.pop('processes'),
    lambda s: s.update(processes=[]),
    lambda s: s.update(processes={}),
    lambda s: s['processes'].append(None),
    lambda s: s['processes'].append(s['processes'][0].copy()),
    lambda s: s['processes'][0].update(role='unknown'),
    lambda s: s['processes'][0].pop('pss_bytes'),
    lambda s: s['processes'][0].pop('rss_bytes'),
    lambda s: s['processes'][0].update(pss_bytes=s['processes'][0]['rss_bytes'] + 1),
]
for role in ['server', 'worker', 'editor', 'driver_or_tool']:
    mutations.append(lambda s, role=role: s.update(processes=[p for p in s['processes'] if p['role'] != role]))
for role in ['server', 'driver_or_tool']:
    mutations.append(lambda s, role=role: s.update(processes=[p for p in s['processes'] if p['role'] != role]
                     + [next(p for p in s['processes'] if p['role'] == role)]))
for value in [None, True, 0, -1, 1.5, '1']:
    mutations.append(lambda s, value=value: s['processes'][0].update(pid=value))
for field in ['pss_bytes', 'rss_bytes']:
    for value in [None, True, 0, -1, float('nan'), float('inf'), 10**400]:
        mutations.append(lambda s, field=field, value=value: s['processes'][0].update({field: value}))
for phase in ['idle', 'load-1', 'load-2', 'load-4', 'hidden-editor']:
    for mutate in mutations:
        result = copy.deepcopy(baseline)
        sample = next(sample for sample in reversed(result['measurements']) if sample['phase'] == phase)
        mutate(sample)
        evaluation = report.evaluate(result, baseline)
        assert evaluation['status'] == 'UNAVAILABLE', (phase, evaluation)
        assert evaluation['policy'] == 'process-pss-v2'
        assert evaluation['reasons']
`);
});

test('container memory increases remain visible when the process memory gate passes', async () => {
  await python(`
result = copy.deepcopy(baseline)
for sample in result['measurements']:
    if sample['phase'] not in ('startup', 'capacity'):
        sample['memory_bytes'] *= 2
evaluation = report.evaluate(result, baseline)
assert evaluation['status'] == 'PASS', evaluation
published = json.loads(pathlib.Path('benchmarks/published-harnesses.json').read_text())
text = report.render(result, baseline, published)
assert 'Memory policy: process-pss-v2' in text
assert 'Container RAM comparison (diagnostic, not the percentage gate)' in text
assert '| idle | 57.62 | 115.24 | +100.0% |' in text
assert '| idle | 57.62 | 115.24 | +100.0% | not reported | not reported | not reported |' in text
assert 'process-memory PASS does not mean container RAM decreased' in text
assert 'excludes unmapped file cache and kernel memory' in text
assert 'outside the container share mapped pages' in text
assert 'container memory limit and retained-capacity check remain in effect' in text
idle = [sample for sample in result['measurements'] if sample['phase'] == 'idle']
for sample in idle:
    sample['memory_stat'] = {'anon': 999 * 1048576, 'file': 888 * 1048576, 'kernel': 777 * 1048576}
idle[0]['memory_bytes'] = 300 * 1048576
idle[0]['memory_stat'] = {'anon': 150 * 1048576, 'file': 140 * 1048576, 'kernel': 10 * 1048576}
text = report.render(result, baseline, published)
assert '| idle | 57.62 | 300.00 |' in text
assert '| 150.00 | 140.00 | 10.00 |' in text
assert 'same sample as the run peak; they are not separate component peaks' in text
`);
});

test('work and retained capacity use lower limits and do not imply concurrent capacity', async () => {
  await python(`
for completed, expected in [(48, 'PASS'), (47, 'FAIL')]:
    result = copy.deepcopy(baseline)
    result['stages'][0]['completed_tasks'] = completed
    evaluation = report.evaluate(result, baseline)
    check = next(item for item in evaluation['checks'] if item['phase'] == 'load-1' and item['metric'] == 'completed tasks')
    assert check['status'] == expected
for retained, expected in [(285, 'PASS'), (284, 'FAIL')]:
    result = copy.deepcopy(baseline)
    result['capacity_completed_sessions'] = retained
    assert report.evaluate(result, baseline)['status'] == expected
result = copy.deepcopy(baseline)
for sample in result['measurements']:
    if sample['phase'] == 'capacity':
        sample['memory_bytes'] *= 2
assert report.evaluate(result, baseline)['status'] == 'PASS', 'Forced exhaustion peak has no regression gate'
`);
});

test('missing, malformed or incompatible observations cannot pass the resource budget', async () => {
  await python(`
mutations = [
    lambda r: r.update(completed=False),
    lambda r: r.update(schema=True),
    lambda r: r.pop('docker_image_id'),
    lambda r: r.update(source_fingerprint='wrong'),
    lambda r: r['exhaustion'].update(oom_kill_delta=0),
    lambda r: r['profile'].update(load_seconds=20),
    lambda r: r.update(profile_sha256='0' * 64),
    lambda r: r['docker_limits'].update(cpus=1),
    lambda r: r.update(stages=r['stages'][:-1]),
    lambda r: r['stages'].append(r['stages'][0]),
    lambda r: r['stages'][0].update(p95_ms=1),
    lambda r: r['stages'][0].update(completed_tasks=True),
    lambda r: r.update(capacity_completed_sessions=0),
    lambda r: r.update(measurements=[s for s in r['measurements'] if s['phase'] != 'load-4']),
    lambda r: r.update(measurements=[s for s in r['measurements'] if s['phase'] != 'capacity']),
    lambda r: r['measurements'][-1]['memory_events'].update(oom_kill=0),
    lambda r: r['measurements'][0]['memory_events'].update(oom=True),
    lambda r: r['exhaustion'].update(oom_delta=999),
    lambda r: r.update(measurements=list(reversed(r['measurements']))),
    lambda r: r['measurements'][1].update(cpu_usec=0),
    lambda r: [s.update(elapsed_seconds=1) for s in r['measurements']],
    lambda r: [s.update(cpu_usec=1) for s in r['measurements']],
]
for field in ['memory_bytes', 'cpu_usec', 'cpu_throttled_usec', 'elapsed_seconds']:
    for value in [None, True, -1, float('nan'), float('inf'), 10**400]:
        mutations.append(lambda r, field=field, value=value: r['measurements'][0].update({field: value}))
for value in [None, True, -1, float('nan'), float('inf')]:
    mutations.append(lambda r, value=value: r['stages'][0].update(p95_ms=value))
for mutate in mutations:
    result = copy.deepcopy(baseline)
    mutate(result)
    evaluation = report.evaluate(result, baseline)
    assert evaluation['status'] == 'UNAVAILABLE', evaluation
    assert evaluation['reasons']
`);
});

test('offline report displays resource tables and sourced harness figures without Docker', async () => {
  const { stdout } = await execute('/usr/bin/python3', ['scripts/bench_report.py', baselinePath],
    { cwd: root, timeout: 5000, env: { ...process.env, PATH: '/nonexistent' } });
  assert.match(stdout, /Benchmark resource report: PASS/);
  assert.match(stdout, /\| load-4 \| 4 \| 0\.788 \/ 2/);
  assert.match(stdout, /356 retained sessions.*at most 4 active chats/);
  assert.match(stdout, /RAM left MiB/);
  assert.match(stdout, /20%/);
  assert.match(stdout, /Memory policy: process-pss-v2/);
  assert.match(stdout, /peak total process PSS MiB/);
  assert.match(stdout, /Baseline container peak MiB/);
  assert.match(stdout, /Historical data recalculated under current policy; a new measurement is required for push evidence/);
  assert.match(stdout, /CPU per task is an estimate/);
  assert.match(stdout, /not pure harness overhead/);
  assert.match(stdout, /Published figures only; not reproduced/);
  assert.match(stdout, /\| peri \| 3\.17\.0 \| codex-proxy-fix \| 54\.70 \| 71\.70/);
  assert.match(stdout, /\| jcode \| 71\.30 \| 3\.30 \|/);
  assert.match(stdout, /https:\/\/github.com\/KonghaYao\/harness-perf-benchmark\/blob\//);
  assert.match(stdout, /\| ccode .* artifact \|/);
  assert.match(stdout, /cannot give a fair ranking/);
  const published = JSON.parse(await readFile(join(root, 'benchmarks/published-harnesses.json')));
  for (const row of published.measurements) assert.ok(stdout.includes(`| ${row.harness} |`));
});

test('offline report returns failure and unavailable status for saved bad results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-report-'));
  try {
    const result = JSON.parse(await readFile(join(root, baselinePath)));
    const path = join(directory, 'result.json');
    result.capacity_completed_sessions = 284;
    await writeFile(path, JSON.stringify(result));
    await assert.rejects(execute('python3', ['scripts/bench_report.py', path], { cwd: root, timeout: 5000 }),
      error => error.code === 1 && /Benchmark resource report: FAIL/.test(error.stdout));
    result.stages.pop();
    for (const invalid of [result, [], null]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(execute('python3', ['scripts/bench_report.py', path], { cwd: root, timeout: 5000 }),
        error => error.code === 2 && /Benchmark resource report: UNAVAILABLE/.test(error.stdout));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
