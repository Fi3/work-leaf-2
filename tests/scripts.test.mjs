import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { readRecords } from './fixtures/records.mjs';

const executable = resolve(process.env.HARNESS_TEST_BINARY ?? 'target/debug/harness');
const credential = 'test-provider-secret-DO-NOT-PRINT';

function command(args, env, input = '') {
  const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function fixture(t, messages, tokens = 100000) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-scripts-'));
  const workspace = join(directory, 'work'), state = join(directory, 'state');
  await mkdir(workspace); await mkdir(state);
  const socket = join(directory, 'control.sock'), config = join(directory, 'config.json');
  const responses = join(directory, 'responses.json');
  await writeFile(responses, JSON.stringify(messages));
  await writeFile(config, JSON.stringify({ provider: 'faux', model: 'test', instructions: 'Test agent.', state_dir: state, socket_path: socket }));
  const env = { ...process.env, XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory, HARNESS_FAUX_RESPONSES: responses,
    HARNESS_FAUX_TOKENS_PER_SECOND: String(tokens), ANTHROPIC_API_KEY: credential };
  let server, exit, diagnostics = '';
  const cli = (args, input) => command([...args, '--socket', socket], env, input);
  async function checked(args, input, code = 0) {
    const result = await cli(args, input);
    assert.equal(result.code, code, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(!result.stderr.includes(credential));
    return result.stdout;
  }
  async function json(args, input, code = 0) { return JSON.parse(await checked(args, input, code)); }
  async function start() {
    server = spawn(executable, ['serve', '--config', config], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.setEncoding('utf8'); server.stderr.on('data', value => { diagnostics += value; });
    exit = once(server, 'exit');
    for (let count = 0; count < 200; count++) {
      const result = await cli(['status']);
      if (result.code === 0 && JSON.parse(result.stdout).storage_ready) return;
      if (server.exitCode !== null) throw Error(`Server exited: ${diagnostics}`);
      await delay(25);
    }
    throw Error(`Server did not become ready: ${diagnostics}`);
  }
  async function stopServer() {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const finished = await Promise.race([exit.then(() => true), delay(5000, false, { ref: false })]);
      if (!finished) { server.kill('SIGKILL'); await exit; assert.fail('Server did not complete administrative exit'); }
    }
  }
  t.after(async () => { await stopServer(); await rm(directory, { recursive: true, force: true }); });
  await start();
  const create = id => json(['session', 'create', '--id', id, '--workspace', workspace]);
  const send = (session, request, text = 'Task') => json(['send', '--session', session, '--request-id', request, '--stdin'], text);
  const wait = (session, request, code = 0) => json(['wait', '--session', session, '--request-id', request, '--timeout-ms', '10000'], '', code);
  const stop = (session, submission) => json(['stop', '--session', session, '--submission-id', submission]);
  async function rpc(method, params) {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'script-request', method, params }) + '\n';
    const result = JSON.parse(await checked(['rpc'], line));
    assert.equal(result.id, 'script-request');
    if (result.error) throw Object.assign(Error(result.error.message), result.error);
    return result.result;
  }
  async function workerPid() {
    const children = await readFile(`/proc/${server.pid}/task/${server.pid}/children`, 'utf8');
    assert.equal(children.trim().split(/\s+/).length, 1, 'One worker must own storage');
    return Number(children.trim());
  }
  async function restartWorker() {
    const previous = await workerPid(); process.kill(previous, 'SIGKILL');
    for (let count = 0; count < 200; count++) {
      const status = await cli(['status']);
      const next = await readFile(`/proc/${server.pid}/task/${server.pid}/children`, 'utf8');
      if (next.trim() && Number(next.trim()) !== previous && status.code === 0 && JSON.parse(status.stdout).ready) return;
      await delay(25);
    }
    assert.fail('Worker did not recover');
  }
  return { directory, workspace, state, socket, config, env, cli, checked, json, start, stopServer, create, send, wait, stop, rpc, restartWorker, diagnostics: () => diagnostics };
}

