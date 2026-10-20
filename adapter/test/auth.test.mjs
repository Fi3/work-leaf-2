import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openApplication } from '../pi.mjs';
import { terminalLogin } from '../auth.mjs';
import { installOAuthMock, secret as oauthSecret } from '../../tests/fixtures/oauth.mjs';

const secret = 'synthetic-key-NOT-FOR-OUTPUT';
const isKind = kind => error => error.data?.kind === kind;
const offline = { env: async () => undefined, fileExists: async () => false };
async function until(predicate, message) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}
async function setup(t, tokens) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-auth-'));
  const state = join(directory, 'state'), workspace = join(directory, 'work');
  await mkdir(state); await mkdir(workspace);
  const config = { state_dir: state, provider: 'faux', model: 'test', instructions: '' };
  const previous = process.env.HARNESS_FAUX_TOKENS_PER_SECOND;
  if (tokens) process.env.HARNESS_FAUX_TOKENS_PER_SECOND = String(tokens);
  const app = await openApplication(config);
  if (previous === undefined) delete process.env.HARNESS_FAUX_TOKENS_PER_SECOND;
  else process.env.HARNESS_FAUX_TOKENS_PER_SECOND = previous;
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const call = (method, params = {}) => app.dispatch(method, params, `auth_${++sequence}`, () => {});
  return { app, call, config, workspace };
}
async function pty(t) {
  // Python's standard library supplies a real PTY; no terminal emulation package is needed.
  const child = spawn('python3', ['-u', '-c', `
import os, pty, select, sys, json, base64
master, slave = pty.openpty()
print(json.dumps({"path": os.ttyname(slave)}), flush=True)
while True:
    for fd in select.select([master, sys.stdin], [], [])[0]:
        if fd == master:
            data = os.read(master, 65536)
            print(json.dumps({"output": base64.b64encode(data).decode()}), flush=True)
        else:
            data = sys.stdin.readline()
            if not data: sys.exit(0)
            os.write(master, base64.b64decode(json.loads(data)["input"]))
`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const terminal = { text: '', write: value => child.stdin.write(JSON.stringify({ input: Buffer.from(value).toString('base64') }) + '\n') };
  let partial = '';
  child.stdout.on('data', bytes => {
    partial += bytes; let newline;
    while ((newline = partial.indexOf('\n')) >= 0) {
      const value = JSON.parse(partial.slice(0, newline)); partial = partial.slice(newline + 1);
      if (value.path) terminal.path = value.path;
      if (value.output) terminal.text += Buffer.from(value.output, 'base64').toString();
    }
  });
  t.after(() => new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.stdin.end(); } }));
  await until(() => terminal.path, 'PTY must open');
  terminal.wait = text => until(() => terminal.text.includes(text), `Terminal must show ${text}`);
  return terminal;
}
const login = (app, tty, provider = 'openai', requestId = 'login') =>
  app.dispatch('auth.login', { provider, method: 'api_key', terminal: tty.path }, requestId);

test('all pinned providers, models, and login methods are available without a network request', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Idle setup and catalog must not use the network'));
  const { app, call } = await setup(t);
  const faux = app.models.getProvider('faux');
  app.models = builtinModels({ credentials: app.credentials, authContext: offline });
  app.models.setProvider(faux);
  const catalog = await call('configuration.get');
  assert.equal(catalog.providers.length, 43);
  assert.equal(catalog.models.length, 1615);
  assert.equal(catalog.providers.flatMap(provider => provider.methods).length, 50);
  assert.equal(catalog.providers.filter(provider => provider.methods.some(method => method.id === 'oauth')).length, 9);
  assert.ok(catalog.models.every(model => catalog.providers.some(provider => provider.id === model.provider)));
  assert.ok(catalog.models.some(model => model.provider === 'openai'));
  assert.ok(catalog.models.some(model => model.provider === 'google'));
  const typesafe = catalog.providers.find(provider => provider.id === 'typesafe');
  assert.ok(typesafe.methods.length > 0);
  assert.equal(catalog.models.filter(model => model.provider === typesafe.id).length, 0);
  assert.ok(catalog.providers.filter(provider => provider.id !== 'faux').every(provider => !provider.authenticated));
  assert.deepEqual((await call('session.list')).items, []);
});

