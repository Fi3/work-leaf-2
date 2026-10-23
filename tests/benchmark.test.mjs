import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = JSON.parse(await readFile(new URL('../benchmarks/profile.json', import.meta.url)));
const runProvider = program => execute(process.execPath,
  ['--import', './benchmarks/provider.mjs', '--input-type=module', '--eval', program],
  { cwd: root, timeout: 15000, env: { ...process.env, OPENAI_API_KEY: 'sk-benchmark-synthetic' } });

const runWorkload = program => execute('python3', ['-c', `
import contextlib, importlib.util, io, json, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path('tests/fixtures').resolve()))
spec = importlib.util.spec_from_file_location('workload', 'benchmarks/workload.py')
workload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workload)
${program}
`], { cwd: root, timeout: 10000 });

test('benchmark provider rejects other endpoints, credentials, models, and response modes', async () => {
  await runProvider(`
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    const profile = JSON.parse(await readFile('./benchmarks/profile.json'));
    const endpoint = 'https://api.openai.com/v1/responses';
    const headers = { authorization: 'Bearer sk-benchmark-synthetic' };
    const body = { model: profile.model, stream: true, input: [], tools: [] };
    for (const [url, requestHeaders, requestBody] of [
      ['https://example.invalid/', headers, body],
      [endpoint, { authorization: 'Bearer wrong-key' }, body],
      [endpoint, {}, body],
      [endpoint, headers, { ...body, model: 'unexpected-model' }],
      [endpoint, headers, { ...body, stream: false }],
    ]) {
      await assert.rejects(fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(requestBody) }),
        /Benchmark permits only|Unexpected benchmark model request/);
    }
  `);
});

test('benchmark simulator completes successive real Pi tool runs with fixed-size stored answers', async () => {
  const { stdout } = await runProvider(`
    import assert from 'node:assert/strict';
    import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { openApplication } from './adapter/pi.mjs';
    const profile = JSON.parse(await readFile('./benchmarks/profile.json'));
    const directory = await mkdtemp(join(tmpdir(), 'harness-benchmark-test-'));
    const workspace = join(directory, 'work'), state = join(directory, 'state');
    await mkdir(workspace); await mkdir(state);
    const requests = [], provider = globalThis.fetch;
    globalThis.fetch = (url, options) => { requests.push(JSON.parse(options.body)); return provider(url, options); };
    let app;
    try {
      app = await openApplication({ state_dir: state, provider: profile.provider, model: profile.model });
      let sequence = 0;
      const call = (method, params) => app.dispatch(method, params, 'test-' + ++sequence);
      await call('session.create', { session_id: 'chat', workspace });
      for (const request_id of ['first', 'next']) {
        await call('input.submit', { session_id: 'chat', request_id, text: 'Run the benchmark tool.', context: [] });
        const result = await call('submission.wait', { session_id: 'chat', request_id, timeout_ms: 5000 });
        assert.equal(result.status, 'done');
        const answer = await call('entry.read', { session_id: 'chat', entry_id: result.answer_entry_id });
        assert.equal(Buffer.byteLength(answer.text), profile.simulated_output_bytes);
        assert.ok(answer.text.startsWith('Synthetic benchmark answer. '));
        assert.equal(answer.end, true);
      }
      assert.equal(requests.length, 4, 'Each turn requests one tool and one answer');
      for (const index of [1, 3]) {
        assert.equal(requests[index].input.at(-1).type, 'function_call_output');
        assert.ok(JSON.stringify(requests[index].input.at(-1)).includes('benchmark tool output'));
      }
      const snapshot = (await call('session.get', { session_id: 'chat' })).snapshot;
      assert.equal(snapshot.state, 'idle'); assert.equal(snapshot.error, null);
      assert.equal(snapshot.entries.filter(entry => entry.kind === 'tool').length, 2);
      assert.ok(!JSON.stringify(snapshot).includes('sk-benchmark-synthetic'));
      console.log(JSON.stringify({ requests: requests.length, completed: 2 }));
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  `);
  assert.deepEqual(JSON.parse(stdout), { requests: 4, completed: 2 });
});

