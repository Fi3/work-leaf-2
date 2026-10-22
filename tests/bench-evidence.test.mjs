import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pty } from './fixtures/terminal.mjs';

const source = resolve('.');
const baselinePath = 'benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json';
const baseline = JSON.parse(await readFile(join(source, baselinePath), 'utf8'));
const profile = baseline.profile;
const zero = '0'.repeat(40);

function command(directory, program, args, input = '') {
  const result = spawnSync(program, args, { cwd: directory, input, encoding: 'utf8', detached: true });
  assert.ifError(result.error);
  return result;
}

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-bench-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = command(directory, 'git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const run = (...args) => command(directory, 'python3', ['scripts/bench-evidence.py', ...args]);
  git('init', '-q'); git('config', 'user.name', 'Benchmark test'); git('config', 'user.email', 'benchmark@example.invalid');
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, '.githooks'));
  await mkdir(join(directory, 'benchmarks/results'), { recursive: true });
  for (const path of ['scripts/bench-evidence.py', 'scripts/bench_report.py', 'scripts/install-hooks.sh', '.githooks/pre-push']) {
    await copyFile(join(source, path), join(directory, path));
    await chmod(join(directory, path), 0o755);
  }
  await copyFile(join(source, 'benchmarks/profile.json'), join(directory, 'benchmarks/profile.json'));
  await copyFile(join(source, baselinePath), join(directory, baselinePath));
  await writeFile(join(directory, 'README.md'), 'Source version one.\n');
  await writeFile(join(directory, '.gitignore'), '.bench-results/\n');
  git('add', '.'); git('commit', '-qm', 'ADD test source to check benchmark evidence');
  const fingerprint = ref => {
    const result = run('fingerprint', ...(ref ? ['--ref', ref] : []));
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const evidence = async (ref = 'HEAD', change = {}, tracked = false) => {
    const id = fingerprint(ref);
    const file = join(directory, tracked ? 'benchmarks/results' : '.bench-results', `${id}.json`);
    await mkdir(resolve(file, '..'), { recursive: true });
    const body = {
      ...structuredClone(baseline), source_fingerprint: id,
      profile_sha256: createHash('sha256').update(git('show', `${ref}:benchmarks/profile.json`) + '\n').digest('hex'),
      ...change,
    };
    await writeFile(file, JSON.stringify(body));
    return file;
  };
  const push = records => command(directory, 'sh', ['.githooks/pre-push', 'origin', '/unused'], records);
  const record = (ref = 'HEAD') => `refs/heads/${ref} ${git('rev-parse', ref)} refs/heads/${ref} ${zero}\n`;
  return { directory, git, run, fingerprint, evidence, push, record };
}

test('fingerprints bind committed content, staged new files, file mode, and deleted files', async t => {
  const repo = await repository(t);
  const original = repo.fingerprint('HEAD');
  assert.equal(repo.fingerprint(), original);
  await writeFile(join(repo.directory, 'personal-note.txt'), 'Unrelated local note.');
  assert.equal(repo.fingerprint(), original, 'Untracked personal files are not source inputs');
  await writeFile(join(repo.directory, 'new source.txt'), 'New implementation.\n');
  repo.git('add', '-N', 'new source.txt');
  const changed = repo.fingerprint();
  assert.notEqual(changed, original);
  repo.git('add', 'new source.txt'); repo.git('commit', '-qm', 'ADD source to test a new patch');
  assert.equal(repo.fingerprint('HEAD'), changed);
  await chmod(join(repo.directory, 'new source.txt'), 0o755);
  assert.notEqual(repo.fingerprint(), changed);
  await rm(join(repo.directory, 'new source.txt'));
  assert.equal(repo.fingerprint(), original, 'Deleting an added source restores the original source contents');
});