test('all 41 provider key flows persist with Pi, including every ambient credential branch', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Key login must not contact a provider'));
  const { app } = await setup(t);
  const models = builtinModels({ credentials: app.credentials, authContext: offline });
  const providers = models.getProviders().filter(provider => provider.auth.apiKey?.login);
  assert.equal(providers.length, 41);
  const choices = [];
  for (const provider of providers) choices.push([provider.id, undefined]);
  choices.push(['amazon-bedrock', 'aws-profile'], ['amazon-bedrock', 'credential-chain'],
    ['google-vertex', 'adc'], ['google-vertex', 'service-account']);
  for (const [provider, choice] of choices) {
    const prompts = [];
    const credential = await models.login(provider, 'api_key', {
      async prompt(prompt) {
        prompts.push(prompt);
        if (prompt.type === 'select') return choice ?? prompt.options[0].id;
        if (prompt.type === 'text') return choice === 'credential-chain' ? '' : 'isolated-test-setting';
        assert.equal(prompt.type, 'secret'); return secret;
      }, notify() {},
    });
    assert.deepEqual(await app.credentials.read(provider), credential, provider);
    assert.equal(credential.type, 'api_key');
    assert.ok(prompts.length > 0);
    await models.logout(provider);
    assert.equal(await app.credentials.read(provider), undefined);
  }
  assert.deepEqual(await app.credentials.list(), []);
});

test('private credentials and installation identity survive reopen, with no public history or watch events', async t => {
  const { app, call, config, workspace } = await setup(t);
  await call('session.create', { session_id: 'chat', workspace });
  const frames = [], watch = await app.dispatch('session.watch', { session_id: 'chat' }, 'watch', frame => frames.push(frame));
  watch.start(); await delay(20); const baseline = frames.length;
  const deviceId = await app.credentials.deviceId();
  assert.match(deviceId, /^[0-9a-f-]{36}$/);
  await Promise.all(['openai', 'anthropic', 'google'].map(id => app.credentials.modify(id, async () => ({ type: 'api_key', key: `${secret}-${id}` }))));
  await delay(20);
  assert.equal(frames.length, baseline, 'Private document commits must not publish session changes');
  const publicState = await Promise.all([
    call('configuration.get'), call('session.list'), call('session.get', { session_id: 'chat' }),
    call('transcript.list', { session_id: 'chat' }),
  ]);
  assert.ok(!JSON.stringify([...publicState, ...frames]).includes(secret));
  assert.ok(!JSON.stringify(publicState).includes(deviceId));
  assert.deepEqual(publicState.at(-1).items, []);
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  assert.equal(await reopened.credentials.deviceId(), deviceId);
  for (const id of ['openai', 'anthropic', 'google']) assert.equal((await reopened.models.getAuth(id)).auth.apiKey, `${secret}-${id}`);
  await reopened.dispatch('auth.logout', { provider: 'openai' }, 'logout');
  assert.equal(await reopened.credentials.read('openai'), undefined);
  assert.ok(await reopened.credentials.read('anthropic'));
});

