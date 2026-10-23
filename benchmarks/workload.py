"""Run real application load until the container records a memory-limit kill."""
import concurrent.futures
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path('/app')
WORK = Path('/work')
CGROUP = Path('/sys/fs/cgroup')
sys.path.insert(0, str(ROOT / 'tests/fixtures'))
from rpc import Rpc

OUTPUT_LOCK = threading.Lock()


def counters(path):
    return {parts[0]: int(parts[1]) for line in path.read_text().splitlines()
            if len(parts := line.split()) >= 2 and parts[1].isdecimal()}


def emit(kind, **value):
    with OUTPUT_LOCK:
        print(json.dumps({'type': kind, **value}, separators=(',', ':')), flush=True)


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def process_memory():
    result = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            command = (directory / 'cmdline').read_bytes().split(b'\0')
            if not command or not command[0]:
                continue
            names = b' '.join(command)
            role = 'worker' if b'worker.mjs' in names else 'editor' if b'nvim' in command[0] else 'server' if b'harness' in command[0] else 'driver_or_tool'
            memory = counters(directory / 'smaps_rollup')
            sample = {'pid': int(directory.name), 'role': role,
                      **{name: memory[field] * 1024 for name, field in (
                          ('rss_bytes', 'Rss:'), ('pss_bytes', 'Pss:'),
                          ('pss_anon_bytes', 'Pss_Anon:'), ('pss_file_bytes', 'Pss_File:'),
                          ('pss_shmem_bytes', 'Pss_Shmem:')) if field in memory}}
            try:
                sample['oom_score_adj'] = int((directory / 'oom_score_adj').read_text())
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
            result.append(sample)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


class Monitor:
    def __init__(self, profile):
        self.profile = profile
        self.phase = 'startup'
        self.started = time.monotonic()
        self.initial_events = counters(CGROUP / 'memory.events')
        self.samples = []
        self.done = threading.Event()
        self.exhausted = threading.Event()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def sample(self):
        with self.lock:
            self.record_sample()

    def record_sample(self):
        cpu = counters(CGROUP / 'cpu.stat')
        events = counters(CGROUP / 'memory.events')
        value = {'elapsed_seconds': round(time.monotonic() - self.started, 3), 'phase': self.phase,
                 'cpu_usec': cpu['usage_usec'], 'cpu_throttled_usec': cpu.get('throttled_usec', 0),
                 'memory_bytes': int((CGROUP / 'memory.current').read_text()),
                 'memory_peak_bytes': int((CGROUP / 'memory.peak').read_text()),
                 'memory_stat': counters(CGROUP / 'memory.stat'),
                 'memory_events': events, 'processes': process_memory()}
        self.samples.append(value)
        emit('sample', **value)
        if (events.get('oom', 0) > self.initial_events.get('oom', 0)
                and events.get('oom_kill', 0) > self.initial_events.get('oom_kill', 0)):
            self.exhausted.set()

    def run(self):
        while not self.done.is_set():
            try:
                self.sample()
            except OSError as error:
                emit('monitor_error', message=str(error))
            self.done.wait(self.profile['sample_interval_ms'] / 1000)

    def stage(self, phase):
        with self.lock:
            self.phase = phase
            emit('phase', name=phase)


def verify_limits(profile):
    quota, period = (CGROUP / 'cpu.max').read_text().split()
    actual = {'cpus': int(quota) / int(period), 'memory_bytes': int((CGROUP / 'memory.max').read_text()),
              'memory_swap_bytes': int((CGROUP / 'memory.max').read_text()) + int((CGROUP / 'memory.swap.max').read_text()),
              'pids_limit': int((CGROUP / 'pids.max').read_text())}
    if actual != profile['resources']:
        raise RuntimeError(f'Container limits differ from profile: {actual}')
    if Path('/proc/self/oom_score_adj').read_text().strip() != '-1000':
        raise RuntimeError('Benchmark driver is not protected from the memory-limit kill')
    return actual