async function containerResult(settings) {
  const program = `
import contextlib, importlib.util, io, json, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('bench', 'scripts/bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
settings = json.loads(sys.argv[1])
profile = json.loads(pathlib.Path('benchmarks/profile.json').read_text())
profile.update(settings.get('profile', {}))
resources = profile['resources']
configuration = {'Image': 'sha256:' + 'a' * 64, 'HostConfig': {
    'NanoCpus': resources['cpus'] * 1000000000, 'Memory': resources['memory_bytes'],
    'MemorySwap': resources['memory_swap_bytes'], 'PidsLimit': resources['pids_limit'],
    'NetworkMode': 'none', 'OomScoreAdj': -1000}}
configuration['HostConfig'].update(settings.get('configuration', {}))
final = {'State': {'OOMKilled': settings.get('oom', False), 'ExitCode': settings.get('exit_code', 137 if settings.get('oom') else 0)}}
commands = []
def docker(*arguments):
    commands.append(arguments)
    return 'synthetic-container'
class Process:
    def __init__(self, *arguments, **options):
        self.stdout = io.StringIO(''.join(json.dumps(record) + '\\n' for record in settings['records']))
        self.calls = 0
    def wait(self, timeout):
        self.calls += 1
        if settings.get('timeout') and self.calls == 1:
            raise subprocess.TimeoutExpired('docker start', timeout)
        return 0
with tempfile.TemporaryDirectory(prefix='harness-benchmark-runner-') as directory:
    with patch.object(bench, 'docker', docker), patch.object(bench, 'inspect_container', side_effect=[configuration, final]), patch.object(bench.subprocess, 'Popen', Process), contextlib.redirect_stdout(io.StringIO()):
        try:
            result = bench.run_container('synthetic-image', profile, pathlib.Path(directory), 'source', settings.get('cpuset'))
        except RuntimeError as error:
            result = {'error': str(error)}
    assert commands[-1] == ('rm', '--force', 'synthetic-container')
    assert commands[0][commands[0].index('--oom-score-adj') + 1] == '-1000'
    assert any(command[0] == 'kill' for command in commands) == settings.get('timeout', False)
    if settings.get('cpuset') and not result.get('error'):
        assert '--cpuset-cpus' in commands[0] and settings['cpuset'] in commands[0]
    print(json.dumps(result))
`;
  const { stdout } = await execute('python3', ['-c', program, JSON.stringify(settings)], { cwd: root, timeout: 5000 });
  return JSON.parse(stdout);
}

const phases = [...profile.concurrent_sessions.map(count => `load-${count}`), 'hidden-editor'];
const stages = phases.map(phase => ({ type: 'stage_result', phase, completed_tasks: 1, p50_ms: 5, p95_ms: 8, p99_ms: 10 }));
const samples = [
  { type: 'sample', phase: 'idle', elapsed_seconds: 1, cpu_usec: 100, memory_bytes: 1024, memory_events: { oom: 5, oom_kill: 3 } },
  { type: 'sample', phase: 'capacity', elapsed_seconds: 2, cpu_usec: 200, memory_bytes: 2048, memory_events: { oom: 8, oom_kill: 5 } },
];

test('benchmark samples preserve separate cgroup and process memory counters without filling missing fields', async () => {
  await runWorkload(`
with tempfile.TemporaryDirectory(prefix='harness-benchmark-sampler-') as directory:
    root = pathlib.Path(directory)
    proc, cgroup = root / 'proc', root / 'cgroup'
    proc.mkdir()
    cgroup.mkdir()
    worker = proc / '42'
    worker.mkdir()
    (worker / 'cmdline').write_bytes(b'node\\0/app/adapter/worker.mjs\\0')
    memory = worker / 'smaps_rollup'
    memory.write_text('Rss: 40 kB\\nPss: 30 kB\\nPss_Anon: 20 kB\\nPss_File: 9 kB\\nPss_Shmem: 1 kB\\n')
    (worker / 'oom_score_adj').write_text('0')
    (proc / 'self').mkdir()
    for name, value in {
        'cpu.stat': 'usage_usec 120\\nthrottled_usec 7\\n',
        'memory.events': 'oom 0\\noom_kill 0\\n',
        'memory.current': '123456', 'memory.peak': '234567',
        'memory.stat': 'anon 4096\\nfile 8192\\nkernel 1024\\npgfault 45\\n',
    }.items():
        (cgroup / name).write_text(value)
    with patch.object(workload, 'CGROUP', cgroup), patch.object(workload, 'Path',
            side_effect=lambda value: proc if value == '/proc' else pathlib.Path(value)):
        monitor = workload.Monitor({'sample_interval_ms': 500})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            monitor.sample()
        sample = monitor.samples[0]
        assert json.loads(output.getvalue()) == {'type': 'sample', **sample}
        assert sample['cpu_usec'] == 120 and sample['cpu_throttled_usec'] == 7
        assert sample['memory_bytes'] == 123456 and sample['memory_peak_bytes'] == 234567
        assert sample['memory_stat'] == {'anon': 4096, 'file': 8192, 'kernel': 1024, 'pgfault': 45}
        assert sample['processes'] == [{'pid': 42, 'role': 'worker', 'rss_bytes': 40960,
            'pss_bytes': 30720, 'pss_anon_bytes': 20480, 'pss_file_bytes': 9216, 'pss_shmem_bytes': 1024, 'oom_score_adj': 0}]
        (worker / 'oom_score_adj').unlink()
        memory.write_text('Rss: 40 kB\\nPss: 30 kB\\n')
        assert workload.process_memory() == [{'pid': 42, 'role': 'worker', 'rss_bytes': 40960, 'pss_bytes': 30720}]
        for contents, missing, present, value in [
            ('Rss: 40 kB\\n', 'pss_bytes', 'rss_bytes', 40960),
            ('Pss: 30 kB\\n', 'rss_bytes', 'pss_bytes', 30720),
        ]:
            memory.write_text(contents)
            process = workload.process_memory()[0]
            assert missing not in process, 'Missing kernel observations must not become zero'
            assert process[present] == value
`);
});