test('Pi token refresh is serialized and persisted across reopen; failure keeps the previous token', async t => {
  const { app, config } = await setup(t);
  const mock = installOAuthMock(); t.after(() => mock.restore());
  await app.models.login('xai', 'oauth', { prompt: () => assert.fail('xAI uses a device code'), notify() {} });
  const saved = await app.credentials.read('xai');
  await app.credentials.modify('xai', async () => ({ ...saved, expires: 0 }));
  await app.close();
  const reopened = await openApplication(config); t.after(() => reopened.close());
  const before = mock.calls.length;
  const results = await Promise.all(Array.from({ length: 8 }, () => reopened.models.getAuth('xai')));
  assert.equal(mock.calls.length - before, 1, 'Only one rotated refresh token exchange is permitted');
  assert.ok(results.every(result => result.auth.apiKey === results[0].auth.apiKey));
  assert.ok(results[0].auth.apiKey.includes(oauthSecret));
  const refreshed = await reopened.credentials.read('xai');
  assert.ok(refreshed.expires > Date.now());
  await reopened.credentials.modify('xai', async () => ({ ...refreshed, expires: 0 }));
  mock.control.failure = 'invalid_grant';
  await assert.rejects(reopened.models.getAuth('xai'));
  assert.deepEqual(await reopened.credentials.read('xai'), { ...refreshed, expires: 0 });
});

test('cancelled queued writes and failed changes preserve credentials, while started changes finish', async t => {
  const { app } = await setup(t), store = app.credentials;
  await store.modify('openai', async () => ({ type: 'api_key', key: secret }));
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const first = store.modify('openai', async current => { started(); await new Promise(resolve => { finish = resolve; }); return { ...current, key: 'rotated-key' }; });
  await began;
  const controller = new AbortController();
  const second = store.modify('openai', () => assert.fail('Cancelled queued change must not start'), { signal: controller.signal });
  controller.abort(); finish(); await first;
  await assert.rejects(second);
  assert.equal((await store.read('openai')).key, 'rotated-key');
  await assert.rejects(store.modify('openai', async () => { throw Error('Failure'); }));
  assert.equal((await store.read('openai')).key, 'rotated-key');
  let release;
  const pending = store.modify('openai', async () => { await new Promise(resolve => { release = resolve; }); return { type: 'api_key', key: 'final-key' }; });
  await until(() => release, 'Mutation must start');
  const removal = store.delete('openai'); release(); await pending; await removal;
  assert.equal(await store.read('openai'), undefined);
});

test('real terminal key login hides input and preserves existing work without a provider validation request', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Key login must not use the network'));
  const { app, call, workspace } = await setup(t, 5), tty = await pty(t);
  await call('session.create', { session_id: 'chat', workspace });
  const receipt = await call('input.submit', { session_id: 'chat', request_id: 'task', text: 'Existing task', context: [] });
  const result = login(app, tty);
  await tty.wait('Enter OpenAI API key');
  await assert.rejects(login(app, tty, 'anthropic', 'other'), isKind('busy'));
  await call('worker.release', { request_ids: ['other'], watch_ids: [] });
  tty.write(secret.slice(0, 10)); await delay(30);
  assert.ok(!tty.text.includes(secret.slice(0, 10)));
  tty.write(secret.slice(10) + '\r');
  assert.deepEqual(await result, { provider: 'openai', authenticated: true, cancelled: false, worker_ready: true });
  await tty.wait('Login saved');
  assert.ok(!tty.text.includes(secret));
  assert.equal((await app.credentials.read('openai')).key, secret);
  assert.equal((await call('submission.get', { session_id: 'chat', request_id: 'task' })).status, 'accepted');
  assert.equal((await call('session.get', { session_id: 'chat' })).snapshot.active_submission_id, receipt.submission_id);
  assert.deepEqual((await call('transcript.list', { session_id: 'chat' })).items.filter(item => item.kind === 'user').map(item => item.text), ['Existing task']);
  await call('run.stop', { session_id: 'chat', submission_id: receipt.submission_id });
});

