import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openApplication } from '../pi.mjs';
import { readRecords } from '../../tests/fixtures/records.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-worker-'));
  const state_dir = join(directory, 'state'); await mkdir(state_dir);
  const workspace = join(directory, 'work'); await mkdir(workspace);
  const path = join(directory, 'response.json'); await writeFile(path, JSON.stringify([fauxAssistantMessage('abcdef'.repeat(500))]));
  const config = { state_dir, provider: 'faux', model: 'test', instructions: '' };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { config, workspace, path, directory };
}
function start(t, fixture) {
  const fd = openSync(join(fixture.config.state_dir, 'owner.lock'), 'a+', 0o600);
  const child = spawn(process.execPath, ['adapter/worker.mjs'], { env: { ...process.env, HARNESS_CONFIG: JSON.stringify(fixture.config), HARNESS_LOCK_FD: '3', HARNESS_FAUX_RESPONSES: fixture.path, HARNESS_FAUX_TOKENS_PER_SECOND: String(fixture.tokens ?? 20) }, stdio: ['pipe', 'pipe', 'pipe', fd] });
  closeSync(fd); let sequence = 0, stderr = '', unclaimed = 0; const pending = new Map();
  child.stderr.on('data', data => { stderr += data; });
  readRecords(child.stdout, value => {
    if (value.method) return;
    const request = pending.get(value.id); pending.delete(value.id);
    if (request) request.resolve(value); else unclaimed++;
  });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } });
  function request(method, params, fragments = false) {
    const id = `c${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Timed out: ${method}; ${stderr}`)), 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      if (fragments) { for (const byte of Buffer.from(line)) child.stdin.write(Buffer.from([byte])); } else child.stdin.write(line);
    });
  }
  return { child, request, exit, unclaimed: () => unclaimed };
}

test('actual worker parses split UTF-8, handles concurrent wait and stop, and preserves stop across process kill', async t => {
  const data = await fixture(t); let worker = start(t, data);
  assert.equal((await worker.request('system.hello', { api_version: 1 }, true)).result.node_version, process.version);
  await worker.request('session.create', { session_id: 'work', workspace: data.workspace });
  const receipt = (await worker.request('input.submit', { session_id: 'work', request_id: 'task', text: 'λ世界😀', context: [] }, true)).result;
  const waiting = worker.request('submission.wait', { session_id: 'work', request_id: 'task', timeout_ms: 4000 });
  const result = (await worker.request('run.stop', { session_id: 'work', submission_id: receipt.submission_id })).result;
  assert.equal(result.reason, 'cancelled'); assert.deepEqual((await waiting).result, result);
  worker.child.kill('SIGKILL'); await worker.exit;
  worker = start(t, data); await worker.request('system.hello', { api_version: 1 });
  assert.deepEqual((await worker.request('input.submit', { session_id: 'work', request_id: 'task', text: 'replacement', context: [] })).result, result);
  await worker.request('worker.shutdown', {}); await worker.exit;
});

