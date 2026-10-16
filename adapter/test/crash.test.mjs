import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openApplication } from '../pi.mjs';

const phase = process.env.HARNESS_CRASH_TEST_PHASE;
async function childRun() {
  const config = JSON.parse(process.env.HARNESS_CRASH_TEST_CONFIG);
  const storage = await openNodeSqliteStorage(join(config.state_dir, 'agent.sqlite'));
  const crash = value => { writeFileSync(join(config.state_dir, 'crash.json'), JSON.stringify(value)); process.kill(process.pid, 'SIGKILL'); };
  const target = writes => writes.find(write => phase.startsWith('admit') ? write.type === 'submission' && write.value.requestId === 'task' && write.value.status === 'placed' : phase.startsWith('abort') ? write.type === 'task' && write.value.abortRequested : phase.startsWith('stop') ? write.type === 'submission' && write.value.status === 'unanswered' && write.value.reason === 'aborted' : write.type === 'submission' && write.value.status === 'done');
  const injected = new Proxy(storage, { get(object, key) {
    const value = object[key];
    if (key === 'commit') return async (writes, context) => {
      const match = target(writes);
      if (match && phase.endsWith('before')) crash(match.value);
      const committed = await value.call(object, writes, context);
      if (match && phase.endsWith('after')) crash(match.value);
      return committed;
    };
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  const app = await openApplication(config, injected);
  await app.dispatch('session.create', { session_id: 'work', workspace: config.state_dir }, 'create');
  const receipt = await app.dispatch('input.submit', { session_id: 'work', request_id: 'task', text: 'Original task', context: [] }, 'send');
  if (phase.startsWith('abort') || phase.startsWith('stop')) await app.dispatch('run.stop', { session_id: 'work', submission_id: receipt.submission_id }, 'stop');
  if (phase.startsWith('final')) await app.dispatch('submission.wait', { session_id: 'work', request_id: 'task' }, 'wait');
  throw Error('Crash point was not reached');
}
if (phase) await childRun();
else {
  for (const stage of ['admit-before', 'admit-after', 'abort-before', 'abort-after', 'stop-before', 'stop-after', 'final-before', 'final-after']) {
    test(`process kill ${stage} preserves atomic admission and exact outcomes`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'harness-commit-crash-'));
      const config = { state_dir: directory, provider: 'faux', model: 'test', instructions: '' };
      const fixture = join(directory, 'response.json');
      await writeFile(fixture, JSON.stringify([fauxAssistantMessage(stage.startsWith('final') ? 'Exact final answer' : 'x'.repeat(1000))]));
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, HARNESS_CRASH_TEST_PHASE: stage, HARNESS_CRASH_TEST_CONFIG: JSON.stringify(config), HARNESS_FAUX_RESPONSES: fixture, HARNESS_FAUX_TOKENS_PER_SECOND: stage.startsWith('final') ? '100000' : '10' }, stdio: ['ignore', 'ignore', 'pipe'] });
      let diagnostics = ''; child.stderr.on('data', value => { diagnostics += value; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const [, signal] = await once(child, 'exit'); clearTimeout(timer);
      assert.equal(signal, 'SIGKILL', diagnostics);
      const marker = JSON.parse(await readFile(join(directory, 'crash.json')));
      process.env.HARNESS_FAUX_RESPONSES = fixture; process.env.HARNESS_FAUX_TOKENS_PER_SECOND = '1000000';
      const app = await openApplication(config);
      t.after(async () => { await app.close(); delete process.env.HARNESS_FAUX_RESPONSES; delete process.env.HARNESS_FAUX_TOKENS_PER_SECOND; await rm(directory, { recursive: true, force: true }); });
      const run = (method, params) => app.dispatch(method, params, method);
      if (stage === 'admit-before') {
        await assert.rejects(run('submission.get', { session_id: 'work', request_id: 'task' }), error => error.data?.kind === 'not_found');
        const history = await run('transcript.list', { session_id: 'work' }); assert.equal(history.items.filter(e => e.kind === 'user').length, 0);
      } else {
        const record = await run('submission.get', { session_id: 'work', request_id: 'task' });
        if (stage.startsWith('admit') || stage.startsWith('final')) assert.equal(record.submission_id, String(marker.id));
        const retry = await run('input.submit', { session_id: 'work', request_id: 'task', text: 'Replacement must not run', context: [] });
        assert.equal(retry.submission_id, record.submission_id);
        if (stage.startsWith('abort') || stage.startsWith('stop')) {
          const result = await run('run.stop', { session_id: 'work', submission_id: record.submission_id }); assert.equal(result.reason, 'cancelled');
        } else if (stage.startsWith('final')) {
          const result = await run('submission.wait', { session_id: 'work', request_id: 'task', timeout_ms: 3000 }); assert.equal(result.status, 'done');
          if (stage === 'final-after') assert.equal(result.answer_entry_id, String(marker.answer));
          assert.equal((await run('entry.read', { session_id: 'work', entry_id: result.answer_entry_id })).text, 'Exact final answer');
        } else await run('run.stop', { session_id: 'work', submission_id: record.submission_id });
        const history = await run('transcript.list', { session_id: 'work' }); assert.deepEqual(history.items.filter(e => e.kind === 'user').map(e => e.text), ['Original task']);
      }
    });
  }
}