test('login rechecks all pending recovery before resuming only the existing submissions', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Key login and faux recovery must not contact a provider'));
  const { app, call, config, workspace } = await setup(t, 5);
  const receipts = [];
  for (const id of ['one', 'two']) {
    await call('session.create', { session_id: id, workspace });
    receipts.push(await call('input.submit', { session_id: id, request_id: 'task', text: 'Pending task', context: [] }));
  }
  await app.close();
  await rename(workspace, workspace + '.moved');
  const recovered = await openApplication(config); t.after(() => recovered.close());
  const run = (method, params) => recovered.dispatch(method, params, method);
  assert.equal(recovered.hello().ready, false);
  const first = await pty(t), blocked = login(recovered, first);
  await first.wait('Enter OpenAI API key'); first.write(secret + '\r');
  assert.equal((await blocked).worker_ready, false);
  assert.equal((await recovered.harness.inspect(context)).scheduling, 'paused');
  for (const id of ['one', 'two']) assert.equal((await run('session.get', { session_id: id })).snapshot.state, 'blocked');
  await rename(workspace + '.moved', workspace);
  let release, checking = false;
  const checked = recovered.checkConfiguration.bind(recovered);
  t.mock.method(recovered, 'checkConfiguration', async metadata => {
    checking = true;
    await new Promise(resolve => { release = resolve; });
    return checked(metadata);
  });
  const second = await pty(t), ready = login(recovered, second);
  await second.wait('Enter OpenAI API key'); second.write(secret + '\r');
  await until(() => checking, 'Recovery checks must start');
  try {
    assert.equal(recovered.hello().ready, false, 'Readiness stays false until all pending configurations pass');
    await assert.rejects(run('input.submit', { session_id: 'one', request_id: 'new', text: 'Must not run', context: [] }), isKind('not_ready'));
    await assert.rejects(run('submission.wait', { session_id: 'one', request_id: 'task' }), isKind('not_ready'));
    await assert.rejects(run('run.stop', { session_id: 'one', submission_id: receipts[0].submission_id }), isKind('not_ready'));
    assert.equal((await recovered.harness.inspect(context)).scheduling, 'paused');
  } finally {
    recovered.checkConfiguration.mock.restore(); release();
  }
  assert.equal((await ready).worker_ready, true);
  assert.equal(recovered.hello().ready, true);
  for (const [index, id] of ['one', 'two'].entries()) {
    assert.equal((await run('submission.get', { session_id: id, request_id: 'task' })).submission_id, receipts[index].submission_id);
    assert.deepEqual((await run('transcript.list', { session_id: id })).items.filter(item => item.kind === 'user').map(item => item.text), ['Pending task']);
    await run('run.stop', { session_id: id, submission_id: receipts[index].submission_id });
  }
});

test('logout protects unfinished work and leaves external environment credentials under caller control', async t => {
  const { app, call, workspace } = await setup(t, 5);
  await call('session.create', { session_id: 'chat', workspace });
  const receipt = await call('input.submit', { session_id: 'chat', request_id: 'task', text: 'Existing task', context: [] });
  await app.credentials.modify('faux', async () => ({ type: 'api_key', key: secret }));
  await assert.rejects(call('auth.logout', { provider: 'faux' }), isKind('busy'));
  assert.equal((await app.credentials.read('faux')).key, secret);
  await call('run.stop', { session_id: 'chat', submission_id: receipt.submission_id });
  await call('auth.logout', { provider: 'faux' });
  assert.equal(await app.credentials.read('faux'), undefined);
  app.models = builtinModels({ credentials: app.credentials, authContext: {
    ...offline, env: async name => name === 'OPENAI_API_KEY' ? 'external-key' : undefined,
  } });
  await app.credentials.modify('openai', async () => ({ type: 'api_key', key: secret }));
  assert.equal((await call('auth.logout', { provider: 'openai' })).authenticated, true);
  assert.equal(await app.credentials.read('openai'), undefined);
  assert.equal((await app.models.getAuth('openai')).auth.apiKey, 'external-key');
});

