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
import { readRecords } from './fixtures/records.mjs';

const execute = promisify(execFile), binary = resolve(process.env.HARNESS_BINARY ?? 'target/debug/harness');
const deadline = async (check, message, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(15); }
  throw Error(`Timed out: ${message}`);
};
const activeProcess = async pid => {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    // A zombie leader can still have threads that hold its shared storage descriptor.
    return fields[0] !== 'Z' || fields[17] !== '1';
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
};
const signal = (pid, name) => { try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
async function rpc(socketPath) {
  const socket = connect(socketPath); await once(socket, 'connect');
  let counter = 0, ended = false; const pending = new Map();
  const close = () => { ended = true; for (const item of pending.values()) item.reject(Error('Disconnected')); pending.clear(); };
  readRecords(socket, record => {
    if (record.method) return;
    const waiter = pending.get(record.id); pending.delete(record.id); waiter?.resolve(record);
  }, close);
  socket.on('close', close);
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
  return { socket, raw, call, get ended() { return ended; } };
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

test('exit observation waits for surviving threads to release their file lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-thread-exit-')), lock = join(directory, 'owner.lock');
  const child = spawn('python3', ['-c', `
import ctypes, fcntl, os, sys, threading
lock = open(sys.argv[1], 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
threading.Thread(target=lambda: (os.read(0, 1), os._exit(0))).start()
ctypes.CDLL(None).pthread_exit(None)
`, lock], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(directory, { recursive: true, force: true });
  });
  await deadline(async () => /\) Z /.test(await readFile(`/proc/${child.pid}/stat`, 'utf8')), 'zombie leader with surviving thread');
  assert.equal(await activeProcess(child.pid), true, 'A remaining thread still owns the process file descriptors');
  const acquire = ['-c', "import fcntl,sys; file=open(sys.argv[1]); fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)", lock];
  await assert.rejects(execute('python3', acquire), error => error.code === 1 && error.stderr.includes('BlockingIOError'));
  child.stdin.end('x');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(await activeProcess(child.pid), false);
  await execute('python3', acquire);
});

const delegate = id => `set -eu
"$HARNESS_EXECUTABLE" --socket "$HARNESS_SOCKET" session create --id ${id} --workspace "$PWD" > ${id}.json
printf 'Task for ${id}' | "$HARNESS_EXECUTABLE" --socket "$HARNESS_SOCKET" send --session ${id} --request-id task --stdin
"$HARNESS_EXECUTABLE" --socket "$HARNESS_SOCKET" wait --session ${id} --request-id task --text > ${id}-answer.txt`;

test('real Bash creates nested children through the standard client with separate histories', async t => {
  const messages = [
    fauxAssistantMessage(fauxToolCall('bash', { command: delegate('child') }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: delegate('grandchild') }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Grandchild result'), fauxAssistantMessage('Child result'), fauxAssistantMessage('Parent result'),
  ];
  const service = await system(t, messages);
  // The faux fixture must also work when the first chat is configured after server startup.
  await writeFile(service.config, JSON.stringify({ state_dir: service.state, socket_path: service.socket }));
  let server = await service.start(), client = await service.client();
  const empty = await create(client, service, 'parent'); assert.equal(empty.model, null);
  await client.call('session.configure', { session_id: 'parent', provider: 'faux', model: 'test', instructions: 'Preserve user changes' });
  await client.call('input.submit', input('parent', 'task'));
  const result = await client.call('submission.wait', { session_id: 'parent', request_id: 'task', timeout_ms: 10000 }, 12000);
  assert.equal(result.status, 'done');
  assert.equal((await client.call('entry.read', { session_id: 'parent', entry_id: result.answer_entry_id })).text, 'Parent result');
  assert.equal(await readFile(join(service.workspace, 'child-answer.txt'), 'utf8'), 'Child result');
  assert.equal(await readFile(join(service.workspace, 'grandchild-answer.txt'), 'utf8'), 'Grandchild result');
  for (const [id, parent] of [['child', 'parent'], ['grandchild', 'child']]) {
    const created = JSON.parse(await readFile(join(service.workspace, `${id}.json`), 'utf8'));
    assert.equal(created.parent_session_id, parent); assert.equal(created.instructions, 'Preserve user changes');
    const history = await client.call('transcript.list', { session_id: id });
    assert.deepEqual(history.items.filter(item => item.kind === 'user').map(item => item.text), [`Task for ${id}`]);
  }
  const hierarchy = (await client.call('session.list', { workspace: service.workspace })).items;
  assert.deepEqual(hierarchy.map(item => [item.session_id, item.parent_session_id]), [['child', 'parent'], ['grandchild', 'child'], ['parent', null]]);
  await client.call('server.shutdown'); await server.exited;
  server = await service.start(); client = await service.client();
  assert.deepEqual((await client.call('session.list', { workspace: service.workspace })).items, hierarchy);
  await client.call('server.shutdown'); await server.exited;
});

test('stopping a parent Bash wait keeps its independently admitted child active', async t => {
  const service = await system(t, [
    fauxAssistantMessage(fauxToolCall('bash', { command: delegate('child') }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 30' }), { stopReason: 'toolUse' }),
  ]);
  const server = await service.start(), client = await service.client();
  await create(client, service, 'parent');
  const parent = await client.call('input.submit', input('parent', 'task'));
  const child = await deadline(async () => {
    try { const value = await client.call('submission.get', { session_id: 'child', request_id: 'task' }); return value.status === 'accepted' ? value : false; }
    catch (error) { if (error.data?.kind === 'not_found') return false; throw error; }
  }, 'child admission');
  assert.equal((await client.call('run.stop', { session_id: 'parent', submission_id: parent.submission_id })).reason, 'cancelled');
  assert.equal((await client.call('submission.get', { session_id: 'child', request_id: 'task' })).status, 'accepted');
  assert.equal((await client.call('session.get', { session_id: 'child' })).session.parent_session_id, 'parent');
  await client.call('run.stop', { session_id: 'child', submission_id: child.submission_id });
  await client.call('server.shutdown'); await server.exited;
});

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