test('parent EOF preserves an admitted run for recovery', async t => {
  const data = await fixture(t); let worker = start(t, data);
  await worker.request('system.hello', { api_version: 1 }); await worker.request('session.create', { session_id: 'work', workspace: data.workspace });
  const receipt = (await worker.request('input.submit', { session_id: 'work', request_id: 'task', text: 'Continue', context: [] })).result;
  worker.child.stdin.end(); await worker.exit;
  worker = start(t, data); await worker.request('system.hello', { api_version: 1 });
  const state = (await worker.request('submission.get', { session_id: 'work', request_id: 'task' })).result;
  assert.equal(state.status, 'accepted'); assert.equal(state.submission_id, receipt.submission_id);
  await worker.request('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
  await worker.request('worker.shutdown', {}); await worker.exit;
});

test('database symbolic links are rejected before Pi opens storage', async t => {
  const data = await fixture(t), outside = join(data.directory, 'outside'); await writeFile(outside, 'preserve');
  await symlink(outside, join(data.config.state_dir, 'agent.sqlite'));
  await assert.rejects(openApplication(data.config), error => error.data?.kind === 'storage_error');
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
});

test('worker lifecycle checks keep active work during rejected idle shutdown', async t => {
  const data = await fixture(t), worker = start(t, data);
  await worker.request('system.hello', { api_version: 1 }); await worker.request('session.create', { session_id: 'work', workspace: data.workspace });
  const receipt = (await worker.request('input.submit', { session_id: 'work', request_id: 'task', text: 'Continue', context: [] })).result;
  const response = await worker.request('worker.shutdown', {}); assert.equal(response.error.data.kind, 'busy');
  assert.equal((await worker.request('submission.get', { session_id: 'work', request_id: 'task' })).result.status, 'accepted');
  await worker.request('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
  await worker.request('worker.shutdown', {}); await worker.exit;
});

test('worker output pressure preserves receipts, stop, and idle close replies', async t => {
  const data = await fixture(t); data.tokens = 10000000;
  await writeFile(data.path, JSON.stringify([fauxAssistantMessage('x'.repeat(8192)), fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 30'}),{stopReason:'toolUse'})]));
  const worker = start(t, data); await worker.request('system.hello', {api_version:1});
  await worker.request('session.create',{session_id:'work',workspace:data.workspace});
  await worker.request('input.submit',{session_id:'work',request_id:'answer',text:'Answer',context:[]});
  const result=(await worker.request('submission.wait',{session_id:'work',request_id:'answer'})).result;
  assert.equal(result.status,'done');
  const admitted=(await worker.request('input.submit',{session_id:'work',request_id:'active',text:'Wait',context:[]})).result;
  assert.equal(admitted.status,'accepted');
  worker.child.stdout.pause();
  const responses=Array.from({length:1024},()=>worker.request('entry.read',{session_id:'work',entry_id:result.answer_entry_id}));
  await delay(600);
  const duplicate=worker.request('input.submit',{session_id:'work',request_id:'active',text:'Replacement',context:[]});
  const stopping=worker.request('run.stop',{session_id:'work',submission_id:admitted.submission_id});
  worker.child.stdout.resume();
  const records=await Promise.all(responses);
  assert.ok(records.some(record=>record.error?.data?.kind==='resource_limit'));
  assert.ok(records.some(record=>record.result?.text.length===8192));
  assert.equal((await duplicate).result.submission_id,admitted.submission_id);
  assert.equal((await stopping).result.reason,'cancelled');
  assert.equal((await worker.request('submission.get',{session_id:'work',request_id:'active'})).result.reason,'cancelled');
  assert.equal((await worker.request('submission.get',{session_id:'work',request_id:'answer'})).result.status,'done');
  assert.equal(worker.child.exitCode,null);
  worker.child.stdout.pause();
  const closingReads=Array.from({length:1024},()=>worker.request('entry.read',{session_id:'work',entry_id:result.answer_entry_id}));
  await delay(600);
  const shutdown=worker.request('worker.shutdown',{});
  await delay(100); worker.child.stdout.resume();
  assert.deepEqual((await shutdown).result,{}); await Promise.all(closingReads); await worker.exit;
});

test('invalid private requests apply input backpressure until the parent drains replies', async t => {
  const data = await fixture(t), worker = start(t, data);
  await worker.request('system.hello', {api_version:1});
  worker.child.stdout.pause();
  let written = false;
  const writing = new Promise(resolve => worker.child.stdin.write('{}\n'.repeat(300000), () => { written = true; resolve(); }));
  await delay(700);
  assert.equal(written, false, 'The worker must stop reading before unbounded rejection replies accumulate');
  assert.equal(worker.child.exitCode, null);
  worker.child.stdout.resume(); await writing;
  assert.equal((await worker.request('system.hello', {api_version:1})).result.ready, true);
  assert.equal(worker.unclaimed(), 300000, 'All buffered records must be processed after output resumes');
  await worker.request('worker.shutdown', {}); await worker.exit;
});

test('large settings replies reserve output space before committing changes', async t => {
  const data = await fixture(t), instructions = 'x'.repeat(480000);
  const worker = start(t, data);
  await worker.request('system.hello', { api_version: 1 });
  await worker.request('session.create', { session_id: 'work', workspace: data.workspace });
  await worker.request('session.configure', { session_id: 'work', instructions });
  worker.child.stdout.pause();
  const pending = Array.from({ length: 32 }, (_, index) => worker.request('session.configure', { session_id: 'work', name: `Change ${index}` }));
  await delay(500); assert.equal(worker.child.exitCode, null);
  worker.child.stdout.resume();
  const results = await Promise.all(pending), accepted = results.filter(value => value.result);
  assert.ok(accepted.length > 0); assert.ok(results.some(value => value.error?.data?.kind === 'resource_limit'));
  for (const value of accepted) assert.equal(value.result.instructions, instructions);
  const current = (await worker.request('session.get', { session_id: 'work' })).result.session;
  assert.equal(current.name, accepted.at(-1).result.name);
  assert.deepEqual((await worker.request('session.configure', { session_id: 'work', name: current.name })).result, current);
  await worker.request('worker.shutdown', {}); await worker.exit;
});
