import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openApplication } from '../pi.mjs';
import { terminalLogin } from '../auth.mjs';
import { installOAuthMock, secret as oauthSecret } from '../../tests/fixtures/oauth.mjs';
import { pty, until } from '../../tests/fixtures/terminal.mjs';
import { application } from '../../tests/fixtures/application.mjs';
import { loginModels } from '../../tests/fixtures/login.mjs';

const secret = 'synthetic-key-NOT-FOR-OUTPUT';
const isKind = kind => error => error.data?.kind === kind;
const offline = { env: async () => undefined, fileExists: async () => false };
const visibleText = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
function setup(t, tokens) {
  return application(t, { prefix: 'harness-auth-', tokens,
    settings: { provider: 'faux', model: 'test', instructions: '' } });
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
    assert.match(tty.text, /Ctrl-C cancels\. Secret input is hidden\./);
    assert.ok(!tty.text.includes('Escape'));
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
  const model = loginModels(async (_provider, _method, ui) => {
    observed.push(await ui.prompt({ type: 'secret', message: 'Private value' }));
    observed.push(await ui.prompt({ type: 'text', message: 'Optional value' }));
  }, { method: 'api_key' });
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
  const model = loginModels(async (_provider, _method, ui) => {
    ready = ui.prompt({ type: 'manual_code', message: 'Optional callback paste', signal: prompt.signal });
    await assert.rejects(ready);
    assert.equal(await ui.prompt({ type: 'text', message: 'After callback' }), '');
  });
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

test('empty manual callback input keeps waiting, accepts private input, and preserves cancellation', async t => {
  for (const finish of ['manual', 'callback', 'cancel']) {
    const tty = await pty(t), controller = new AbortController(), callback = new AbortController();
    let received = false;
    const model = loginModels(async (_provider, _method, ui) => {
      const answer = ui.prompt({ type: 'manual_code', message: 'Private callback', signal: callback.signal });
      if (finish === 'callback') {
        await assert.rejects(answer);
        assert.equal(controller.signal.aborted, false, 'A browser callback cancels only its manual prompt');
      } else {
        assert.equal(await answer, secret);
        received = true;
      }
    });
    const pending = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, controller, 'id');
    await tty.wait('Private callback');
    for (const input of ['\r', '   \r']) {
      const before = tty.text.split('Private callback').length;
      tty.write(input);
      await until(() => tty.text.split('Private callback').length > before, 'Blank input must keep the private prompt open');
      assert.equal(received, false);
      assert.equal(controller.signal.aborted, false);
    }
    assert.match(tty.text, /Wait for your browser, or paste the complete code or redirect URL\. Ctrl-C cancels\./);
    if (finish === 'callback') callback.abort();
    else tty.write(finish === 'cancel' ? '\x1b' : secret + '\r');
    assert.equal(await pending, finish === 'cancel');
    assert.equal(received, finish === 'manual');
    assert.ok(!tty.text.includes(secret));
  }
});

