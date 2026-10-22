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
result = copy.deepcopy(baseline)
result['comparison'] = {'status': 'PASS'}
result['resources_by_phase'] = baseline['resources_by_phase']
for sample in result['measurements']:
    if sample['phase'] == 'load-4':
        sample['memory_bytes'] *= 1.21
evaluation = report.evaluate(result, baseline)
assert evaluation['status'] == 'FAIL'
failed = [item for item in evaluation['checks'] if item['status'] == 'FAIL']
assert [(item['phase'], item['metric']) for item in failed] == [('load-4', 'peak memory MiB')]
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
for metric in ['peak memory MiB', 'estimated CPU ms/task', 'task p95 ms']:
    for factor, expected in [(1.2, 'PASS'), (1.2001, 'FAIL')]:
        result = copy.deepcopy(baseline)
        if metric == 'peak memory MiB':
            for sample in result['measurements']:
                if sample['phase'] != 'capacity':
                    sample['memory_bytes'] *= factor
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