def wait_server(server):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError('Server exited during startup')
        try:
            with contextlib.closing(Rpc(WORK / 'control.sock')) as client:
                if client.request('system.hello', {'api_version': 1})['ready']:
                    return
        except (OSError, AssertionError, ConnectionError):
            pass
        time.sleep(.05)
    raise TimeoutError('Server did not become ready')


def create(client, identifier, instructions=''):
    client.request('session.create', {'session_id': identifier, 'workspace': str(WORK / 'project')})
    if instructions:
        client.request('session.configure', {'session_id': identifier, 'instructions': instructions})


def wait_editor(editor):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if editor.poll() is not None:
            raise RuntimeError('Editor exited during startup')
        path = WORK / 'editor-metrics.json'
        if path.exists() and json.loads(path.read_text())['transcript_lines'] > 0:
            return
        time.sleep(.05)
    raise TimeoutError('Editor did not attach to the session')


def task(client, session, request, text):
    start = time.monotonic()
    client.request('input.submit', {'session_id': session, 'request_id': request, 'text': text, 'context': []})
    result = client.request('submission.wait', {'session_id': session, 'request_id': request, 'timeout_ms': 20000})
    if result['status'] != 'done':
        raise RuntimeError(f'Synthetic task failed: {result}')
    return (time.monotonic() - start) * 1000


def latency_summary(values):
    values = sorted(values)
    return {'completed_tasks': len(values), **{name: round(values[min(len(values) - 1, int((len(values) - 1) * fraction))], 3)
            for name, fraction in [('p50_ms', .50), ('p95_ms', .95), ('p99_ms', .99)]}} if values else {'completed_tasks': 0}


def load_phase(count, profile, phase):
    deadline = time.monotonic() + profile['load_seconds']
    def run(index):
        values = []
        with contextlib.closing(Rpc(WORK / 'control.sock', timeout=25)) as client:
            while time.monotonic() < deadline:
                values.append(task(client, f'load{index}', f'{phase}-{len(values)}', 'Run the benchmark tool and give the synthetic answer.'))
        return values
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        return latency_summary([value for group in pool.map(run, range(count)) for value in group])


def capacity_batch(first, profile):
    def run(index):
        identifier = f'capacity{index}'
        # Distinct ordinary session data creates pressure through the real storage and model paths.
        instructions = (f'Session {index}: preserve this synthetic project context. ' + 'i' * profile['capacity_instructions_bytes'])[:profile['capacity_instructions_bytes']]
        text = (f'Benchmark task {index}. ' + 'x' * profile['capacity_input_bytes'])[:profile['capacity_input_bytes']]
        with contextlib.closing(Rpc(WORK / 'control.sock', timeout=25)) as client:
            create(client, identifier, instructions)
            if index == first:
                write_json(WORK / 'editor-control.json', {'session': identifier, 'visible': True})
            return task(client, identifier, 'capacity-task', text)
    with concurrent.futures.ThreadPoolExecutor(max_workers=profile['capacity_batch_size']) as pool:
        return list(pool.map(run, range(first, first + profile['capacity_batch_size'])))