test('snapshot exports the exact tracked working contents and symlinks', async t => {
  const repo = await repository(t);
  await writeFile(join(repo.directory, 'README.md'), 'Unsaved patch.\n');
  await symlink('README.md', join(repo.directory, 'readme-link'));
  repo.git('add', '-N', 'readme-link');
  const destination = await mkdtemp(join(tmpdir(), 'harness-bench-snapshot-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const result = repo.run('snapshot', destination);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), repo.fingerprint());
  assert.equal(await readFile(join(destination, 'readme-link'), 'utf8'), 'Unsaved patch.\n');
  assert.notEqual(repo.run('snapshot', repo.directory).status, 0);
  assert.notEqual(repo.run('snapshot', destination).status, 0, 'A populated export is never overwritten');
});

test('valid evidence follows source contents across the evidence commit and ignores a dirty worktree during push', async t => {
  const repo = await repository(t);
  const before = repo.fingerprint('HEAD');
  const file = await repo.evidence('HEAD', {}, true);
  repo.git('add', file); repo.git('commit', '-qm', 'ADD measured baseline to record resource limits');
  assert.equal(repo.fingerprint('HEAD'), before);
  await writeFile(join(repo.directory, 'README.md'), 'A different uncommitted patch.\n');
  assert.notEqual(repo.fingerprint(), before);
  assert.equal(repo.run('validate', '--ref', 'HEAD').status, 0);
  assert.notEqual(repo.run('validate').status, 0);
  assert.equal(repo.push(repo.record()).status, 0);
});

test('missing, malformed, incomplete, and stale benchmark evidence fail without human confirmation', async t => {
  const repo = await repository(t);
  let result = repo.push(repo.record());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WARNING.*benchmark/s);
  assert.match(result.stderr, /no terminal/);
  assert.match(result.stderr, /refs\/heads\/HEAD/);
  assert.match(result.stderr, /git switch OUTGOING_BRANCH/);
  assert.match(result.stderr, /git rev-parse HEAD/);
  assert.match(result.stderr, /Verify that HEAD is the listed outgoing commit/);
  assert.match(result.stderr, /sh scripts\/check\.sh/);
  assert.match(result.stderr, /git add PATH/);
  assert.match(result.stderr, /python3 scripts\/bench\.py --publish\n/);
  assert.match(result.stderr, /--publish --cpuset-cpus 30,31/);
  assert.match(result.stderr, /Linux x86_64 with cgroup v2/);
  assert.match(result.stderr, /512 MiB RAM, no swap, and no network/);
  assert.match(result.stderr, /memory exhaustion, with a ten-minute timeout/);
  assert.match(result.stderr, /Image preparation can take\n\s+additional time/);
  assert.match(result.stderr, /git add benchmarks\/results\//);
  assert.match(result.stderr, /git commit -m "ADD benchmark evidence/);
  assert.match(result.stderr, /Retry the push/);
  assert.match(result.stderr, /This hook does not run\n+it automatically/);
  for (const invalid of [
    { schema: 2 }, { schema: true }, { completed: false }, { source_fingerprint: '0'.repeat(64) },
    { profile_sha256: '0'.repeat(64) }, { docker_image_id: 'harness:latest' },
    { profile: { ...profile, resources: { cpus: 8 } } }, { measurements: [] },
    { measurements: [{ memory_bytes: 1 }] }, { measurements: [1] },
    { measurements: [{ cpu_usec: -1, memory_bytes: 1 }] },
    { measurements: [{ cpu_usec: true, memory_bytes: 1 }] },
    { measurements: [{ cpu_usec: 2, memory_bytes: 1 }, { cpu_usec: 1, memory_bytes: 1 }] },
    { docker_limits: { ...profile.resources, memory_bytes: 1073741824 } },
    { exhaustion: { observed: false, reason: 'memory_limit' } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_delta: 1, oom_kill_delta: 0 } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_delta: 0, oom_kill_delta: 1 } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_delta: true, oom_kill_delta: 1 } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_delta: 1.5, oom_kill_delta: 1 } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'capacity', oom_kill_delta: 1 } },
    { exhaustion: { observed: true, reason: 'memory_limit', phase: 'idle', oom_kill_delta: 1 } },
    { exhaustion: { observed: true, reason: 'timeout' } },
  ]) {
    await repo.evidence('HEAD', invalid);
    assert.notEqual(repo.run('validate', '--ref', 'HEAD').status, 0, JSON.stringify(invalid));
  }
  const file = await repo.evidence();
  await writeFile(file, '{malformed');
  assert.notEqual(repo.run('validate', '--ref', 'HEAD').status, 0);
  result = repo.push(repo.record());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /python3 scripts\/bench\.py --publish/);
  assert.match(result.stderr, /no terminal/);
  await repo.evidence('HEAD', { measurements: baseline.measurements.filter(sample => sample.phase !== 'load-4') });
  result = repo.push(repo.record());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /comparison is unavailable/);
  assert.match(result.stderr, /no terminal/);
  await repo.evidence();
  assert.equal(repo.run('validate', '--ref', 'HEAD').status, 0);
  await writeFile(join(repo.directory, 'README.md'), 'Next committed patch.\n');
  repo.git('add', 'README.md'); repo.git('commit', '-qm', 'UPDATE source to test stale evidence');
  result = repo.push(repo.record());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No benchmark evidence/);
});