test('terminal cancellation, invalid secret, disconnect, and close preserve the old key', async t => {
  const { app, call } = await setup(t);
  await app.credentials.modify('openai', async () => ({ type: 'api_key', key: secret }));
  for (const [name, keys] of [['Escape', '\x1b'], ['Ctrl-C', '\x03'], ['Ctrl-Z', '\x1a'], ['empty', '\r'], ['whitespace', '   \r'], ['control', 'invalid\u0085key\r'], ['disconnect', null]]) {
    const tty = await pty(t), result = login(app, tty);
    await tty.wait('Enter OpenAI API key');
    if (keys === null) await call('worker.release', { request_ids: ['login'], watch_ids: [] }); else tty.write(keys);
    if (['whitespace', 'control'].includes(name)) await assert.rejects(result, { code: -32602 });
    else assert.equal((await result).cancelled, true, name);
    assert.equal((await app.credentials.read('openai')).key, secret);
  }
  const tty = await pty(t), result = login(app, tty); await tty.wait('Enter OpenAI API key');
  await app.close();
  assert.equal((await result).cancelled, true);
});

test('native text and choice prompts accept valid blank answers, while secrets never enter input history', async t => {
  const { app } = await setup(t), tty = await pty(t);
  const result = login(app, tty, 'amazon-bedrock');
  await tty.wait('Choice [1-3');
  tty.write('9\r'); await tty.wait('Enter a listed number');
  tty.write('3\r'); await tty.wait('Configure AWS credentials, then press Enter to continue');
  tty.write('\r');
  assert.equal((await result).cancelled, false);
  assert.deepEqual(await app.credentials.read('amazon-bedrock'), { type: 'api_key' });
  const second = await pty(t), controller = new AbortController(), observed = [];
  const model = { refresh: async () => ({ errors: new Map() }),
    getProvider: () => ({ id: 'test', name: 'Test', auth: { apiKey: { name: 'Key', login() {} } } }),
    async login(_provider, _method, ui) {
      observed.push(await ui.prompt({ type: 'secret', message: 'Private value' }));
      observed.push(await ui.prompt({ type: 'text', message: 'Optional value' }));
    } };
  const history = terminalLogin(model, { provider: 'test', method: 'api_key', terminal: second.path }, controller, 'id');
  await second.wait('Private value'); second.write('deleted-private-text\x15' + secret + '\r');
  await second.wait('Optional value'); second.write('\x1b[A\x19\r');
  assert.equal(await history, false);
  assert.deepEqual(observed, [secret, '']);
  assert.ok(!second.text.includes(secret) && !second.text.includes('deleted-private-text'));
});

test('provider prompt cancellation leaves the login alive, and private provider errors cannot escape', async t => {
  const tty = await pty(t), controller = new AbortController(), prompt = new AbortController();
  let ready;
  const model = { refresh: async () => ({ errors: new Map() }),
    getProvider: () => ({ id: 'test', name: 'Test', auth: { oauth: { name: 'Account', login() {} } } }),
    async login(_provider, _method, ui) {
      ready = ui.prompt({ type: 'manual_code', message: 'Optional callback paste', signal: prompt.signal });
      await assert.rejects(ready);
      assert.equal(await ui.prompt({ type: 'text', message: 'After callback' }), '');
    } };
  const success = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, controller, 'id');
  await tty.wait('Optional callback paste'); tty.write(secret); await delay(20); prompt.abort();
  await tty.wait('After callback'); tty.write('\x1b[A\r');
  assert.equal(await success, false);
  assert.equal(controller.signal.aborted, false);
  assert.ok(!tty.text.includes(secret));
  const failed = await pty(t);
  model.login = async () => { throw Error(oauthSecret); };
  await assert.rejects(terminalLogin(model, { provider: 'test', method: 'oauth', terminal: failed.path }, new AbortController(), 'id'),
    error => error.data?.kind === 'provider_error' && !error.message.includes(oauthSecret));
  await failed.wait('Login failed');
  assert.ok(!failed.text.includes(oauthSecret));
});