test('the benchmark refuses to start with an unprotected driver', async () => {
  await runWorkload(`
profile = json.loads(pathlib.Path('benchmarks/profile.json').read_text())
with tempfile.TemporaryDirectory(prefix='harness-benchmark-protection-') as directory:
    root = pathlib.Path(directory)
    for name, value in {'cpu.max': '200000 100000', 'memory.max': '536870912',
                        'memory.swap.max': '0', 'pids.max': '256'}.items():
        (root / name).write_text(value)
    score = root / 'oom_score_adj'
    with patch.object(workload, 'CGROUP', root), patch.object(workload, 'Path',
            side_effect=lambda value: score if value == '/proc/self/oom_score_adj' else pathlib.Path(value)):
        for value in ['0', '-999', '1000', '']:
            score.write_text(value)
            try:
                workload.verify_limits(profile)
            except RuntimeError as error:
                assert 'driver is not protected' in str(error)
            else:
                raise AssertionError('An unprotected driver must not begin measurement')
        score.write_text('-1000\\n')
        assert workload.verify_limits(profile) == profile['resources']
`);
});

test('application launches reset OOM protection and preserve arguments, environment, and descendant eligibility', async () => {
  await runWorkload(`
import os
from types import SimpleNamespace
profile = json.loads(pathlib.Path('benchmarks/profile.json').read_text())
observed = []
real_popen = subprocess.Popen
probe = "import json,os,pathlib,subprocess,sys; print(json.dumps({'args':sys.argv[1:],'score':pathlib.Path('/proc/self/oom_score_adj').read_text().strip(),'child_score':subprocess.check_output([sys.executable,'-c',\\"import pathlib; print(pathlib.Path('/proc/self/oom_score_adj').read_text().strip())\\"],text=True).strip(),'key':os.getenv('OPENAI_API_KEY'),'node_options':os.getenv('NODE_OPTIONS')}))"
class Client:
    def close(self): pass
class Monitor:
    def __init__(self, profile):
        self.thread = SimpleNamespace(start=lambda: None, join=lambda **_: None)
        self.done = SimpleNamespace(set=lambda: None)
        self.phase, self.initial_events, self.samples = 'startup', {}, []
    def sample(self): pass
def launch(command, **options):
    assert options['stdout'] is sys.stderr and options['stderr'] is sys.stderr
    child = real_popen([*command[:4], sys.executable, '-c', probe, *command[4:]],
                      env=options.get('env'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = child.communicate(timeout=5)
    assert child.returncode == 0, stderr
    observed.append(json.loads(stdout))
    return child
with tempfile.TemporaryDirectory(prefix='harness-benchmark-application-launch-') as directory:
    root = pathlib.Path(directory)
    (root / 'benchmarks').mkdir()
    (root / 'benchmarks/profile.json').write_text(json.dumps(profile))
    work = root / 'work'
    with patch.object(workload, 'ROOT', root), patch.object(workload, 'WORK', work), \\
         patch.object(workload, 'verify_limits'), patch.object(workload, 'Monitor', Monitor), \\
         patch.object(workload, 'Rpc', return_value=Client()), patch.object(workload, 'create'), \\
         patch.object(workload, 'wait_server'), patch.object(workload, 'wait_editor', side_effect=RuntimeError('stop after launches')), \\
         patch.object(workload, 'counters', return_value={}), patch.object(workload, 'emit'), \\
         patch.object(workload.subprocess, 'Popen', side_effect=launch), \\
         patch.object(workload.subprocess, 'check_output', return_value='test runtime'):
        assert workload.main() == 1
    assert len(observed) == 2
    server, editor = observed
    assert server['args'] == ['/app/target/release/harness', 'serve', '--config', str(work / 'config.json')]
    assert server['key'] == 'sk-benchmark-synthetic'
    assert server['node_options'] == '--import=/app/benchmarks/provider.mjs --max-old-space-size=1024'
    assert editor['args'] == ['nvim', '--headless', '-u', 'NONE', '-c', 'luafile /app/benchmarks/editor.lua']
    assert editor['key'] == os.getenv('OPENAI_API_KEY') and editor['node_options'] == os.getenv('NODE_OPTIONS')
    assert all(item['score'] == '0' and item['child_score'] == '0' for item in observed)
`);
});

