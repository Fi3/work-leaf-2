import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve('.');
const baselinePath = 'benchmarks/results/1d1ae9a4246cbc06cc54e7c2701309bd30433b3ffb20d54fcc137248177aba87.json';

// Replace the measurement boundary only. Source capture, validation, reporting,
// Git commits, and Git hooks all use their real implementations.
const measurement = `
import importlib.util, json, pathlib, subprocess, sys
from unittest.mock import patch
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('bench', 'scripts/bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
settings = json.loads(sys.argv[1])
sys.argv = ['scripts/bench.py', *settings.get('arguments', ['--publish'])]
calls = {'builds': 0, 'measurements': 0}
original_run = subprocess.run
def run(command, *arguments, **options):
    if command[:2] == ['docker', 'build']:
        calls['builds'] += 1
        return subprocess.CompletedProcess(command, 0)
    return original_run(command, *arguments, **options)
def measure(*arguments, **options):
    calls['measurements'] += 1
    result = json.loads(pathlib.Path('${baselinePath}').read_text())
    result.update(settings.get('result', {}))
    change = settings.get('during_measurement')
    if change == 'source':
        pathlib.Path('README.md').write_text('Changed during measurement.\\n')
    elif change == 'new_source':
        pathlib.Path('new-source.txt').write_text('Added during measurement.\\n')
    elif change == 'branch':
        subprocess.run(['git', 'switch', '-qc', 'AnotherBranch'], check=True)
    elif change == 'head':
        subprocess.run(['git', 'commit', '--allow-empty', '-qm', 'ADD marker to change the measured revision'], check=True)
    elif change == 'index':
        pathlib.Path('README.md').write_text('Source staged during measurement.\\n')
        subprocess.run(['git', 'add', 'README.md'], check=True)
        pathlib.Path('README.md').write_bytes(subprocess.check_output(['git', 'show', 'HEAD:README.md']))
    elif change == 'evidence':
        pathlib.Path('benchmarks/results/additional.json').write_text('Evidence staged during measurement.\\n')
        subprocess.run(['git', 'add', 'benchmarks/results/additional.json'], check=True)
    calls['head_after_measurement'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    calls['index_after_measurement'] = subprocess.check_output(['git', 'write-tree'], text=True).strip()
    return result
try:
    with patch.object(bench.subprocess, 'run', run), patch.object(bench, 'run_container', measure):
        if settings.get('repeat_commit'):
            evidence = bench.evidence_module()
            root = evidence.project_root()
            context = bench.publication_context(evidence, root)
            source = evidence.fingerprint(evidence.source_files(root, context[1]))
            path = root / 'benchmarks/results' / (source + '.json')
            print(bench.commit_result(evidence, root, context, source, path, path.read_text()))
            status = 0
        else:
            status = bench.main()
except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
    print(f'Benchmark failed: {error}', file=sys.stderr)
    status = 1
finally:
    pathlib.Path('.git/benchmark-test-state.json').write_text(json.dumps(calls))
sys.exit(status)
`;

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-bench-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = (program, args) => {
    const result = spawnSync(program, args, { cwd: directory, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => {
    const result = command('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Benchmark test');
  git('config', 'user.email', 'benchmark@example.invalid');
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'benchmarks/results'), { recursive: true });
  for (const path of ['scripts/bench.py', 'scripts/bench-evidence.py', 'scripts/bench_report.py',
    'benchmarks/profile.json', 'benchmarks/published-harnesses.json', baselinePath]) {
    await copyFile(join(source, path), join(directory, path));
  }
  await writeFile(join(directory, '.gitignore'), '.bench-results/\n__pycache__/\n');
  await writeFile(join(directory, 'README.md'), 'Committed benchmark source.\n');
  git('add', '.'); git('commit', '-qm', 'ADD source to test benchmark publication');
  const fingerprint = () => {
    const result = command('python3', ['scripts/bench-evidence.py', 'fingerprint', '--ref', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const id = fingerprint();
  const resultPath = `benchmarks/results/${id}.json`;
  const head = git('rev-parse', 'HEAD');
  const run = (settings = {}) => command('python3', ['-c', measurement, JSON.stringify(settings)]);
  const calls = async () => JSON.parse(await readFile(join(directory, '.git/benchmark-test-state.json'), 'utf8'));
  return { directory, command, git, fingerprint, id, resultPath, head, run, calls };
}

test('a passing published benchmark commits only its evidence and keeps unrelated staged evidence', async t => {
  const repo = await repository(t);
  await writeFile(join(repo.directory, 'benchmarks/results/other.json'), 'Unrelated staged evidence.\n');
  repo.git('add', 'benchmarks/results/other.json');
  const staged = repo.git('show', ':benchmarks/results/other.json');
  const hook = join(repo.directory, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf invoked > .git/benchmark-hook-called\n');
  await chmod(hook, 0o755);
  const result = repo.run({ during_measurement: 'evidence' });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(repo.git('rev-parse', 'HEAD'), repo.head, 'A passing result is committed automatically');
  assert.equal(repo.git('rev-parse', 'HEAD^'), repo.head);
  assert.equal(repo.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), repo.resultPath);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'benchmarks/results/additional.json\nbenchmarks/results/other.json');
  assert.equal(repo.git('show', ':benchmarks/results/other.json'), staged);
  assert.equal(repo.git('show', ':benchmarks/results/additional.json'), 'Evidence staged during measurement.');
  assert.equal(await readFile(join(repo.directory, '.git/benchmark-hook-called'), 'utf8'), 'invoked');
  assert.equal(repo.fingerprint(), repo.id, 'The evidence commit retains the measured source identity');
  const saved = JSON.parse(repo.git('show', `HEAD:${repo.resultPath}`));
  assert.equal(saved.source_fingerprint, repo.id);
  assert.equal(saved.source_revision, repo.head);
  assert.equal(saved.comparison.status, 'PASS');
  assert.match(repo.git('log', '-1', '--format=%s'), /^(ADD|UPDATE) .*benchmark.*(evidence|resource)/);
  const verified = repo.command('python3', ['scripts/bench-evidence.py', 'validate', '--ref', 'HEAD']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /HEAD:benchmarks\/results\//);
});

test('a complete benchmark regression is saved but never committed', async t => {
  const repo = await repository(t);
  const result = repo.run({ result: { capacity_completed_sessions: 1 } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /resource report: FAIL/);
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.head);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  const saved = JSON.parse(await readFile(join(repo.directory, repo.resultPath), 'utf8'));
  assert.equal(saved.comparison.status, 'FAIL');
  assert.equal(saved.source_revision, repo.head);
  assert.equal(await readFile(join(repo.directory, '.bench-results', `${repo.id}.json`), 'utf8'),
    await readFile(join(repo.directory, repo.resultPath), 'utf8'));
});

test('an incomplete benchmark retains diagnostic evidence without publishing or committing it', async t => {
  const repo = await repository(t);
  const result = repo.run({ result: { completed: false } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete/);
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.head);
  assert.equal(repo.git('status', '--porcelain'), '');
  const saved = JSON.parse(await readFile(join(repo.directory, '.bench-results', `${repo.id}.failed.json`), 'utf8'));
  assert.equal(saved.completed, false);
  await assert.rejects(readFile(join(repo.directory, repo.resultPath)), { code: 'ENOENT' });
});

test('publication rejects uncommitted source and detached HEAD before building or measuring', async t => {
  for (const state of ['unstaged', 'staged', 'untracked', 'detached']) {
    await t.test(state, async t => {
      const repo = await repository(t);
      if (state === 'detached') repo.git('checkout', '--detach', '-q');
      else if (state === 'untracked') await writeFile(join(repo.directory, 'new-source.txt'), 'Uncommitted new source.\n');
      else {
        await writeFile(join(repo.directory, 'README.md'), 'Uncommitted source change.\n');
        if (state === 'staged') repo.git('add', 'README.md');
      }
      const index = repo.git('write-tree');
      const result = repo.run();
      assert.notEqual(result.status, 0, state);
      assert.match(result.stderr, /commit|branch|detached/i);
      assert.deepEqual(await repo.calls(), { builds: 0, measurements: 0 });
      assert.equal(repo.git('rev-parse', 'HEAD'), repo.head);
      assert.equal(repo.git('write-tree'), index);
    });
  }
});

test('source, branch, revision, and index changes during measurement stop automatic publication', async t => {
  for (const change of ['source', 'new_source', 'branch', 'head', 'index']) {
    await t.test(change, async t => {
      const repo = await repository(t);
      const result = repo.run({ during_measurement: change });
      assert.notEqual(result.status, 0, change);
      assert.match(result.stderr, /changed|commit|branch|index/i);
      const calls = await repo.calls();
      assert.equal(calls.builds, 1);
      assert.equal(calls.measurements, 1);
      assert.equal(repo.git('rev-parse', 'HEAD'), calls.head_after_measurement, 'No evidence commit follows the concurrent change');
      assert.equal(repo.git('write-tree'), calls.index_after_measurement, 'The changed index is not overwritten');
      const saved = JSON.parse(await readFile(join(repo.directory, '.bench-results', `${repo.id}.json`), 'utf8'));
      assert.equal(saved.source_fingerprint, repo.id);
      assert.equal(saved.source_revision, repo.head);
      assert.equal(saved.comparison.status, 'PASS');
    });
  }
});

test('a rejecting Git hook keeps passing evidence without creating a commit', async t => {
  const repo = await repository(t);
  const hook = join(repo.directory, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "Publication blocked by test hook" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Publication blocked by test hook/);
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.head);
  const saved = JSON.parse(await readFile(join(repo.directory, repo.resultPath), 'utf8'));
  assert.equal(saved.comparison.status, 'PASS');
});

test('a hook that replaces measured evidence cannot report successful publication', async t => {
  const repo = await repository(t);
  const hook = join(repo.directory, '.git/hooks/pre-commit');
  await writeFile(hook, `#!/bin/sh\nprintf '{"changed_by_hook":true}\\n' > '${repo.resultPath}'\ngit add -- '${repo.resultPath}'\n`);
  await chmod(hook, 0o755);
  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /committed result does not match the measurement/i);
  assert.doesNotMatch(result.stdout, /push check passed/i);
  assert.notEqual(repo.git('rev-parse', 'HEAD'), repo.head, 'The hook allowed Git to complete its commit');
  assert.deepEqual(JSON.parse(repo.git('show', `HEAD:${repo.resultPath}`)), { changed_by_hook: true });
  const measured = JSON.parse(await readFile(join(repo.directory, '.bench-results', `${repo.id}.json`), 'utf8'));
  assert.equal(measured.comparison.status, 'PASS', 'Original measured evidence remains available');
  assert.equal(measured.source_revision, repo.head);
});

test('a hook that adds changed source cannot report a measured evidence commit', async t => {
  const repo = await repository(t);
  const hook = join(repo.directory, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf "Source changed by commit hook.\\n" > README.md\ngit add -- README.md\n');
  await chmod(hook, 0o755);
  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /automatic evidence publication failed: .*source/i);
  assert.doesNotMatch(result.stdout, /push check passed/i);
  assert.notEqual(repo.git('rev-parse', 'HEAD'), repo.head);
  assert.equal(repo.git('show', 'HEAD:README.md'), 'Source changed by commit hook.');
  assert.notEqual(repo.fingerprint(), repo.id);
  const committed = JSON.parse(repo.git('show', `HEAD:${repo.resultPath}`));
  assert.equal(committed.source_fingerprint, repo.id, 'The result still records the source actually measured');
});

test('publishing the same saved result again succeeds without an empty commit', async t => {
  const repo = await repository(t);
  const measured = repo.run();
  assert.equal(measured.status, 0, measured.stderr);
  const committed = repo.git('rev-parse', 'HEAD');
  const repeated = repo.run({ repeat_commit: true });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout.trim(), committed);
  assert.equal(repo.git('rev-parse', 'HEAD'), committed);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.deepEqual(await repo.calls(), { builds: 0, measurements: 0 });
});

test('a local benchmark measures working changes without committing or publishing them', async t => {
  const repo = await repository(t);
  await writeFile(join(repo.directory, 'README.md'), 'Local candidate source.\n');
  const originalStatus = repo.git('status', '--porcelain');
  const result = repo.run({ arguments: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.head);
  assert.equal(repo.git('status', '--porcelain'), originalStatus);
  assert.equal((await repo.calls()).measurements, 1);
  await assert.rejects(readFile(join(repo.directory, repo.resultPath)), { code: 'ENOENT' });
});