test('characters entered while a provider saves credentials do not become visible', async t => {
  const tty = await pty(t);
  let finish, saved = false;
  const model = {
    refresh: async () => ({ errors: new Map() }),
    getProvider: () => ({ id: 'test', name: 'Test', auth: { apiKey: { name: 'Key', login() {} } } }),
    async login(_provider, _method, ui) {
      assert.equal(await ui.prompt({ type: 'secret', message: 'Private value' }), secret);
      saved = true; await new Promise(resolve => { finish = resolve; });
      assert.equal(await ui.prompt({ type: 'text', message: 'Next value' }), '');
    },
  };
  const result = terminalLogin(model, { provider: 'test', method: 'api_key', terminal: tty.path }, new AbortController(), 'id');
  await tty.wait('Private value'); tty.write(secret + '\r');
  await until(() => saved, 'Credential persistence must start');
  tty.write('extra-private-text'); await delay(30);
  try { assert.ok(!tty.text.includes(secret) && !tty.text.includes('extra-private-text')); }
  finally { finish(); }
  await tty.wait('Next value'); tty.write('\x1b[A\r');
  assert.equal(await result, false);
  assert.ok(!tty.text.includes('extra-private-text'));
});

test('non-terminal paths and unsupported methods fail without storing credentials', async t => {
  const { app, call } = await setup(t);
  for (const terminal of ['/dev/null', '/dev/tty', '/dev/pts/../null', '/dev/pts/999999999']) {
    await assert.rejects(call('auth.login', { provider: 'openai', method: 'api_key', terminal }), { code: -32602 });
  }
  const tty = await pty(t);
  await assert.rejects(login(app, tty, 'faux'), { code: -32602 });
  assert.deepEqual(await app.credentials.list(), []);
});

test('desktop login opens the normal browser, retains copyable links, and reports catalog failure after saving', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-browser-')), log = join(directory, 'opened.jsonl');
  await writeFile(log, '');
  await writeFile(join(directory, 'xdg-open'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.HARNESS_TEST_BROWSER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, HARNESS_TEST_BROWSER_LOG: process.env.HARNESS_TEST_BROWSER_LOG };
  Object.assign(process.env, { PATH: directory, DISPLAY: ':test', HARNESS_TEST_BROWSER_LOG: log });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  // Keep Python available for the PTY helper, while xdg-open resolves only to the controlled helper.
  process.env.PATH = directory + ':' + previous.PATH;
  const tty = await pty(t), browserUrl = 'https://example.invalid/login?flow=synthetic', deviceUrl = 'https://example.invalid/device';
  let saved = false;
  const model = {
    getProvider: () => ({ id: 'test', name: 'Test', auth: { oauth: { name: 'Account', login() {} } } }),
    async login(_provider, _method, ui) {
      ui.notify({ type: 'auth_url', url: browserUrl });
      ui.notify({ type: 'device_code', verificationUri: deviceUrl, userCode: 'TEST-CODE' });
      saved = true;
    },
    async refresh() { assert.ok(saved); return { errors: new Map([['test', Error(oauthSecret)]]) }; },
  };
  assert.equal(await terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, new AbortController(), 'id'), false);
  await tty.wait('model list could not update');
  assert.ok(tty.text.includes(browserUrl) && tty.text.includes(deviceUrl) && tty.text.includes('TEST-CODE'));
  assert.ok(!tty.text.includes(oauthSecret));
  let opened;
  for (let i = 0; i < 300; i++) {
    opened = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (opened.length === 2) break; await delay(10);
  }
  assert.deepEqual(opened.sort(), [[browserUrl], [deviceUrl]].sort());
  const missing = await pty(t);
  process.env.PATH = directory + '/missing';
  assert.equal(await terminalLogin(model, { provider: 'test', method: 'oauth', terminal: missing.path }, new AbortController(), 'id'), false);
  await missing.wait('model list could not update');
  assert.ok(missing.text.includes(browserUrl), 'Missing browser opener keeps the visible link');
});