test('benchmark resource summaries measure CPU and memory within each sampled phase', async () => {
  const measurements = [
    { phase: 'startup', elapsed_seconds: 0, cpu_usec: 100, memory_bytes: 256 },
    { phase: 'idle', elapsed_seconds: 10, cpu_usec: 1000000, cpu_throttled_usec: 200000, memory_bytes: 1024, memory_peak_bytes: 8192 },
    { phase: 'idle', elapsed_seconds: 11, cpu_usec: 2000000, cpu_throttled_usec: 300000, memory_bytes: 2048, memory_peak_bytes: 8192 },
    { phase: 'idle', elapsed_seconds: 12.5, cpu_usec: 5500000, cpu_throttled_usec: 700000, memory_bytes: 1536, memory_peak_bytes: 8192 },
    { phase: 'load-1', elapsed_seconds: 20, cpu_usec: 6000000, cpu_throttled_usec: 700000, memory_bytes: 4096 },
    { phase: 'load-1', elapsed_seconds: 22, cpu_usec: 8000000, cpu_throttled_usec: 900000, memory_bytes: 8192 },
    { phase: 'capacity', elapsed_seconds: 23, cpu_usec: 8000000, memory_bytes: 4096 },
    { phase: 'capacity', elapsed_seconds: 23, cpu_usec: 8000000, memory_bytes: 4096 },
  ];
  const result = await containerResult({ records: [{ type: 'result', completed: true, measurements }] });
  assert.deepEqual(result.resources_by_phase, {
    idle: { sampled_seconds: 2.5, mean_cpu_cores: 1.8, cpu_throttled_seconds: 0.5, peak_sampled_memory_bytes: 2048 },
    'load-1': { sampled_seconds: 2, mean_cpu_cores: 1, cpu_throttled_seconds: 0.2, peak_sampled_memory_bytes: 8192 },
  });
  assert.deepEqual(result.measurements, measurements, 'Raw cgroup peaks remain available');
  const empty = await containerResult({ records: [{ type: 'result', completed: false, measurements: [] }] });
  assert.deepEqual(empty.resources_by_phase, {});
});

test('benchmark host accepts an observed capacity OOM after every load stage', async () => {
  const result = await containerResult({ oom: true, records: [
    ...stages, { type: 'phase', name: 'capacity' }, ...samples,
    { type: 'capacity', completed_sessions: 4 }, { type: 'capacity', completed_sessions: 8 },
  ] });
  assert.equal(result.completed, true);
  assert.equal(result.exhaustion.observed, true);
  assert.equal(result.exhaustion.oom_delta, 3);
  assert.equal(result.exhaustion.oom_kill_delta, 2);
  assert.deepEqual(result.docker_limits, profile.resources);
  assert.deepEqual(result.measurements, samples);
  assert.deepEqual(result.stages, stages);
  assert.equal(result.capacity_completed_sessions, 8);
  const changed = await containerResult({ oom: true, profile: { concurrent_sessions: [2, 4] }, records: [
    ...stages.slice(1), { type: 'phase', name: 'capacity' }, ...samples,
  ] });
  assert.equal(changed.completed, true, 'Required stages follow the selected profile');
});

