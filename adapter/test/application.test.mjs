import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openApplication, SessionDoc } from '../pi.mjs';
import { application } from '../../tests/fixtures/application.mjs';

async function setup(t, messages, tokens = 100000) {
  const fixture = await application(t, { prefix: 'harness-adapter-', messages, tokens,
    settings: { provider: 'faux', model: 'test', instructions: '' } });
  const create = id => fixture.call('session.create', { session_id: id, workspace: fixture.workspace });
  return { ...fixture, create };
}

const input = (session_id, request_id, text = 'Task') => ({ session_id, request_id, text, context: [] });
const isKind = kind => error => error.data?.kind === kind;

test('configuration lists the Pi catalog and explains missing or unsupported choices without requests', async t => {
  const { app, call } = await setup(t);
  app.models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  app.models.setProvider(anthropicProvider());
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Configuration must not make a network request'); });
  for (const [provider, model, issue] of [
    [null, null, 'missing_model'], ['anthropic', null, 'missing_model'], [null, 'claude-sonnet-4-6', 'missing_model'],
    ['unsupported', 'claude-sonnet-4-6', 'invalid_model'], ['anthropic', 'unknown', 'invalid_model'],
  ]) {
    Object.assign(app.config, { provider, model });
    const result = await call('configuration.get');
    assert.deepEqual({ provider: result.provider, model: result.model, ready: result.ready, issue: result.issue }, { provider, model, ready: false, issue });
    assert.match(result.message, /\\model/);
    assert.equal(result.models.length, 17);
    assert.ok(result.models.some(item => item.id === 'claude-sonnet-4-6' && item.name === 'Claude Sonnet 4.6'));
    assert.ok(result.models.every(item => typeof item.id === 'string' && typeof item.name === 'string' && item.provider === 'anthropic' && Object.keys(item).length === 3));
    assert.deepEqual(result.providers.map(item => [item.id, item.authenticated, item.credential_type, item.methods.map(method => method.id)]),
      [['anthropic', false, null, ['oauth', 'api_key']]]);
  }
  assert.deepEqual((await call('session.list')).items, []);
});

