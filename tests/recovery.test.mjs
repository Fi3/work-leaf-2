import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SessionDoc } from '../adapter/pi.mjs';

const execute = promisify(execFile), binary = resolve(process.env.HARNESS_BINARY ?? 'target/debug/harness');
const deadline = async (check, message, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(15); }
  throw Error(`Timed out: ${message}`);
};
const activeProcess = async pid => {
  try { const value = await readFile(`/proc/${pid}/stat`, 'utf8'); return !value.includes(') Z '); } catch { return false; }
};
const signal = (pid, name) => { try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
async function rpc(socketPath) {
  const socket = connect(socketPath); await once(socket, 'connect');
  let data = '', counter = 0, ended = false; const pending = new Map(), notices = [];
  socket.setEncoding('utf8'); socket.on('data', part => {
    data += part; let index;
    while ((index = data.indexOf('\n')) >= 0) {
      const record = JSON.parse(data.slice(0, index)); data = data.slice(index + 1);
      if (record.method) notices.push(record); else { const waiter = pending.get(record.id); pending.delete(record.id); waiter?.resolve(record); }
    }
  });
  const close = () => { ended = true; for (const item of pending.values()) item.reject(Error('Disconnected')); pending.clear(); };
  socket.on('close', close); socket.on('error', close);
  function raw(method, params = {}, timeout = 8000) {
    if (ended) return Promise.reject(Error('Disconnected'));
    const id = `r${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, timeout);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function call(method, params, timeout) { const record = await raw(method, params, timeout); if (record.error) throw Object.assign(Error(record.error.message), record.error); return record.result; }
  await call('system.hello', { api_version: 1 });
  return { socket, raw, call, notices, get ended() { return ended; } };
}
async function system(t, messages, tokens = 100000) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-recovery-'));
  const state = join(directory, 'state'), workspace = join(directory, 'work'), socket = join(directory, 's.sock'), config = join(directory, 'config.json'), responses = join(directory, 'responses.json');
  await mkdir(state); await mkdir(workspace);
  await writeFile(config, JSON.stringify({ provider: 'faux', model: 'test', state_dir: state, socket_path: socket }));
  await writeFile(responses, JSON.stringify(messages));
  const environment = { ...process.env, HARNESS_FAUX_RESPONSES: responses, HARNESS_FAUX_TOKENS_PER_SECOND: String(tokens) };
  const children = [], clients = [];
  const service = { directory, state, workspace, socket, config, responses, environment, children,
    async start() {
      const child = spawn(binary, ['serve', '--config', config], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.exited = once(child, 'exit');
      let errors = ''; child.stderr.on('data', value => { errors += value; }); child.stdout.resume();
      await deadline(async () => {
        try { const connection = await rpc(socket); const hello = await connection.call('system.hello', { api_version: 1 }); connection.socket.destroy(); return hello.storage_ready; } catch { if (child.exitCode !== null) throw Error(`Server exited: ${errors}`); return false; }
      }, 'server readiness'); return child;
    },
    async client() { const client = await rpc(socket); clients.push(client); return client; },
    async worker(server) { return deadline(async () => { try { const ids = (await readFile(`/proc/${server.pid}/task/${server.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); for (const id of ids) { const cmd = await readFile(`/proc/${id}/cmdline`, 'utf8').catch(() => ''); if (cmd.includes('worker.mjs')) return id; } } catch {} return false; }, 'worker process'); },
    async stop(server, name = 'SIGTERM') { const exiting = server.exited ?? once(server, 'exit'); server.kill(name); await exiting; },
  };
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([child.exited ?? once(child, 'exit'), delay(6000, undefined, {ref:false})]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    await rm(directory, { recursive: true, force: true });
  });
  return service;
}
const input = (session_id, request_id) => ({ session_id, request_id, text: 'Run the task', context: [] });
const create = (client, service, id = 'work') => client.call('session.create', { session_id: id, workspace: service.workspace });

