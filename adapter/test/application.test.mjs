import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openApplication, SessionDoc } from '../pi.mjs';

async function setup(t, messages, tokens = 100000) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-adapter-'));
  const state = join(directory, 'state'), workspace = join(directory, 'work'); await mkdir(state); await mkdir(workspace);
  process.env.HARNESS_FAUX_TOKENS_PER_SECOND = String(tokens);
  if (messages) { const file = join(directory, 'responses.json'); await writeFile(file, JSON.stringify(messages)); process.env.HARNESS_FAUX_RESPONSES = file; }
  else delete process.env.HARNESS_FAUX_RESPONSES;
  const config = { state_dir: state, provider: 'faux', model: 'test', instructions: '' };
  const app = await openApplication(config);
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); delete process.env.HARNESS_FAUX_RESPONSES; delete process.env.HARNESS_FAUX_TOKENS_PER_SECOND; });
  let sequence = 0;
  const call = (method, params = {}) => app.dispatch(method, params, `test_${++sequence}`, () => {});
  const create = id => call('session.create', { session_id: id, workspace });
  return { directory, state, workspace, config, app, call, create };
}
const input = (session_id, request_id, text = 'Task') => ({ session_id, request_id, text, context: [] });
const isKind = kind => error => error.data?.kind === kind;

test('atomic creation is idempotent and preserves fixed configuration after reopen', async t => {
  const { app, call, create, workspace, config } = await setup(t);
  const first = await create('work'); app.config.model = null;
  await assert.rejects(create('new'), {message:'Set provider and model before creating a session'});
  app.config.model = 'invalid-new-default';
  assert.deepEqual(await create('work'), first);
  await assert.rejects(call('session.create', { session_id: 'work', workspace: '/tmp' }), isKind('conflict'));
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  assert.deepEqual(await reopened.dispatch('session.create', { session_id: 'work', workspace }, 'reopen'), first);
  assert.equal((await reopened.dispatch('session.list', {}, 'list')).items.length, 1);
});