test('configuration checks only credential presence and returns no credential material', async t => {
  const { app, call } = await setup(t);
  let key;
  app.models = createModels({ authContext: { env: async name => name === 'ANTHROPIC_API_KEY' ? key : undefined, fileExists: async () => false } });
  app.models.setProvider(anthropicProvider());
  Object.assign(app.config, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Configuration must not make a network request'); });
  const missing = await call('configuration.get');
  assert.equal(missing.ready, false); assert.equal(missing.issue, 'missing_key');
  assert.match(missing.message, /not connected/);
  assert.match(missing.message, /\\login/);
  key = 'deliberately-invalid-secret-for-test';
  const configured = await call('configuration.get');
  assert.equal(configured.ready, true); assert.equal(configured.issue, null);
  assert.match(configured.message, /has not checked/);
  assert.match(configured.message, /API key/);
  assert.deepEqual(Object.keys(configured).sort(), ['issue', 'message', 'model', 'models', 'provider', 'providers', 'ready']);
  assert.equal(configured.providers[0].authenticated, true);
  assert.equal(configured.providers[0].credential_type, 'api_key');
  assert.ok(!JSON.stringify(configured).includes(key));
});

test('configuration distinguishes an environment API key from a saved account before and after reopen', async t => {
  const { app, config, call } = await setup(t);
  const key = 'synthetic-environment-key', access = 'synthetic-account-access', refresh = 'synthetic-account-refresh';
  const configure = target => {
    target.models = createModels({ credentials: target.credentials, authContext: {
      env: async name => name === 'OPENAI_API_KEY' ? key : undefined, fileExists: async () => false,
    } });
    target.models.setProvider(openaiProvider());
  };
  configure(app);
  Object.assign(config, { provider: 'openai', model: 'gpt-6-sol' });
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Credential status must not make a provider request'); });
  const check = (value, type, label) => {
    assert.equal(value.ready, true);
    assert.deepEqual(value.providers.map(({ id, authenticated, credential_type }) => ({ id, authenticated, credential_type })),
      [{ id: 'openai', authenticated: true, credential_type: type }]);
    assert.match(value.message, label);
    assert.match(value.message, /has not checked/);
    for (const secret of [key, access, refresh]) assert.ok(!JSON.stringify(value).includes(secret));
  };
  check(await call('configuration.get'), 'api_key', /API key/);
  await app.credentials.modify('openai', async () => ({ type: 'oauth', access, refresh, expires: Date.now() + 3600000 }));
  check(await call('configuration.get'), 'oauth', /Account login/);
  await app.close();
  const reopened = await openApplication(config);
  try {
    configure(reopened);
    check(await reopened.dispatch('configuration.get', {}), 'oauth', /Account login/);
    await reopened.dispatch('auth.logout', { provider: 'openai' });
    check(await reopened.dispatch('configuration.get', {}), 'api_key', /API key/);
  } finally { await reopened.close(); }
});

test('configuration reads preserve an active run and the fixed configuration of its session', async t => {
  const { app, call, create } = await setup(t, [fauxAssistantMessage('a'.repeat(1000))], 20);
  const session = await create('work');
  const receipt = await call('input.submit', input('work', 'active'));
  const configured = await call('configuration.get');
  assert.equal(configured.ready, true); assert.equal(configured.provider, 'faux'); assert.equal(configured.model, 'test');
  assert.match(configured.message, /Demo/); assert.match(configured.message, /fixed replies/);
  app.config.model = 'unknown';
  assert.equal((await call('configuration.get')).issue, 'invalid_model');
  assert.deepEqual(await create('work'), session);
  assert.equal((await call('submission.get', { session_id: 'work', request_id: 'active' })).status, 'accepted');
  await call('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
});

test('the default demo response explains its limit and how to configure an AI model', async t => {
  const { call, create } = await setup(t);
  await create('demo'); await call('input.submit', input('demo', 'first', 'Change my code'));
  const result = await call('submission.wait', { session_id: 'demo', request_id: 'first', timeout_ms: 3000 });
  const answer = await call('entry.read', { session_id: 'demo', entry_id: result.answer_entry_id });
  assert.match(answer.text, /Demo mode uses fixed replies/);
  assert.match(answer.text, /does not use an AI model or change project files/);
  assert.match(answer.text, /harness setup/);
  assert.match(answer.text, /\\model/); assert.match(answer.text, /\\login/);
  assert.equal((await call('transcript.list', { session_id: 'demo' })).items.filter(item => item.kind === 'tool').length, 0);
});

test('creation preserves existing settings and inherits the latest configured chat after reopen', async t => {
  const { app, call, create, workspace, config } = await setup(t);
  const first = await create('work'); app.config.model = null;
  const inherited = await create('new');
  assert.equal(inherited.provider, first.provider); assert.equal(inherited.model, first.model);
  app.config.model = 'invalid-new-default';
  assert.deepEqual(await create('work'), first);
  await assert.rejects(call('session.create', { session_id: 'work', workspace: '/tmp' }), isKind('conflict'));
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  assert.deepEqual(await reopened.dispatch('session.create', { session_id: 'work', workspace }, 'reopen'), first);
  assert.equal((await reopened.dispatch('session.list', {}, 'list')).items.length, 2);
});

test('an empty chat persists without a model and accepts settings before credentials', async t => {
  const { app, call, create, config } = await setup(t);
  Object.assign(config, { provider: null, model: null });
  const empty = await create('empty');
  assert.equal(empty.name, 'empty'); assert.equal(empty.parent_session_id, null);
  assert.equal(empty.provider, null); assert.equal(empty.model, null);
  const child = await call('session.create', { session_id: 'child', workspace: empty.workspace, parent_session_id: 'empty', name: 'New chat' });
  assert.equal(child.provider, null); assert.equal(child.model, null); assert.equal(child.name, 'New chat');
  assert.equal((await call('session.get', { session_id: 'empty' })).snapshot.state, 'idle');
  await assert.rejects(call('input.submit', input('empty', 'first')), isKind('not_ready'));
  await assert.rejects(call('submission.get', { session_id: 'empty', request_id: 'first' }), isKind('not_found'));
  assert.deepEqual((await call('transcript.list', { session_id: 'empty' })).items, []);
  const auth = t.mock.method(app.models, 'getAuth', () => assert.fail('Choosing a model must not read credentials'));
  await call('session.configure', { session_id: 'empty', provider: 'anthropic', model: 'claude-sonnet-4-6', name: 'Review λ' });
  auth.mock.restore();
  assert.equal((await call('configuration.get', { session_id: 'empty' })).model, 'claude-sonnet-4-6');
  await assert.rejects(call('session.configure', { session_id: 'empty', provider: 'anthropic', model: 'missing' }), { code: -32602 });
  const selected = await call('session.configure', { session_id: 'empty', provider: 'faux', model: 'test', instructions: 'Review the project' });
  assert.deepEqual(await call('session.configure', { session_id: 'empty', provider: 'faux', model: 'test', instructions: 'Review the project' }), selected);
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const run = (method, params) => reopened.dispatch(method, params, method);
  assert.deepEqual((await run('session.get', { session_id: 'empty' })).session, selected);
  const receipt = await run('input.submit', input('empty', 'first', 'Original'));
  const result = await run('submission.wait', { session_id: 'empty', request_id: 'first', timeout_ms: 3000 });
  assert.equal(result.status, 'done');
  assert.equal((await run('input.submit', input('empty', 'first', 'Replacement'))).submission_id, receipt.submission_id);
  const changed = await run('session.configure', { session_id: 'empty', instructions: 'New instructions after history', name: 'Finished review' });
  assert.equal(changed.instructions, 'New instructions after history');
  assert.deepEqual((await run('transcript.list', { session_id: 'empty' })).items.filter(item => item.kind === 'user').map(item => item.text), ['Original']);
});

test('parents and workspace inheritance persist, and list cursors belong to their directory', async t => {
  const { app, call, create, directory, workspace, config } = await setup(t);
  const other = join(directory, 'other'); await mkdir(other);
  await create('root');
  await call('session.configure', { session_id: 'root', instructions: 'Root settings', name: 'Main' });
  const child = await call('session.create', { session_id: 'child', workspace, parent_session_id: 'root', name: 'Review' });
  assert.equal(child.parent_session_id, 'root'); assert.equal(child.instructions, 'Root settings');
  await call('session.configure', { session_id: 'child', instructions: 'Child settings' });
  const nested = await call('session.create', { session_id: 'nested', workspace, parent_session_id: 'child' });
  assert.equal(nested.parent_session_id, 'child'); assert.equal(nested.instructions, 'Child settings');
  const independent = await create('independent'); assert.equal(independent.instructions, 'Child settings'); assert.equal(independent.parent_session_id, null);
  const elsewhere = await call('session.create', { session_id: 'elsewhere', workspace: other });
  assert.equal(elsewhere.instructions, '');
  await assert.rejects(call('session.create', { session_id: 'missing', workspace, parent_session_id: 'absent' }), isKind('not_found'));
  await assert.rejects(call('session.create', { session_id: 'self', workspace, parent_session_id: 'self' }), isKind('not_found'));
  await assert.rejects(call('session.create', { session_id: 'wrong_workspace', workspace: other, parent_session_id: 'root' }), isKind('conflict'));
  await assert.rejects(call('session.create', { session_id: 'child', workspace, parent_session_id: 'nested' }), isKind('conflict'));
  await assert.rejects(call('session.create', { session_id: 'child', workspace, parent_session_id: null }), isKind('conflict'));
  assert.equal((await create('child')).parent_session_id, 'root');
  const page = await call('session.list', { workspace, limit: 1 });
  assert.ok(page.next_cursor);
  await assert.rejects(call('session.list', { workspace: other, cursor: page.next_cursor }), { code: -32602 });
  await assert.rejects(call('session.list', { cursor: page.next_cursor }), { code: -32602 });
  const names = [...page.items]; let next = page.next_cursor;
  while (next) { const page = await call('session.list', { workspace, limit: 1, cursor: next }); names.push(...page.items); next = page.next_cursor; }
  assert.deepEqual(names.map(item => item.session_id), ['child', 'independent', 'nested', 'root']);
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const restored = (await reopened.dispatch('session.list', { workspace }, 'list')).items;
  assert.deepEqual(restored.map(item => [item.session_id, item.parent_session_id]), [['child', 'root'], ['independent', null], ['nested', 'child'], ['root', null]]);
});

test('settings are atomic in watch frames and reject only the active target', async t => {
  const { app, call, create } = await setup(t, [fauxAssistantMessage('x'.repeat(1000))], 10);
  await create('active'); await create('idle');
  const receipt = await call('input.submit', input('active', 'task'));
  await assert.rejects(call('session.configure', { session_id: 'active', name: 'Changed' }), isKind('busy'));
  assert.equal((await call('session.get', { session_id: 'active' })).session.name, 'active');
  const frames = [];
  const watch = await app.dispatch('session.watch', { session_id: 'idle' }, 'watch', record => frames.push(record.params.snapshot)); watch.start();
  const changed = await call('session.configure', { session_id: 'idle', provider: 'anthropic', model: 'claude-sonnet-4-6', name: 'Configured', instructions: 'Updated instructions' });
  await delay(20);
  assert.deepEqual(frames.at(-1).session, changed);
  const current = await call('session.get', { session_id: 'idle' });
  assert.deepEqual(current.session, changed); assert.deepEqual(current.snapshot.session, changed);
  const renamed = await call('session.configure', { session_id: 'idle', name: 'Name only' });
  await delay(10); assert.deepEqual(frames.at(-1).session, renamed);
  assert.equal((await call('submission.get', { session_id: 'active', request_id: 'task' })).status, 'accepted');
  await call('session.unwatch', { watch_id: watch.result.watch_id });
  await call('run.stop', { session_id: 'active', submission_id: receipt.submission_id });
});

test('a long workspace path produces a usable scoped continuation cursor', async t => {
  const { call, directory, workspace } = await setup(t);
  const deep = join(directory, ...Array.from({ length: 40 }, () => 'd'.repeat(80)));
  await mkdir(deep, { recursive: true });
  for (const session_id of ['first', 'second']) await call('session.create', { session_id, workspace: deep });
  const first = await call('session.list', { workspace: deep, limit: 1 });
  assert.ok(Buffer.byteLength(first.next_cursor) <= 4096);
  const second = await call('session.list', { workspace: deep, cursor: first.next_cursor, limit: 1 });
  assert.deepEqual([...first.items, ...second.items].map(item => item.session_id), ['first', 'second']);
  assert.equal(second.next_cursor, null);
  await assert.rejects(call('session.list', { workspace, cursor: first.next_cursor }), { code: -32602 });
});

test('a watch attached before settings change starts with the latest committed name and model', async t => {
  const { app, call, create } = await setup(t);
  await create('work'); const frames = [];
  const render = t.mock.method(app, 'render');
  const watch = await app.dispatch('session.watch', { session_id: 'work' }, 'watch', record => frames.push(record.params.snapshot));
  const selected = await call('session.configure', { session_id: 'work', name: 'Renamed', provider: 'anthropic', model: 'claude-sonnet-4-6' });
  assert.equal(render.mock.callCount(), 1); assert.deepEqual(frames, []);
  assert.equal(watch.result.snapshot.session.name, 'work');
  watch.start(); await delay(10);
  assert.deepEqual(frames.at(-1).session, selected); assert.equal(frames.at(-1).state, 'idle');
  await call('session.unwatch', { watch_id: watch.result.watch_id });
});

test('legacy chats retain their public identifiers as names and have no parent', async t => {
  const { app, call, create, config } = await setup(t);
  await create('review'); const session = app.sessions.get('review');
  await app.harness.commit(async tx => { const stored = await tx.doc(SessionDoc, session.conversation.id); delete stored.name; delete stored.parent_session_id; }, context);
  assert.equal((await call('session.get', { session_id: 'review' })).session.name, 'review');
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const restored = (await reopened.dispatch('session.get', { session_id: 'review' }, 'get')).session;
  assert.equal(restored.name, 'review'); assert.equal(restored.parent_session_id, null);
});

test('concurrent settings and submission use one selected model and keep duplicate admission exact', async t => {
  const { app, call, create } = await setup(t, [fauxAssistantMessage('x'.repeat(1000))], 10);
  Object.assign(app.config, { provider: null, model: null }); await create('work');
  const configured = call('session.configure', { session_id: 'work', provider: 'faux', model: 'test', instructions: 'Selected before admission' });
  const submitted = call('input.submit', input('work', 'task', 'Original'));
  const duplicate = call('input.submit', input('work', 'task', 'Replacement'));
  const [settings, receipt, repeated] = await Promise.all([configured, submitted, duplicate]);
  assert.equal(settings.model, 'test'); assert.equal(receipt.status, 'accepted'); assert.equal(repeated.submission_id, receipt.submission_id);
  const snapshot = (await call('session.get', { session_id: 'work' })).snapshot;
  assert.equal(snapshot.session.instructions, 'Selected before admission'); assert.equal(snapshot.active_submission_id, receipt.submission_id);
  assert.deepEqual((await call('transcript.list', { session_id: 'work' })).items.filter(item => item.kind === 'user').map(item => item.text), ['Original']);
  await call('run.stop', { session_id: 'work', submission_id: receipt.submission_id });
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

test('expired idle caches preserve exact outcomes, history, settings, and targeted stops', async t => {
  const open = Harness.open;
  let fixture;
  try {
    Harness.open = (storage, options, context) => open(storage, {
      ...options, settings: { ...options.settings, contextRetentionMs: 25, documentRetentionMs: 25 },
    }, context);
    fixture = await setup(t, [fauxAssistantMessage('Original answer'), fauxAssistantMessage('x'.repeat(1000))], 1000);
  } finally { Harness.open = open; }
  const { app, call, create } = fixture;
  await create('work');
  let watch_id;
  {
    const watch = await app.dispatch('session.watch', { session_id: 'work' }, 'watch', () => {});
    watch_id = watch.result.watch_id; watch.start();
  }
  const receipt = await call('input.submit', input('work', 'first', 'Original input'));
  const completed = await call('submission.wait', { session_id: 'work', request_id: 'first', timeout_ms: 3000 });
  assert.equal(completed.status, 'done'); assert.equal(completed.submission_id, receipt.submission_id);
  const history = await call('transcript.list', { session_id: 'work' });
  assert.deepEqual(history.items.filter(entry => entry.kind === 'user' || entry.kind === 'assistant').map(entry => entry.text), ['Original input', 'Original answer']);
  await call('session.unwatch', { watch_id });
  // Real Pi timers release idle context and documents after the last observer leaves.
  await delay(100);
  assert.deepEqual(await call('submission.get', { session_id: 'work', request_id: 'first' }), completed);
  assert.deepEqual(await call('transcript.list', { session_id: 'work' }), history);
  const configured = await call('session.configure', {
    session_id: 'work', name: 'Resumed work', provider: 'faux', model: 'test', instructions: 'Use saved history',
  });
  assert.deepEqual(await call('input.submit', input('work', 'first', 'Must not execute')), completed);
  await delay(100);
  assert.deepEqual(await call('transcript.list', { session_id: 'work' }), history);
  assert.deepEqual((await call('session.get', { session_id: 'work' })).session, configured);
  const next = await call('input.submit', input('work', 'next', 'New input'));
  assert.notEqual(next.submission_id, completed.submission_id);
  assert.deepEqual(await call('run.stop', { session_id: 'work', submission_id: completed.submission_id }), completed);
  assert.equal((await call('submission.get', { session_id: 'work', request_id: 'next' })).status, 'accepted');
  const stopped = await call('run.stop', { session_id: 'work', submission_id: next.submission_id });
  assert.equal(stopped.reason, 'cancelled');
  await delay(100);
  assert.deepEqual(await call('submission.wait', { session_id: 'work', request_id: 'next' }), stopped);
  assert.deepEqual(await call('submission.get', { session_id: 'work', request_id: 'first' }), completed);
  const resumedHistory = await call('transcript.list', { session_id: 'work' });
  assert.deepEqual(resumedHistory.items.slice(0, history.items.length), history.items);
  assert.deepEqual(resumedHistory.items.filter(entry => entry.kind === 'user').map(entry => entry.text), ['Original input', 'New input']);
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

test('watch bursts render once per interval and terminal changes bypass the interval', async t => {
  const { app, call, create } = await setup(t);
  await create('work'); const records = [], session = app.sessions.get('work');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const render = t.mock.method(app, 'render');
  const watch = await app.dispatch('session.watch', { session_id: 'work' }, 'watch', record => records.push(record));
  watch.start(); render.mock.resetCalls();
  for (let index = 0; index < 50; index++) {
    await app.harness.commit(async tx => {
      const live = await tx.doc(LiveDoc, session.conversation.id);
      live.run = { taskId: 1, inputs: [1] };
      live.generation = { attempt: 1, message: fauxAssistantMessage(`Progress ${index}`) };
    }, context);
  }
  assert.equal(render.mock.callCount(), 0); assert.equal(records.length, 1);
  t.mock.timers.tick(99);
  assert.equal(render.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(render.mock.callCount(), 1); assert.equal(records.length, 2);
  assert.equal(records.at(-1).params.snapshot.assistant.text, 'Progress 49');
  assert.equal(records.at(-1).params.snapshot.state, 'running');
  await app.harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, session.conversation.id);
    live.generation.message = fauxAssistantMessage('Pending progress');
  }, context);
  assert.equal(render.mock.callCount(), 1);
  await app.harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, session.conversation.id);
    delete live.run; delete live.generation;
    await tx.appendEntry(session.conversation.id, { kind: 'pi.assistant', model: [fauxAssistantMessage('Complete answer')] });
  }, context);
  assert.equal(render.mock.callCount(), 2); assert.equal(records.length, 3);
  assert.equal(records.at(-1).params.snapshot.state, 'idle');
  assert.equal(records.at(-1).params.snapshot.assistant.text, 'Complete answer');
  assert.deepEqual(records.map(record => record.params.sequence), [1, 2, 3]);
  t.mock.timers.tick(100);
  assert.equal(render.mock.callCount(), 2); assert.equal(records.length, 3);
  await call('session.unwatch', { watch_id: watch.result.watch_id });
  t.mock.timers.reset();
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

test('failed entries and exact stored outcomes keep safe diagnostics across later runs and reopen', async t => {
  const secret = 'SECRET_PROVIDER_DETAIL';
  const { app, call, create, config } = await setup(t, [
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: `OpenAI API error (401): ${secret}` }),
    fauxAssistantMessage(' \n', { stopReason: 'error', errorMessage: `OpenAI API error (404): ${secret}` }),
    fauxAssistantMessage('Partial answer λ', { stopReason: 'error', errorMessage: `OpenAI API error (403): ${secret}` }),
    fauxAssistantMessage('Complete answer'),
  ]);
  await create('work'); const outcomes = [];
  for (const request_id of ['login', 'model', 'partial', 'success']) {
    await call('input.submit', input('work', request_id));
    outcomes.push(await call('submission.wait', { session_id: 'work', request_id, timeout_ms: 3000 }));
    const view = (await call('session.get', { session_id: 'work' })).snapshot;
    const entry = view.entries.at(-1);
    if (request_id === 'login' || request_id === 'model') {
      assert.equal(entry.kind, 'error'); assert.equal(entry.text, view.error.message);
      assert.equal(entry.text, outcomes.at(-1).message);
      assert.deepEqual(await call('entry.read', { session_id: 'work', entry_id: entry.entry_id }),
        { text: entry.text, next_offset: Buffer.byteLength(entry.text), end: true });
    } else if (request_id === 'partial') {
      assert.equal(entry.kind, 'assistant'); assert.equal(entry.text, 'Partial answer λ');
      assert.equal(view.assistant.text, 'Partial answer λ'); assert.match(view.error.message, /denied access/);
    } else {
      assert.equal(view.error, null); assert.equal(entry.text, 'Complete answer');
    }
    assert.doesNotMatch(JSON.stringify(view), new RegExp(secret));
  }
  assert.match(outcomes[0].message, /\\login/); assert.match(outcomes[1].message, /\\model/);
  const history = await call('transcript.list', { session_id: 'work' });
  assert.equal(history.items.filter(entry => entry.kind === 'error').length, 2);
  assert.doesNotMatch(JSON.stringify(history), new RegExp(secret));
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const run = (method, params) => reopened.dispatch(method, params, 'reopened');
  assert.deepEqual(await run('transcript.list', { session_id: 'work' }), history);
  for (const [index, request_id] of ['login', 'model', 'partial', 'success'].entries()) {
    const params = { session_id: 'work', request_id };
    assert.deepEqual(await run('submission.get', params), outcomes[index]);
    assert.deepEqual(await run('submission.wait', params), outcomes[index]);
    assert.deepEqual(await run('input.submit', input('work', request_id, 'Must not run')), outcomes[index]);
    assert.deepEqual(await run('run.stop', { session_id: 'work', submission_id: outcomes[index].submission_id }), outcomes[index]);
  }
  for (const entry of history.items.filter(entry => entry.kind === 'error')) {
    assert.equal((await run('entry.read', { session_id: 'work', entry_id: entry.entry_id })).text, entry.text);
  }
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