test('standalone scripts use actual Pi tools, full answer text, and idle startup without a generation call', { timeout: 30000 }, async t => {
  const answer = '\u00e9\u4e16\u754c🙂\n'.repeat(12000);
  const app = await fixture(t, [
    fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'Tool result\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(answer),
  ], 0);
  const hello = await app.json(['start', '--config', app.config]);
  assert.equal(hello.ready, true);
  await app.create('work'); await delay(100);
  const idle = await app.rpc('session.get', { session_id: 'work' });
  assert.equal(idle.snapshot.state, 'idle'); assert.equal(idle.snapshot.entries.length, 0);
  const listed = await app.json(['session', 'list']); assert.equal(listed.items[0].session_id, 'work');
  const receipt = await app.send('work', 'task_1', 'Write the result file and answer.');
  assert.equal(receipt.status, 'accepted');
  const text = await app.checked(['wait', '--session', 'work', '--request-id', 'task_1', '--timeout-ms', '10000', '--text']);
  assert.equal(text, answer);
  assert.equal(await readFile(join(app.workspace, 'result.txt'), 'utf8'), 'Tool result\n');
  const done = await app.wait('work', 'task_1'); assert.equal(done.status, 'done');
  const state = await app.rpc('session.get', { session_id: 'work' });
  assert.equal(state.snapshot.assistant.truncated, true);
  assert.ok(state.snapshot.entries.some(entry => entry.kind === 'tool' && entry.text.includes('write')));
  const publicData = JSON.stringify({ hello, listed, receipt, done, state });
  assert.ok(!publicData.includes(credential)); assert.ok(!app.diagnostics().includes(credential));
  for (const file of await readdir(join(app.state, 'logs'))) {
    assert.ok(!(await readFile(join(app.state, 'logs', file), 'utf8')).includes(credential));
  }
  await app.checked(['shutdown']);
});

test('duplicate receipts survive actual worker and server restart and preserve original input', { timeout: 30000 }, async t => {
  const app = await fixture(t, [fauxAssistantMessage('Long answer '.repeat(1000))], 10);
  await app.create('work');
  const original = await app.send('work', 'same', 'Original input');
  await app.checked(['wait', '--session', 'work', '--request-id', 'same', '--timeout-ms', '1'], '', 4);
  assert.equal((await app.rpc('submission.get', { session_id: 'work', request_id: 'same' })).status, 'accepted');
  await app.restartWorker();
  assert.equal((await app.send('work', 'same', 'Replacement after worker crash')).submission_id, original.submission_id);
  const oldInstance = (await app.json(['status'])).instance_id;
  await app.stopServer(); await app.start();
  assert.notEqual((await app.json(['status'])).instance_id, oldInstance);
  assert.equal((await app.send('work', 'same', 'Replacement after server restart')).submission_id, original.submission_id);
  const history = await app.rpc('transcript.list', { session_id: 'work' });
  assert.deepEqual(history.items.filter(entry => entry.kind === 'user').map(entry => entry.text), ['Original input']);
  const stopped = await app.stop('work', original.submission_id); assert.equal(stopped.reason, 'cancelled');
  await app.restartWorker();
  assert.deepEqual(await app.wait('work', 'same', 5), stopped);
  const next = await app.send('work', 'next');
  assert.deepEqual(await app.stop('work', original.submission_id), stopped);
  assert.equal((await app.rpc('submission.get', { session_id: 'work', request_id: 'next' })).status, 'accepted');
  await app.stop('work', next.submission_id);
});

test('actual watch streams and proxy EOF preserve admitted work and drain an outstanding wait', { timeout: 30000 }, async t => {
  const app = await fixture(t, [fauxAssistantMessage('Streaming '.repeat(1000))], 100);
  await app.create('work');
  const watch = spawn(executable, ['watch', '--session', 'work', '--socket', app.socket], { env: app.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(watch, 'exit'), records = [];
  readRecords(watch.stdout, record => records.push(record));
  t.after(async () => { if (watch.exitCode === null && watch.signalCode === null) { watch.kill('SIGINT'); await exit; } });
  for (let count = 0; count < 100 && !records.length; count++) await delay(10);
  assert.equal(records[0].snapshot.state, 'idle');
  const receipt = await app.rpc('input.submit', { session_id: 'work', request_id: 'proxy', text: 'Continue after proxy EOF', context: [] });
  for (let count = 0; count < 100 && !records.some(record => record.params?.snapshot?.state === 'running'); count++) await delay(10);
  assert.ok(records.some(record => record.params?.snapshot?.state === 'running'));
  assert.equal((await app.rpc('submission.get', { session_id: 'work', request_id: 'proxy' })).status, 'accepted');
  const input = [
    { jsonrpc: '2.0', id: 'waiting', method: 'submission.wait', params: { session_id: 'work', request_id: 'proxy', timeout_ms: 5000 } },
    { jsonrpc: '2.0', id: 'stopping', method: 'run.stop', params: { session_id: 'work', submission_id: receipt.submission_id } },
  ].map(value => JSON.stringify(value) + '\n').join('');
  const output = await app.checked(['rpc'], input);
  const results = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(new Set(results.map(value => value.id)), new Set(['waiting', 'stopping']));
  assert.ok(results.every(value => value.result.reason === 'cancelled'));
  for (let count = 0; count < 100 && records.at(-1)?.params?.snapshot?.state !== 'idle'; count++) await delay(10);
  assert.equal(records.at(-1).params.snapshot.state, 'idle');
  watch.kill('SIGINT'); assert.equal((await exit)[0], 130);
  await app.checked(['shutdown']);
});