for (const target of ['worker', 'server']) test(`${target} SIGKILL cleans ordinary bash descendants and recovers without repeating the unsafe call`, async t => {
  const messages = [fauxAssistantMessage(fauxToolCall('bash', { command: 'echo $$ > shell.pid; sleep 30 & echo $! > child.pid; echo effect >> effects; wait' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Finished')];
  const service = await system(t, messages); let server = await service.start(), client = await service.client();
  await create(client, service); const receipt = await client.call('input.submit', input('work', 'run'));
  const shell = await deadline(async () => { try { return Number(await readFile(join(service.workspace, 'shell.pid'), 'utf8')); } catch { return false; } }, 'bash start');
  const descendant = Number(await readFile(join(service.workspace, 'child.pid'), 'utf8'));
  const worker = await service.worker(server);
  // Recovered Pi receives only the final answer. It must not rerun the committed unsafe intent.
  await writeFile(service.responses, JSON.stringify([fauxAssistantMessage('Recovered answer')]));
  if (target === 'server') { await service.stop(server, 'SIGKILL'); await deadline(async () => !(await activeProcess(worker)), 'orphan worker EOF cleanup'); server = await service.start(); }
  else signal(worker, 'SIGKILL');
  await deadline(async () => !(await activeProcess(shell)) && !(await activeProcess(descendant)), 'shell cleanup');
  client = await service.client();
  const result = await deadline(async () => { try { const value = await client.call('submission.get', { session_id: 'work', request_id: 'run' }); return value.status === 'done' ? value : false; } catch (error) { if (error.data?.kind === 'not_ready') return false; throw error; } }, 'recovered answer');
  assert.equal(result.submission_id, receipt.submission_id);
  assert.equal(await readFile(join(service.workspace, 'effects'), 'utf8'), 'effect\n');
  const history = await client.call('transcript.list', { session_id: 'work' }); assert.ok(history.items.some(item => item.kind === 'tool' && item.text.includes('interrupted')));
  assert.equal((await client.call('entry.read', { session_id: 'work', entry_id: result.answer_entry_id })).text, 'Recovered answer');
  await client.call('server.shutdown'); await server.exited;
});

test('orphan actual Pi worker holds the database lock until it exits', async t => {
  const service = await system(t, [fauxAssistantMessage('x'.repeat(2000))], 10), server = await service.start(), client = await service.client();
  await create(client, service); const receipt = await client.call('input.submit', input('work', 'run'));
  const worker = await service.worker(server); signal(worker, 'SIGSTOP');
  t.after(() => signal(worker, 'SIGKILL'));
  const endpoint = await stat(service.socket);
  await service.stop(server, 'SIGKILL');
  await assert.rejects(execute(binary, ['serve', '--config', service.config], { env: service.environment, timeout: 2000 }), error => error.code === 6 && error.stderr.includes('owns this state directory'));
  assert.equal((await stat(service.socket)).ino, endpoint.ino, 'Rejected server must preserve the owned endpoint');
  signal(worker, 'SIGCONT');
  await deadline(async () => !(await activeProcess(worker)), 'worker cleanup after parent EOF');
  const replacement = await service.start(), next = await service.client();
  assert.equal((await next.call('submission.get', { session_id: 'work', request_id: 'run' })).submission_id, receipt.submission_id);
  assert.equal((await next.call('session.get', {session_id:'work'})).snapshot.state, 'recovering');
  await next.call('run.stop', { session_id: 'work', submission_id: receipt.submission_id }); await next.call('server.shutdown'); await replacement.exited;
});

test('stopped targets remain stopped across server restart and do not stop a later run', async t => {
  const service = await system(t, [fauxAssistantMessage('x'.repeat(2000))], 10); let server = await service.start(), client = await service.client();
  await create(client, service); const first = await client.call('input.submit', input('work', 'first'));
  const stopped = await client.call('run.stop', { session_id: 'work', submission_id: first.submission_id }); assert.equal(stopped.reason, 'cancelled');
  const oldWorker = await service.worker(server);
  await service.stop(server, 'SIGKILL');
  await deadline(async () => !(await activeProcess(oldWorker)), 'old worker storage close');
  server = await service.start(); client = await service.client();
  assert.deepEqual(await client.call('input.submit', input('work', 'first')), stopped);
  const second = await client.call('input.submit', input('work', 'second'));
  assert.deepEqual(await client.call('run.stop', { session_id: 'work', submission_id: first.submission_id }), stopped);
  assert.equal((await client.call('submission.get', { session_id: 'work', request_id: 'second' })).status, 'accepted');
  await client.call('run.stop', { session_id: 'work', submission_id: second.submission_id }); await client.call('server.shutdown'); await server.exited;
});

async function changeStoredModel(state, model) {
  const models = createModels(), faux = fauxProvider({ models: [{ id: 'test' }] }); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(CodingTools);
  const harness = await Harness.open(await openNodeSqliteStorage(join(state, 'agent.sqlite')), { models, registry }, context);
  const page = await harness.commit(tx => tx.scanConversations({}, 100), context);
  for (const item of page.items) { const metadata = await harness.snapshot(SessionDoc, item.id, context); if (metadata?.session_id === 'work') await harness.commit(async tx => { (await tx.doc(SessionDoc, item.id)).model = model; }, context); }
  await harness.close(context);
}

test('global blocked preflight permits terminal reads and rejects every operation that can resume pending work', async t => {
  const service = await system(t, [fauxAssistantMessage('Done'), fauxAssistantMessage('x'.repeat(2000))], 1000); let server = await service.start(), client = await service.client();
  await create(client, service);
  await client.call('input.submit', input('work', 'done')); const done = await client.call('submission.wait', { session_id: 'work', request_id: 'done' });
  const pending = await client.call('input.submit', input('work', 'pending')); await service.stop(server);
  await changeStoredModel(service.state, 'missing-model');
  server = await service.start(); client = await service.client();
  const hello = await client.call('system.hello', { api_version: 1 }); assert.equal(hello.storage_ready, true); assert.equal(hello.ready, false);
  assert.deepEqual(await client.call('submission.wait', { session_id: 'work', request_id: 'done' }), done);
  assert.deepEqual(await client.call('run.stop', { session_id: 'work', submission_id: done.submission_id }), done);
  assert.equal((await client.call('input.submit', input('work', 'pending'))).submission_id, pending.submission_id);
  for (const [method, params] of [['input.submit', input('work', 'new')], ['submission.wait', { session_id: 'work', request_id: 'pending' }], ['run.stop', { session_id: 'work', submission_id: pending.submission_id }]]) {
    await assert.rejects(client.call(method, params), error => error.data?.kind === 'not_ready');
  }
  const watch = await client.call('session.watch', { session_id: 'work' }); assert.equal(watch.snapshot.state, 'blocked');
  const controller = await service.client();
  await controller.call('server.restart_worker');
  await deadline(() => client.ended, 'old watch disconnection');
  client = controller;
  assert.equal((await client.call('system.hello', { api_version: 1 })).ready, false);
  await service.stop(server); await changeStoredModel(service.state, 'test');
  await writeFile(service.responses, JSON.stringify([fauxAssistantMessage('Recovered')]));
  server = await service.start(); client = await service.client();
  assert.equal((await client.call('submission.wait', { session_id: 'work', request_id: 'pending' })).status, 'done');
  await client.call('server.shutdown'); await server.exited;
});

test('shutdown admission race has either a stored input or an idle closed server', async t => {
  for (let iteration = 0; iteration < 4; iteration++) {
    const service = await system(t, [fauxAssistantMessage('x'.repeat(2000))], 10), server = await service.start();
    const first = await service.client(), second = await service.client(); await create(first, service);
    const [shutdown, admission] = await Promise.allSettled([first.raw('server.shutdown'), second.raw('input.submit', input('work', 'race'))]);
    const shutdownSuccess = shutdown.status === 'fulfilled' && shutdown.value.result;
    const admitted = admission.status === 'fulfilled' && admission.value.result;
    assert.ok(!(shutdownSuccess && admitted), 'Shutdown succeeded while a new run was admitted');
    if (admitted) { const client = await service.client(); assert.equal((await client.call('submission.get', { session_id: 'work', request_id: 'race' })).submission_id, admitted.submission_id); await client.call('run.stop', { session_id: 'work', submission_id: admitted.submission_id }); await client.call('server.shutdown'); }
    await server.exited;
  }
});

test('unsafe storage endpoint never reports readiness or admission', async t => {
  const service = await system(t, [fauxAssistantMessage('unused')]);
  const target = join(service.directory, 'preserve'); await writeFile(target, 'preserve'); await symlink(target, join(service.state, 'agent.sqlite'));
  const server = spawn(binary, ['serve', '--config', service.config], { env: service.environment, stdio: 'ignore' }); service.children.push(server); server.exited = once(server, 'exit');
  const client = await deadline(async () => { try { return await service.client(); } catch { return false; } }, 'socket open');
  await delay(400);
  assert.equal((await client.call('system.hello', { api_version: 1 })).storage_ready, false);
  await assert.rejects(create(client, service), error => error.data?.kind === 'not_ready');
  assert.equal(await readFile(target, 'utf8'), 'preserve'); await service.stop(server);
});

test('start retries after an orphan worker releases storage ownership', async t => {
  const service = await system(t, [fauxAssistantMessage('x'.repeat(2000))], 10);
  const hook = join(service.directory, 'delay-close.mjs');
  await writeFile(hook, "process.stdin.on('end', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800));\n");
  service.environment.NODE_OPTIONS = `--import=${hook}`;
  const server = await service.start(), client = await service.client();
  await create(client, service); const receipt = await client.call('input.submit', input('work', 'pending'));
  const orphan = await service.worker(server); await service.stop(server, 'SIGKILL');
  assert.ok(await activeProcess(orphan), 'The test must hold the old storage owner during startup');
  const started = await execute(binary, ['start', '--config', service.config], { env: service.environment, timeout: 12000 });
  assert.equal(JSON.parse(started.stdout).storage_ready, true);
  const servers = [];
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
    const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
    if (command.includes(service.state) && command.includes('serve')) servers.push(Number(name));
  }
  assert.equal(servers.length, 1); t.after(() => signal(servers[0], 'SIGTERM'));
  assert.equal(await activeProcess(orphan), false);
  const connection = await service.client();
  assert.equal((await connection.call('submission.get', {session_id:'work',request_id:'pending'})).submission_id, receipt.submission_id);
  const children = (await readFile(`/proc/${servers[0]}/task/${servers[0]}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  assert.equal(children.length, 1);
  await connection.call('run.stop',{session_id:'work',submission_id:receipt.submission_id});
  await connection.call('server.shutdown'); await deadline(async()=>!(await activeProcess(servers[0])),'detached server shutdown');
});