test('benchmark host rejects early OOM, incomplete stages, and an exit without OOM', async () => {
  for (const [oom, completedStages, phase] of [
    [true, stages, 'load-4'], [true, stages.slice(1), 'capacity'], [false, stages, 'capacity'],
    [true, [stages[0], ...stages.slice(0, -1)], 'capacity'],
    [true, [...stages].reverse(), 'capacity'],
    [true, [...stages.slice(0, -1), { ...stages.at(-1), completed_tasks: 0 }], 'capacity'],
    [true, [...stages.slice(0, -1), { ...stages.at(-1), completed_tasks: true }], 'capacity'],
  ]) {
    const result = await containerResult({ oom, records: [
      ...completedStages, { type: 'phase', name: phase }, ...samples,
    ] });
    assert.equal(result.completed, false);
    assert.equal(result.exhaustion.observed, false);
  }
});

test('a Docker OOM report without sampled local memory exhaustion is incomplete', async () => {
  for (const observed of [
    [], [samples[1]],
    samples.map(({ memory_events, ...sample }) => sample),
    [samples[0], { ...samples[1], memory_events: { oom: 5, oom_kill: 3 } }],
    [samples[0], { ...samples[1], memory_events: { oom: 5, oom_kill: 5 } }],
    [samples[0], { ...samples[1], memory_events: { oom: 8, oom_kill: 3 } }],
    [samples[0], { ...samples[1], memory_events: { oom: true, oom_kill: 5 } }],
    [samples[0], { ...samples[1], memory_events: { oom: 4, oom_kill: 2 } }],
    [samples[0], { ...samples[1], phase: 'load-4' }, samples[1]],
  ]) {
    const result = await containerResult({ oom: true, records: [
      ...stages, { type: 'phase', name: 'capacity' }, ...observed,
    ] });
    assert.equal(result.completed, false);
    assert.equal(result.exhaustion.observed, false);
  }
});

test('reported benchmark success requires a successful Docker exit', async () => {
  const reported = { type: 'result', completed: true, stages, measurements: samples,
    capacity_completed_sessions: 8,
    exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_delta: 3, oom_kill_delta: 2 } };
  for (const exit_code of [0, 1, 137]) {
    const result = await containerResult({ exit_code, records: [reported] });
    assert.equal(result.completed, exit_code === 0);
    assert.deepEqual(result.measurements, samples);
    assert.equal(result.capacity_completed_sessions, 8);
    if (exit_code !== 0) assert.match(result.error, /Docker exited with status/);
  }
});

test('benchmark timeout cannot pass through a workload result or an OOM report', async () => {
  for (const records of [
    [...stages, { type: 'phase', name: 'capacity' }, ...samples],
    [{ type: 'result', completed: true, exhaustion: { observed: true } }],
  ]) {
    const result = await containerResult({ timeout: true, oom: true, records });
    assert.equal(result.completed, false);
    assert.match(result.error, /timed out/);
  }
});

test('benchmark host rejects unapplied resource and network limits', async () => {
  for (const configuration of [{ Memory: 1024 }, { NetworkMode: 'bridge' }]) {
    const result = await containerResult({ records: [], configuration });
    assert.match(result.error, /required resource and network limits/);
  }
});

test('benchmark host rejects missing or unapplied driver protection', async () => {
  for (const OomScoreAdj of [null, 0, -999, 1000]) {
    const result = await containerResult({ records: [], configuration: { OomScoreAdj } });
    assert.match(result.error, /did not protect the benchmark driver/);
  }
});


test('benchmark host applies selected CPU affinity and rejects a different Docker selection', async () => {
  const records = [{ type: 'result', completed: false, measurements: [] }];
  const result = await containerResult({ records, cpuset: '30,31', configuration: { CpusetCpus: '30,31' } });
  assert.equal(result.cpu_affinity, '30,31');
  for (const CpusetCpus of ['', '0,1']) {
    const rejected = await containerResult({ records, cpuset: '30,31', configuration: { CpusetCpus } });
    assert.match(rejected.error, /CPU affinity/);
  }
  await execute('python3', ['-c', `
import importlib.util, sys
from unittest.mock import patch
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('bench', 'scripts/bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
with patch.object(bench.os, 'sched_getaffinity', return_value={30, 31, 32}):
    assert bench.cpu_affinity('31,30') == '30,31'
    for value in ['0,1', '30,30', '30', '30,31,32', '30-31', '30,x', '30,']:
        try:
            bench.cpu_affinity(value)
        except ValueError:
            pass
        else:
            raise AssertionError(value)
`], { cwd: root, timeout: 5000 });
});