def main():
    profile = json.loads((ROOT / 'benchmarks/profile.json').read_text())
    verify_limits(profile)
    WORK.mkdir(exist_ok=True)
    (WORK / 'state').mkdir(mode=0o700, exist_ok=True)
    (WORK / 'project').mkdir(exist_ok=True)
    write_json(WORK / 'config.json', {'provider': profile['provider'], 'model': profile['model'],
        'node_path': '/usr/local/bin/node', 'worker_path': '/app/adapter/worker.mjs',
        'state_dir': str(WORK / 'state'), 'socket_path': str(WORK / 'control.sock')})
    environment = dict(os.environ, OPENAI_API_KEY='sk-benchmark-synthetic',
        NODE_OPTIONS=f"--import=/app/benchmarks/provider.mjs --max-old-space-size={profile['node_max_old_space_mib']}")
    monitor = Monitor(profile)
    monitor.thread.start()
    children, stages = [], []
    capacity = 0
    failure = None
    try:
        # Keep application processes eligible for OOM kills while the driver records the result.
        server = subprocess.Popen(['choom', '-n', '0', '--', '/app/target/release/harness', 'serve', '--config', str(WORK / 'config.json')],
                                  env=environment, stdout=sys.stderr, stderr=sys.stderr)
        children.append(server)
        wait_server(server)
        with contextlib.closing(Rpc(WORK / 'control.sock')) as client:
            for index in range(max(profile['concurrent_sessions'])):
                create(client, f'load{index}')
        write_json(WORK / 'editor-control.json', {'session': 'load0', 'visible': True})
        editor = subprocess.Popen(['choom', '-n', '0', '--', 'nvim', '--headless', '-u', 'NONE', '-c', 'luafile /app/benchmarks/editor.lua'],
                                  stdout=sys.stderr, stderr=sys.stderr)
        children.append(editor)
        wait_editor(editor)
        monitor.stage('idle')
        time.sleep(profile['idle_seconds'])
        for count in profile['concurrent_sessions']:
            monitor.stage(f'load-{count}')
            stages.append({'phase': monitor.phase, **load_phase(count, profile, monitor.phase)})
            emit('stage_result', **stages[-1])
        monitor.stage('hidden-editor')
        write_json(WORK / 'editor-control.json', {'session': 'load0', 'visible': False})
        stages.append({'phase': monitor.phase, **load_phase(1, profile, monitor.phase)})
        emit('stage_result', **stages[-1])
        write_json(WORK / 'editor-control.json', {'session': 'load0', 'visible': True, 'history': True})
        time.sleep(1)
        editor_metrics = json.loads((WORK / 'editor-metrics.json').read_text())
        if editor.poll() is not None or editor_metrics['changes'] == 0:
            raise RuntimeError('The real editor did not process streamed updates')
        if counters(CGROUP / 'memory.events').get('oom_kill', 0) != monitor.initial_events.get('oom_kill', 0):
            raise RuntimeError('Memory exhaustion occurred before the capacity phase')
        monitor.stage('capacity')
        while capacity < profile['max_capacity_sessions'] and not monitor.exhausted.is_set():
            try:
                values = capacity_batch(capacity, profile)
                capacity += len(values)
                emit('capacity', completed_sessions=capacity, **latency_summary(values))
            except Exception:
                monitor.sample()
                if not monitor.exhausted.is_set():
                    raise
        if not monitor.exhausted.is_set():
            raise RuntimeError('Capacity ceiling reached without memory exhaustion; increase the profile ceiling')
    except Exception as error:
        failure = f'{type(error).__name__}: {error}'
    finally:
        monitor.done.set()
        monitor.thread.join(timeout=2)
        monitor.sample()
        write_json(WORK / 'editor-control.json', {'stop': True})
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
    events = counters(CGROUP / 'memory.events')
    delta = events.get('oom_kill', 0) - monitor.initial_events.get('oom_kill', 0)
    oom_delta = events.get('oom', 0) - monitor.initial_events.get('oom', 0)
    complete = failure is None and monitor.phase == 'capacity' and delta > 0 and oom_delta > 0
    emit('result', completed=complete, error=failure, measurements=monitor.samples, stages=stages,
         capacity_completed_sessions=capacity, exhaustion={'observed': complete, 'reason': 'memory_limit',
         'phase': monitor.phase, 'oom_delta': oom_delta, 'oom_kill_delta': delta}, editor=locals().get('editor_metrics'),
         runtimes={'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                   'nvim': subprocess.check_output(['nvim', '--version'], text=True).splitlines()[0]})
    return 0 if complete else 1


if __name__ == '__main__':
    sys.exit(main())