test('duplicate identifiers preserve input while busy and after restart; old stop cannot stop new work', async t => {
  const { app, call, create, config } = await setup(t, [fauxAssistantMessage('a'.repeat(1000))], 20);
  await create('work');
  const receipt = await call('input.submit', input('work', 'first', 'Original input'));
  const duplicate = await call('input.submit', input('work', 'first', 'Replacement input'));
  assert.equal(duplicate.submission_id, receipt.submission_id);
  await assert.rejects(call('input.submit', input('work', 'next')), isKind('busy'));
  const history = await call('transcript.list', { session_id: 'work' });
  assert.deepEqual(history.items.filter(e => e.kind === 'user').map(e => e.text), ['Original input']);
  await assert.rejects(call('submission.wait', { session_id: 'work', request_id: 'first', timeout_ms: 1 }), isKind('timeout'));
  assert.equal((await call('submission.get', { session_id: 'work', request_id: 'first' })).status, 'accepted');
  const stopped = await call('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
  assert.equal(stopped.reason, 'cancelled');
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const run = (method, params) => reopened.dispatch(method, params, method);
  assert.deepEqual(await run('input.submit', input('work', 'first', 'More replacement')), stopped);
  const next = await run('input.submit', input('work', 'next'));
  assert.deepEqual(await run('run.stop', { session_id: 'work', submission_id: receipt.submission_id }), stopped);
  assert.equal((await run('submission.get', { session_id: 'work', request_id: 'next' })).status, 'accepted');
  await run('run.stop', { session_id: 'work', submission_id: next.submission_id });
});

test('session admission permits concurrent input, creation, and consistent duplicate receipts', async t => {
  const { app, config, workspace } = await setup(t, [fauxAssistantMessage('a'.repeat(1000)), fauxAssistantMessage('b'.repeat(1000))], 20);
  await app.close();
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { openApplication } from ${JSON.stringify(new URL('../pi.mjs', import.meta.url).href)};
    const app = await openApplication(${JSON.stringify(config)});
    let sequence = 0;
    const call = (method, params) => app.dispatch(method, params, String(++sequence));
    const create = session_id => call('session.create', { session_id, workspace: ${JSON.stringify(workspace)} });
    const send = (session_id, text) => call('input.submit', { session_id, request_id: 'task', text, context: [] });
    try {
      await Promise.all([create('admission'), create('other')]);
      const [first, duplicate, other, created] = await Promise.all([
        send('admission', 'Original input'), send('admission', 'Replacement input'),
        send('other', 'Independent input'), create('new'),
      ]);
      assert.equal(first.status, 'accepted');
      assert.equal(duplicate.submission_id, first.submission_id);
      assert.equal(other.status, 'accepted');
      assert.notEqual(other.submission_id, first.submission_id);
      assert.equal(created.session_id, 'new');
      const history = await call('transcript.list', { session_id: 'admission' });
      assert.deepEqual(history.items.filter(entry => entry.kind === 'user').map(entry => entry.text), ['Original input']);
      const stopped = await Promise.all([first, other].map(receipt => call('run.stop', {
        session_id: receipt.session_id, submission_id: receipt.submission_id,
      })));
      assert.ok(stopped.every(result => result.reason === 'cancelled'));
      assert.deepEqual(await send('admission', 'Another replacement'), stopped[0]);
      assert.equal((await call('session.list', {})).items.length, 3);
    } finally { await app.close(); }
  `], { timeout: 5000, stdio: 'pipe' });
});

test('watches start with complete state and converge; full answer is available as byte chunks', async t => {
  const answer = 'λ世界😀'.repeat(2000);
  const { app, call, create } = await setup(t, [fauxAssistantMessage(answer)], 10000000);
  await create('work'); const records = [];
  const watch = await app.dispatch('session.watch', { session_id: 'work' }, 'watch', record => records.push(record));
  assert.equal(watch.result.snapshot.state, 'idle'); watch.start();
  await call('input.submit', input('work', 'large'));
  const result = await call('submission.wait', { session_id: 'work', request_id: 'large', timeout_ms: 10000 });
  await delay(10);
  assert.equal(result.status, 'done'); assert.equal(records.at(-1).params.snapshot.state, 'idle');
  assert.equal(records.at(-1).params.snapshot.assistant.truncated, true);
  let offset = 0, text = '';
  do { const part = await call('entry.read', { session_id: 'work', entry_id: result.answer_entry_id, offset, limit: 31 }); text += part.text; offset = part.next_offset; if (part.end) break; } while (true);
  assert.equal(text, answer);
  await call('session.unwatch', { watch_id: watch.result.watch_id });
  await call('session.unwatch', { watch_id: watch.result.watch_id });
});

test('explicit unsaved context is stored without changing disk and rejects escape through symbolic links', async t => {
  const { call, create, workspace, directory } = await setup(t);
  await create('work'); await writeFile(join(workspace, 'file.txt'), 'Disk text');
  const attachment = { kind: 'selection', path: 'file.txt', text: 'Unsaved text', modified: true, changedtick: 4, start_line: 2, end_line: 3 };
  await call('input.submit', { ...input('work', 'context'), context: [attachment] });
  await call('submission.wait', { session_id: 'work', request_id: 'context' });
  const history = await call('transcript.list', { session_id: 'work' });
  assert.match(history.items.find(item => item.kind === 'user').text, /Unsaved text/);
  assert.match(history.items.find(item => item.kind === 'user').text, /Tools use server files/);
  assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'Disk text');
  await writeFile(join(directory, 'outside'), 'outside'); await symlink(join(directory, 'outside'), join(workspace, 'link'));
  await assert.rejects(call('input.submit', { ...input('work', 'escape'), context: [{ ...attachment, path: 'link' }] }), { code: -32602 });
  await assert.rejects(call('submission.get', { session_id: 'work', request_id: 'escape' }), isKind('not_found'));
  await symlink(join(directory, 'missing'), join(workspace, 'dangling'));
  await assert.rejects(call('input.submit', { ...input('work', 'dangling'), context: [{ ...attachment, path: 'dangling' }] }), { code: -32602 });
  await call('input.submit', { ...input('work', 'newfile'), context: [{ ...attachment, path: 'new.txt' }] });
  await call('submission.wait', {session_id:'work',request_id:'newfile'});
});

test('global capacity is four sessions and duplicate receipts bypass new admission checks', async t => {
  const { app, call, create } = await setup(t, Array.from({ length: 5 }, () => fauxAssistantMessage('a'.repeat(1000))), 20);
  const receipts = [];
  for (let index = 0; index < 5; index++) await create(`s${index}`);
  for (let index = 0; index < 4; index++) receipts.push(await call('input.submit', input(`s${index}`, 'first')));
  await assert.rejects(call('input.submit', input('s4', 'first')), isKind('resource_limit'));
  app.sessions.get('s0').metadata = { ...app.sessions.get('s0').metadata, model: 'unavailable' };
  assert.equal((await call('input.submit', input('s0', 'first'))).submission_id, receipts[0].submission_id);
  await Promise.all(receipts.map((receipt, index) => call('run.stop', { session_id: `s${index}`, submission_id: receipt.submission_id })));
});

test('blocked recovery keeps shared scheduling paused for reads, duplicate inputs, waits, and stops', async t => {
  const { app, call, create, config } = await setup(t, [fauxAssistantMessage('a'.repeat(1000))], 20);
  await create('work'); const receipt = await call('input.submit', input('work', 'pending'));
  const session = app.sessions.get('work');
  await app.harness.commit(async tx => { (await tx.doc(SessionDoc, session.conversation.id)).model = 'missing'; }, context);
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const run = (method, params) => reopened.dispatch(method, params, method, () => {});
  assert.equal(reopened.hello().ready, false);
  assert.equal((await run('input.submit', input('work', 'pending'))).submission_id, receipt.submission_id);
  await assert.rejects(run('input.submit', input('work', 'new')), isKind('not_ready'));
  await assert.rejects(run('submission.wait', { session_id: 'work', request_id: 'pending' }), isKind('not_ready'));
  await assert.rejects(run('run.stop', { session_id: 'work', submission_id: receipt.submission_id }), isKind('not_ready'));
  const watch = await run('session.watch', { session_id: 'work' }); watch.start();
  assert.equal(watch.result.snapshot.state, 'blocked'); await delay(25);
  assert.equal((await reopened.harness.inspect(context)).scheduling, 'paused');
  await run('session.unwatch', { watch_id: watch.result.watch_id });
});

test('storage commit failure never returns false admission and committed metadata survives', async t => {
  const { app, config, workspace } = await setup(t); await app.close();
  let fail = false;
  const storage = await openNodeSqliteStorage(join(config.state_dir, 'agent.sqlite'));
  const faulty = new Proxy(storage, { get(target, key) { const value = target[key]; if (key === 'commit') return (...args) => fail ? Promise.reject(Error('injected storage failure')) : value.apply(target, args); return typeof value === 'function' ? value.bind(target) : value; } });
  const worker = await openApplication(config, faulty); t.after(() => worker.close().catch(() => {}));
  await worker.dispatch('session.create', { session_id: 'work', workspace }, 'create'); fail = true;
  await assert.rejects(worker.dispatch('input.submit', input('work', 'failed'), 'send'));
  assert.equal((await worker.harness.closed).reason, 'failed');
  const reopened = await openApplication(config); t.after(() => reopened.close());
  await assert.rejects(reopened.dispatch('submission.get', { session_id: 'work', request_id: 'failed' }, 'get'), isKind('not_found'));
  assert.equal((await reopened.dispatch('session.list', {}, 'list')).items.length, 1);
});

test('stop terminates built-in bash and its ordinary descendants', async t => {
  const { call, create, workspace } = await setup(t, [fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 30 & child=$!; echo $child > child.pid; wait' }), { stopReason: 'toolUse' })]);
  await create('work'); const receipt = await call('input.submit', input('work', 'shell'));
  let pid;
  for (let count = 0; count < 100 && !pid; count++) { try { pid = Number(await readFile(join(workspace, 'child.pid'), 'utf8')); } catch { await delay(10); } }
  assert.ok(pid > 0);
  const result = await call('run.stop', { session_id: 'work', submission_id: receipt.submission_id }); assert.equal(result.reason, 'cancelled');
  for (let count = 0; count < 100; count++) {
    try { const status = await readFile(`/proc/${pid}/stat`, 'utf8'); if (status.includes(') Z ')) return; } catch { return; }
    await delay(10);
  }
  assert.fail('Shell descendant remained active');
});

test('provider failure appears in the public snapshot without provider diagnostic text', async t => {
  const {call,create} = await setup(t,[fauxAssistantMessage('',{stopReason:'error',errorMessage:'SECRET_PROVIDER_DETAIL'})]);
  await create('work'); await call('input.submit',input('work','failure'));
  const result=await call('submission.wait',{session_id:'work',request_id:'failure',timeout_ms:3000});
  assert.equal(result.reason,'provider_error');
  const view=(await call('session.get',{session_id:'work'})).snapshot;
  assert.equal(view.error.kind,'provider_error'); assert.ok(!JSON.stringify(view).includes('SECRET_PROVIDER_DETAIL'));
});

test('large metadata and escaped transcript pages remain bounded and retain all items', async t => {
  const {app,call,create} = await setup(t); app.config.instructions='x'.repeat(500000);
  for(let index=0;index<10;index++) await create(`s${index}`);
  let position,found=[]; do { const page=await call('session.list',{limit:100,...(position?{cursor:position}:{})}); assert.ok(Buffer.byteLength(JSON.stringify(page))<4194304); found.push(...page.items); position=page.next_cursor; } while(position);
  assert.equal(found.length,10); assert.equal(new Set(found.map(s=>s.session_id)).size,10);
  const session=app.sessions.get('s0');
  await app.harness.commit(async tx=>{for(let index=0;index<100;index++) await tx.appendEntry(session.conversation.id,{kind:'test.note',model:[{role:'user',content:'\0'.repeat(8192),timestamp:index}]});},context);
  position=undefined;found=[];do {const page=await call('transcript.list',{session_id:'s0',limit:100,...(position?{cursor:position}:{})});assert.ok(Buffer.byteLength(JSON.stringify(page))<4194304);found.push(...page.items);position=page.next_cursor;}while(position);
  assert.equal(found.length,100);assert.equal(new Set(found.map(e=>e.entry_id)).size,100);
});

test('releasing a wait during lookup cancels only that wait', async t => {
  const {app,call,create}=await setup(t,[fauxAssistantMessage('x'.repeat(1000))],10);
  await create('work');const receipt=await call('input.submit',input('work','run'));
  const waiting=app.dispatch('submission.wait',{session_id:'work',request_id:'run'},'release_me');
  const rejected=assert.rejects(waiting,isKind('not_ready'));
  await app.dispatch('worker.release',{request_ids:['release_me'],watch_ids:[]},'release');
  await rejected; assert.equal((await call('submission.get',{session_id:'work',request_id:'run'})).status,'accepted');
  await call('run.stop',{session_id:'work',submission_id:receipt.submission_id});
});

test('a long wait timeout is not shortened to the Node timer maximum', async t => {
  const { app, call, create } = await setup(t, [fauxAssistantMessage('x'.repeat(1000))], 10);
  await create('work'); const receipt = await call('input.submit', input('work', 'run'));
  let elapsed = 0, settled = false, capture = false;
  const scheduled = [], realTimeout = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    if (milliseconds < 2147483647 && !capture) return realTimeout(callback, milliseconds);
    const timer = { callback, milliseconds, unref() {} }; scheduled.push(timer); return timer;
  });
  const waiting = app.dispatch('submission.wait', { session_id: 'work', request_id: 'run', timeout_ms: 2147483657 }, 'long_wait');
  const result = waiting.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  const timedOut = assert.rejects(result, isKind('timeout'));
  for (let count = 0; count < 20 && !scheduled.some(timer => timer.milliseconds === 2147483647); count++) await new Promise(resolve => setImmediate(resolve));
  const first = scheduled.find(timer => timer.milliseconds === 2147483647); assert.ok(first);
  elapsed = 2147483647; capture = true; first.callback(); capture = false;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  const last = scheduled.at(-1); assert.equal(last.milliseconds, 10);
  elapsed += 10; last.callback(); await timedOut;
  t.mock.restoreAll();
  assert.equal((await call('submission.get', { session_id: 'work', request_id: 'run' })).status, 'accepted');
  await call('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
});

test('watch attachment during generation starts with current text and converges to the stored answer', async t => {
  const answer = 'Streaming output. '.repeat(50);
  const { app, call, create } = await setup(t, [fauxAssistantMessage(answer)], 2000);
  await create('work'); const receipt = await call('input.submit', input('work', 'stream'));
  await delay(150);
  const changes = [], watch = await app.dispatch('session.watch', { session_id: 'work' }, 'late_watch', value => changes.push(value.params.snapshot));
  assert.equal(watch.result.snapshot.active_submission_id, receipt.submission_id);
  assert.ok(watch.result.snapshot.assistant.text.length > 0);
  assert.ok(answer.startsWith(watch.result.snapshot.assistant.text)); watch.start();
  const result = await call('submission.wait', { session_id: 'work', request_id: 'stream', timeout_ms: 3000 });
  await delay(10); assert.equal(changes.at(-1).state, 'idle'); assert.equal(changes.at(-1).assistant.text, answer);
  assert.equal((await call('entry.read', { session_id: 'work', entry_id: result.answer_entry_id })).text, answer);
  await call('session.unwatch', { watch_id: watch.result.watch_id });
});