test('OpenAI waits for the browser without a paste instruction and retains private manual recovery', async t => {
  const previous = process.env.SSH_CONNECTION;
  process.env.SSH_CONNECTION = 'worker-started-from-ssh';
  t.after(() => { if (previous === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = previous; });
  const waiting = 'Waiting for browser sign-in. No input is needed here.';
  const manual = 'http://127.0.0.1:1455/auth/callback?code=' + secret;
  const instructions = 'Paste the callback after browser approval.';
  for (const [provider, finish] of [['openai', 'callback'], ['openai', 'manual'], ['other', 'manual']]) {
    const tty = await pty(t), controller = new AbortController(), callback = new AbortController();
    let complete = false;
    const model = loginModels(async (_provider, _method, ui) => {
      ui.notify({ type: 'auth_url', url: 'https://example.invalid/sign-in', instructions });
      const answer = ui.prompt({ type: 'manual_code', message: 'Provider callback instruction',
        placeholder: 'Provider placeholder', signal: callback.signal });
      if (finish === 'callback') await assert.rejects(answer, { name: 'AbortError' });
      else assert.equal(await answer, manual);
      complete = true;
    }, { provider });
    const pending = terminalLogin(model, { provider, method: 'oauth', terminal: tty.path }, controller, 'id');
    await tty.wait(provider === 'openai' ? waiting : 'Provider callback instruction (Provider placeholder):');
    if (provider === 'openai') {
      assert.ok(tty.text.includes('Finish sign-in in your browser. This window updates automatically.'));
      assert.doesNotMatch(visibleText(tty.text), /paste|Provider callback instruction|Provider placeholder/i);
      if (finish === 'manual') {
        for (const input of ['\r', '   \r']) {
          const count = tty.text.split(waiting).length;
          tty.write(input);
          await until(() => tty.text.split(waiting).length > count, 'Empty input must keep the browser wait active');
          assert.equal(complete, false);
          assert.doesNotMatch(visibleText(tty.text), /paste/i);
        }
      }
    } else {
      assert.ok(tty.text.includes(instructions), 'Other providers keep their login instructions');
      assert.ok(!tty.text.includes(waiting), 'Other providers keep their own input prompt');
    }
    if (finish === 'callback') callback.abort();
    else tty.write(manual + '\r');
    assert.equal(await pending, false);
    await tty.wait('Login saved');
    assert.equal(complete, true);
    assert.equal(controller.signal.aborted, false, 'Callback completion does not cancel the login');
    assert.ok(!tty.text.includes(secret), 'A recovery callback remains private');
  }
});

test('SSH login copies complete links, explains local browser errors, and keeps pasted input private', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-ssh-copy-')), log = join(directory, 'opened');
  await writeFile(join(directory, 'xdg-open'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, 'unexpected opener');\n`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, SSH_CONNECTION: process.env.SSH_CONNECTION, SSH_TTY: process.env.SSH_TTY };
  process.env.PATH = directory + ':' + previous.PATH;
  delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  const url = 'https://example.invalid/login?state=' + 'aB09%2F'.repeat(200);
  const returned = 'http://127.0.0.1:1455/auth/callback?code=' + secret, code = 'TEST-CODE';
  const tty = await pty(t), controller = new AbortController();
  let approve;
  const model = loginModels(async (_provider, _method, ui) => {
    ui.notify({ type: 'auth_url', url, instructions: 'A browser should open automatically.' });
    assert.equal(await ui.prompt({ type: 'manual_code', message: 'Browser callback' }), returned);
    ui.notify({ type: 'device_code', verificationUri: url, userCode: code });
    await new Promise(resolve => { approve = resolve; });
  }, { provider: 'openai' });
  const pending = terminalLogin(model, { provider: 'openai', method: 'oauth', terminal: tty.path, remote: true }, controller, 'id');
  await tty.wait('Paste it below and press Enter. If a code is shown, paste that code.');
  assert.match(visibleText(tty.text), /SSH: copy this link to your local browser/);
  assert.match(visibleText(tty.text), /localhost or 127\.0\.0\.1,[\r\n]+this is expected over SSH/);
  assert.match(visibleText(tty.text), /FULL address from its address bar/);
  assert.ok(tty.text.includes('[ Copy link ]'));
  assert.doesNotMatch(visibleText(tty.text), /automatically|No input is needed|Open browser/i);
  tty.write('\r'); await tty.wait('Paste the complete return URL or code. Ctrl-C cancels.');
  tty.write(returned.slice(0, 12) + '\x0f\x18' + returned.slice(12) + '\r');
  await tty.wait('Do not paste the browser address here.');
  assert.match(visibleText(tty.text), /Enter this code in your local browser\. This window updates automatically\./);
  tty.write('\x19'); await delay(40);
  approve(); assert.equal(await pending, false);
  await tty.wait('Login saved');
  const copied = Array.from(tty.text.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x1b\\/g), match => Buffer.from(match[1], 'base64').toString());
  assert.deepEqual(copied, [url, url, code]);
  await assert.rejects(readFile(log), { code: 'ENOENT' }, 'SSH never starts a remote browser, even after Ctrl-O');
  assert.ok(!tty.text.includes(secret));
});

test('characters entered while a provider saves credentials do not become visible', async t => {
  const tty = await pty(t);
  let finish, saved = false;
  const model = loginModels(async (_provider, _method, ui) => {
    assert.equal(await ui.prompt({ type: 'secret', message: 'Private value' }), secret);
    saved = true; await new Promise(resolve => { finish = resolve; });
    assert.equal(await ui.prompt({ type: 'text', message: 'Next value' }), '');
  }, { method: 'api_key' });
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

test('login link controls preserve private input and copy the complete current URL and device code', async t => {
  const tty = await pty(t), url = 'https://example.invalid/login?state=' + 'aB09%2F'.repeat(200);
  const nextUrl = 'https://example.invalid/device?code=TEST-123', code = 'TEST-123', answers = [];
  const previous = {};
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER']) { previous[key] = process.env[key]; delete process.env[key]; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value; });
  const model = loginModels(async (_provider, _method, ui) => {
    ui.notify({ type: 'auth_url', url });
    answers.push(await ui.prompt({ type: 'manual_code', message: 'Private callback' }));
    ui.notify({ type: 'device_code', verificationUri: nextUrl, userCode: code });
    answers.push(await ui.prompt({ type: 'secret', message: 'Private device value' }));
    ui.notify({ type: 'auth_url', url });
    answers.push(await ui.prompt({ type: 'text', message: 'Visible input' }));
  });
  const result = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, new AbortController(), 'id');
  await tty.wait('Private callback');
  assert.ok(!visibleText(tty.text).includes(url), 'The default terminal view must not expose a long URL to screen-based link detection');
  assert.ok(visibleText(tty.text).includes('[ Open browser ]'), 'The terminal shows a short browser action');
  tty.write(secret.slice(0, 8) + '\x0c');
  await tty.wait('Complete login link:');
  await until(() => visibleText(tty.text).includes(url), 'Ctrl-L must expose the complete URL on request');
  tty.write('\x18');
  await tty.wait('Clipboard copy requested'); tty.write(secret.slice(8) + '\r');
  await tty.wait('Private device value'); tty.write('removed-private-text\x15' + secret.slice(0, 8) + '\x19\x18' + secret.slice(8) + '\r');
  await tty.wait('Visible input'); tty.write('visible\x19\x18 value\r');
  assert.equal(await result, false);
  await tty.wait('Login saved');
  assert.deepEqual(answers, [secret, secret, 'visible value']);
  const copied = Array.from(tty.text.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x1b\\/g), match => Buffer.from(match[1], 'base64').toString());
  assert.deepEqual(copied, [url, code, nextUrl, url]);
  const links = Array.from(tty.text.matchAll(/\x1b\]8;id=harness-login;([^\x1b]+)\x1b\\([^\x1b]+)\x1b\]8;;\x1b\\/g),
    match => ({ url: match[1], label: match[2] }));
  assert.deepEqual(links, [url, nextUrl, url].map(value => ({ url: value, label: '[ Open browser ]' })));
  const codes = Array.from(tty.text.matchAll(/\x1b\]8;id=harness-code-([A-Za-z0-9+/=]+);([^\x1b]+)\x1b\\([^\x1b]+)\x1b\]8;;\x1b\\/g),
    match => ({ code: Buffer.from(match[1], 'base64').toString(), url: match[2], visible: match[3] }));
  assert.deepEqual(codes, [{ code, url: nextUrl, visible: code }], 'The displayed device code links to the same verified URL and carries only its exact copy value');
  assert.ok(!tty.text.includes(secret) && !tty.text.includes(Buffer.from(secret).toString('base64')) && !tty.text.includes('removed-private-text'));
  assert.ok(tty.text.includes('Ctrl-O: open browser. Ctrl-X: copy link. Ctrl-L: show link.') && tty.text.includes('Ctrl-Y: copy device code.'));
  const next = await pty(t);
  model.login = async (_provider, _method, ui) => {
    assert.equal(await ui.prompt({ type: 'secret', message: 'New login value' }), secret);
  };
  const fresh = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: next.path }, new AbortController(), 'id');
  await next.wait('New login value'); next.write('\x18\x0c' + secret + '\r');
  assert.equal(await fresh, false);
  await next.wait('No browser link is available');
  assert.ok(!next.text.includes('\x1b]52;') && !next.text.includes(url) && !next.text.includes(code));
});

test('invalid provider links and device codes cannot emit terminal commands or open a browser', async t => {
  const tty = await pty(t), previous = process.env.DISPLAY;
  delete process.env.DISPLAY;
  t.after(() => { if (previous !== undefined) process.env.DISPLAY = previous; });
  const model = loginModels(undefined, { refresh: async () => assert.fail('Invalid login must not refresh') });
  const events = [
    ...['javascript:alert(1)', 'file:///tmp/key', 'https://name:password@example.invalid', 'https://example.invalid/\x1b]52;c;bad\x07',
      'https://example.invalid/\nnext', 'https://example.invalid/\u0085', 'https://example.invalid/' + 'a'.repeat(8192)]
      .map(url => ({ type: 'auth_url', url })),
    { type: 'device_code', verificationUri: 'https://example.invalid', userCode: '\x1b]52;c;bad\x07' },
    { type: 'device_code', verificationUri: 'https://example.invalid', userCode: 'a'.repeat(1025) },
  ];
  for (const event of events) {
    model.login = async (_provider, _method, ui) => ui.notify(event);
    await assert.rejects(terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, new AbortController(), 'id'), { code: -32602 });
  }
  await until(() => (tty.text.match(/Secret input is hidden/g) ?? []).length === events.length, 'Each rejected attempt must finish terminal output');
  assert.ok(!tty.text.includes('\x1b]8;') && !tty.text.includes('\x1b]52;') && !tty.text.includes('password'));
});

test('closing the terminal during a private prompt cancels cleanly and permits another login', { timeout: 10000 }, async t => {
  // A separate Node process makes an uncaught readline EOF error an observable process failure.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { terminalLogin } from ${JSON.stringify(new URL('../auth.mjs', import.meta.url).href)};
import { loginModels } from ${JSON.stringify(new URL('../../tests/fixtures/login.mjs', import.meta.url).href)};
async function terminal() {
  const process = spawn('python3', ['-u', '-c', 'import os, pty, sys\\nm,s=pty.openpty()\\nprint(os.ttyname(s),flush=True)\\nfor line in sys.stdin: os.write(m,bytes.fromhex(line.strip()))'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [path] = await once(process.stdout, 'data');
  return { process, path: path.toString().trim() };
}
const first = await terminal();
let started;
const ready = new Promise(resolve => { started = resolve; });
const model = loginModels(async (_provider, _method, ui) => { started(); assert.equal(await ui.prompt({ type: 'manual_code', message: 'Private callback' }), 'test-code'); });
const pending = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: first.path }, new AbortController(), 'id');
await ready; first.process.stdin.end(); await once(first.process, 'exit');
assert.equal(await pending, true);
await new Promise(resolve => setTimeout(resolve, 50));
const second = await terminal();
try {
  const retry = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: second.path }, new AbortController(), 'id');
  second.process.stdin.write(Buffer.from('test-code\\r').toString('hex') + '\\n');
  assert.equal(await retry, false);
} finally { second.process.stdin.end(); await once(second.process, 'exit'); }
console.log('closed terminal cancelled; same process completed the next login');
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('exit', (...value) => resolve(value)); child.once('error', reject);
  });
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  assert.match(stdout, /closed terminal cancelled; same process completed the next login/);
});

test('login opens a browser only on request, retains links, and reports catalog failure after saving', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-browser-')), log = join(directory, 'opened.jsonl');
  await writeFile(log, '');
  await writeFile(join(directory, 'xdg-open'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.HARNESS_TEST_BROWSER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    BROWSER: process.env.BROWSER, HARNESS_TEST_BROWSER_LOG: process.env.HARNESS_TEST_BROWSER_LOG };
  Object.assign(process.env, { PATH: directory, DISPLAY: ':test', HARNESS_TEST_BROWSER_LOG: log });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  // Keep Python available for the PTY helper, while xdg-open resolves only to the controlled helper.
  process.env.PATH = directory + ':' + previous.PATH;
  const tty = await pty(t), browserUrl = 'https://example.invalid/login?flow=synthetic&state=' + 'abc%2F09'.repeat(200),
    deviceUrl = 'https://example.invalid/device';
  let saved = false;
  const model = loginModels(async (_provider, _method, ui) => {
    ui.notify({ type: 'auth_url', url: browserUrl });
    assert.equal(await ui.prompt({ type: 'manual_code', message: 'Browser callback' }), secret);
    ui.notify({ type: 'device_code', verificationUri: deviceUrl, userCode: 'TEST-CODE' });
    assert.equal(await ui.prompt({ type: 'manual_code', message: 'Device callback' }), secret);
    saved = true;
  }, { async refresh() { assert.ok(saved); return { errors: new Map([['test', Error(oauthSecret)]]) }; } });
  const pending = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: tty.path }, new AbortController(), 'id');
  await tty.wait('Browser callback');
  await delay(100);
  assert.equal(await readFile(log, 'utf8'), '', 'A displayed login link must not open a browser automatically');
  assert.ok(!visibleText(tty.text).includes(browserUrl), 'The default screen contains no wrapped browser URL');
  tty.write(secret.slice(0, 8) + '\x0f' + secret.slice(8) + '\r');
  await tty.wait('Device callback');
  for (let i = 0; i < 300 && !(await readFile(log, 'utf8')).trim(); i++) await delay(10);
  await delay(100);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse), [[browserUrl]],
    'A device login link also waits for an explicit open request');
  tty.write('\x0f' + secret + '\r');
  assert.equal(await pending, false);
  await tty.wait('model list could not update');
  assert.ok(tty.text.includes(browserUrl) && tty.text.includes(deviceUrl) && tty.text.includes('TEST-CODE'));
  assert.ok(!tty.text.includes(oauthSecret));
  let opened;
  for (let i = 0; i < 300; i++) {
    opened = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (opened.length === 2) break; await delay(10);
  }
  assert.deepEqual(opened.sort(), [[browserUrl], [deviceUrl]].sort());
  const retry = await pty(t);
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER']) delete process.env[key];
  model.login = async (_provider, _method, ui) => {
    ui.notify({ type: 'auth_url', url: browserUrl });
    assert.equal(await ui.prompt({ type: 'manual_code', message: 'Retry private callback' }), secret);
  };
  const retried = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: retry.path }, new AbortController(), 'id');
  await retry.wait('Retry private callback');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2, 'No automatic opener runs without desktop settings');
  retry.write(secret.slice(0, 8) + '\x0f' + secret.slice(8) + '\r');
  assert.equal(await retried, false);
  for (let i = 0; i < 300; i++) {
    opened = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (opened.length === 3) break; await delay(10);
  }
  assert.deepEqual(opened.at(-1), [browserUrl], 'Ctrl-O retries the exact link without changing private input');
  assert.ok(!retry.text.includes(secret));
  const missing = await pty(t);
  process.env.PATH = directory + '/missing';
  const unavailable = terminalLogin(model, { provider: 'test', method: 'oauth', terminal: missing.path }, new AbortController(), 'id');
  await missing.wait('Retry private callback'); missing.write(secret.slice(0, 8) + '\x0f');
  await missing.wait('Cannot open a browser here. Press Ctrl-X to copy the link.');
  missing.write(secret.slice(8) + '\r');
  assert.equal(await unavailable, false);
  await missing.wait('model list could not update');
  assert.ok(missing.text.includes(browserUrl), 'Missing browser opener retains the complete link metadata');
});
