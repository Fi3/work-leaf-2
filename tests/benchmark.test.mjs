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
spec = importlib.util.spec_from_file_location('bench', 'scripts/bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
settings = json.loads(sys.argv[1])
profile = json.loads(pathlib.Path('benchmarks/profile.json').read_text())
profile.update(settings.get('profile', {}))
resources = profile['resources']
configuration = {'Image': 'sha256:' + 'a' * 64, 'HostConfig': {
    'NanoCpus': resources['cpus'] * 1000000000, 'Memory': resources['memory_bytes'],
    'MemorySwap': resources['memory_swap_bytes'], 'PidsLimit': resources['pids_limit'], 'NetworkMode': 'none'}}
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
            result = bench.run_container('synthetic-image', profile, pathlib.Path(directory), 'source')
        except RuntimeError as error:
            result = {'error': str(error)}
    assert commands[-1] == ('rm', '--force', 'synthetic-container')
    assert any(command[0] == 'kill' for command in commands) == settings.get('timeout', False)
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