test('pre-push checks each outgoing tip instead of HEAD and skips deleted refs', async t => {
  const repo = await repository(t);
  repo.git('branch', 'measured');
  await repo.evidence('measured');
  await writeFile(join(repo.directory, 'README.md'), 'Another branch.\n');
  repo.git('add', 'README.md'); repo.git('commit', '-qm', 'UPDATE source to test outgoing references');
  assert.equal(repo.push(repo.record('measured')).status, 0, 'An unmeasured HEAD is not an outgoing ref');
  assert.notEqual(repo.push(repo.record('measured') + repo.record()).status, 0);
  assert.equal(repo.push(`(delete) ${zero} refs/heads/old ${repo.git('rev-parse', 'HEAD')}\n`).status, 0);
  assert.notEqual(repo.push('invalid\n').status, 0);
});

test('measured regressions stop outgoing refs without confirmation and ignore saved pass claims', async t => {
  const repo = await repository(t);
  repo.git('branch', 'regressed');
  const measurements = baseline.measurements.map(sample => ({
    ...sample, memory_bytes: sample.phase === 'load-4' ? Math.ceil(sample.memory_bytes * 1.21) : sample.memory_bytes,
  }));
  await repo.evidence('regressed', { measurements, comparison: { status: 'PASS' }, regression: { status: 'PASS' } });
  let result = repo.run('validate', '--ref', 'regressed');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /benchmark regression limit exceeded/);
  assert.match(result.stderr, /load-4/);
  assert.match(result.stderr, /\+21\.0%/);
  assert.match(result.stderr, /FAIL/);
  await writeFile(join(repo.directory, 'README.md'), 'Another outgoing source with no evidence.\n');
  repo.git('add', 'README.md'); repo.git('commit', '-qm', 'UPDATE source to test mixed outgoing evidence');
  await writeFile(join(repo.directory, 'README.md'), 'An unrelated dirty worktree.\n');
  result = repo.push(repo.record() + repo.record('regressed'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Push stopped: measured benchmark regressions/);
  assert.match(result.stderr, /refs\/heads\/regressed/);
  assert.match(result.stderr, /Other outgoing sources have missing or invalid evidence/);
  assert.match(result.stderr, /no confirmation override/);
  assert.doesNotMatch(result.stderr, /no terminal|Type yes to continue|Push these unmeasured/);
});

test('hook installation is idempotent and preserves existing user hooks', async t => {
  const repo = await repository(t);
  const install = () => command(repo.directory, 'sh', ['scripts/install-hooks.sh']);
  repo.git('config', '--local', 'core.hooksPath', 'my-hooks');
  assert.notEqual(install().status, 0);
  assert.equal(repo.git('config', '--get', 'core.hooksPath'), 'my-hooks');
  repo.git('config', '--unset', 'core.hooksPath');
  const previous = join(repo.directory, '.git/hooks/pre-commit');
  await writeFile(previous, '#!/bin/sh\nexit 0\n'); await chmod(previous, 0o755);
  assert.notEqual(install().status, 0);
  assert.equal(await readFile(previous, 'utf8'), '#!/bin/sh\nexit 0\n');
  await rm(previous);
  assert.equal(install().status, 0);
  assert.equal(repo.git('config', '--get', 'core.hooksPath'), '.githooks');
  assert.equal(install().status, 0);
});

test('missing evidence requires an explicit yes on the controlling terminal', { timeout: 15000 }, async t => {
  const repo = await repository(t);
  for (const answer of ['no', 'yes']) {
    const terminal = await pty(t);
    const child = spawn('python3', ['-c', `
import fcntl, os, subprocess, sys, termios
os.setsid()
terminal = os.open(sys.argv[1], os.O_RDWR)
fcntl.ioctl(terminal, termios.TIOCSCTTY, 0)
result = subprocess.run(["sh", ".githooks/pre-push", "origin", "/unused"], input=sys.stdin.buffer.read())
sys.exit(result.returncode)
`, terminal.path], { cwd: repo.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let diagnostics = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { diagnostics += value; });
    const done = once(child, 'exit');
    child.stdin.end(repo.record());
    await terminal.wait('Type yes to continue:');
    terminal.write(`${answer}\n`);
    assert.equal((await done)[0], answer === 'yes' ? 0 : 1, diagnostics);
  }
});
