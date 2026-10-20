import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openApplication } from '../adapter/pi.mjs';
import { installOAuthMock, secret } from './fixtures/oauth.mjs';

const nativeFetch = globalThis.fetch;
const deviceId = '74c92438-a3ee-45c1-b6db-949badc75d07';
const expected = ['anthropic', 'github-copilot', 'kimi-coding', 'meta', 'openai', 'openai-codex', 'openrouter', 'radius', 'xai'];

async function application(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-oauth-'));
  const config = { state_dir: directory };
  const app = await openApplication(config);
  t.after(async () => { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { app, models: app.models, store: app.credentials, config };
}

function callbackUrl(event) {
  const url = new URL(event.url), target = new URL(url.searchParams.get('redirect_uri') ?? url.searchParams.get('callback_url'));
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  target.searchParams.set('code', 'test-code');
  if (url.searchParams.has('state')) target.searchParams.set('state', url.searchParams.get('state'));
  if (url.pathname === '/api/accounts/authorize') target.searchParams.set('client_id', 'test-issued-client');
  return target;
}

function interaction(provider, { method = 'browser', manual = false, invalidState = false, cancel = false } = {}) {
  const controller = new AbortController(), events = [], prompts = [], callbacks = [];
  let authorization, manualAborted = false;
  return {
    controller, events, prompts, callbacks, abortedPrompt: () => manualAborted,
    signal: controller.signal,
    async prompt(prompt) {
      prompts.push(prompt.type);
      if (prompt.type === 'select') return method;
      if (prompt.type === 'text') return ''; // Copilot's documented public GitHub default.
      assert.equal(prompt.type, 'manual_code');
      if (manual) return method === 'copy_code'
        ? `test-code#${new URL(authorization.url).searchParams.get('state')}`
        : callbackUrl(authorization).toString();
      return new Promise((_, reject) => {
        const abort = () => { manualAborted = true; reject(prompt.signal.reason); };
        if (prompt.signal.aborted) abort(); else prompt.signal.addEventListener('abort', abort, { once: true });
      });
    },
    notify(event) {
      events.push(event);
      if (cancel && ['auth_url', 'device_code'].includes(event.type)) {
        controller.abort(Error('Test cancellation')); return;
      }
      if (event.type !== 'auth_url') return;
      authorization = event;
      if (manual) return;
      callbacks.push((async () => {
        const target = callbackUrl(event);
        if (invalidState && target.searchParams.has('state')) {
          const invalid = new URL(target); invalid.searchParams.set('state', 'wrong-state');
          assert.equal((await nativeFetch(invalid)).status, 400, `${provider} rejects a different state`);
        }
        const response = await nativeFetch(target);
        assert.equal(response.status, 200, `${provider} callback succeeds`);
        await response.text();
      })());
    },
  };
}

// Fixed upstream callback ports require sequential cases within this file.
test('every locked OAuth provider completes its own flow and resolves the saved credential', async t => {
  const providers = builtinModels().getProviders().filter(provider => provider.auth.oauth).map(provider => provider.id).sort();
  assert.deepEqual(providers, expected);
  for (const provider of providers) await t.test(provider, async t => {
    const mock = installOAuthMock(), { app, models, store, config } = await application(t);
    try {
      const ui = interaction(provider, { invalidState: true });
      const result = await models.login(provider, 'oauth', ui, { getDeviceId: () => deviceId, agentName: 'Harness test' });
      await Promise.all(ui.callbacks);
      assert.equal(result.type, 'oauth');
      assert.deepEqual(await store.read(provider), JSON.parse(JSON.stringify(result)), 'The durable JSON credential preserves all provider fields');
      assert.equal((await models.checkAuth(provider)).type, 'oauth');
      const auth = await models.getAuth(provider);
      const token = provider === 'kimi-coding' ? auth.auth.headers.Authorization : auth.auth.apiKey;
      assert.ok(token.includes(secret));
      assert.ok(ui.events.some(event => ['auth_url', 'device_code'].includes(event.type)));
      if (ui.prompts.includes('manual_code')) assert.equal(ui.abortedPrompt(), true, 'Callback cancels the waiting manual prompt');
      assert.ok(mock.calls.length > 0);
      const before = mock.calls.length;
      if (provider !== 'openrouter') {
        await store.modify(provider, async () => ({ ...result, expires: 0 }));
        await models.getAuth(provider);
        assert.ok(mock.calls.length > before, 'Expired credentials use the provider refresh flow');
        assert.ok((await store.read(provider)).expires > Date.now(), 'Refreshed credentials are stored');
      } else assert.equal(result.expires, Number.MAX_SAFE_INTEGER, 'OpenRouter issues a permanent key');
      const saved = await store.read(provider);
      assert.ok(!JSON.stringify(await app.dispatch('configuration.get', {})).includes(secret));
      assert.deepEqual((await app.dispatch('session.list', {})).items, []);
      await app.close();
      const reopened = await openApplication(config);
      try {
        assert.deepEqual(await reopened.credentials.read(provider), saved);
        assert.equal((await reopened.models.checkAuth(provider)).type, 'oauth');
      } finally { await reopened.close(); }
    } finally { mock.restore(); }
  });
});

test('browser alternatives support pasted codes and device login', async t => {
  for (const [provider, method, manual] of [
    ['anthropic', 'copy_code', true], ['anthropic', 'browser', true],
    ['openai', 'browser', true], ['openai-codex', 'browser', true],
    ['openai-codex', 'device_code', false], ['openrouter', 'browser', true], ['radius', 'device-code', false],
  ]) await t.test(`${provider} ${method}${manual ? ' pasted' : ''}`, async t => {
    const mock = installOAuthMock(), { models } = await application(t);
    try {
      const ui = interaction(provider, { method, manual });
      assert.equal((await models.login(provider, 'oauth', ui, { getDeviceId: () => deviceId })).type, 'oauth');
      await Promise.all(ui.callbacks);
      assert.ok(mock.calls.some(call => call.path.includes('token') || call.path.endsWith('/keys')));
    } finally { mock.restore(); }
  });
});

test('Radius refresh stores its account model catalog and restores it without network access', async t => {
  const mock = installOAuthMock(), { app, models, store, config } = await application(t);
  try {
    await models.login('radius', 'oauth', interaction('radius', { method: 'device-code' }));
    const result = await models.refresh({ providers: ['radius'] });
    assert.equal(result.errors.size, 0);
    assert.equal(result.aborted, false);
    const expected = [{ provider: 'radius', id: 'harness-radius-test', name: 'Harness Radius test' }];
    assert.deepEqual((await app.dispatch('configuration.get', {})).models.filter(model => model.provider === 'radius'), expected);
    assert.equal(mock.calls.filter(call => call.path === '/v1/config').length, 1);
    assert.equal((await store.catalogs.read('radius')).models[0].id, expected[0].id);
    await app.close();
    const before = mock.calls.length, reopened = await openApplication(config);
    try {
      assert.deepEqual((await reopened.dispatch('configuration.get', {})).models.filter(model => model.provider === 'radius'), expected);
      assert.equal(mock.calls.length, before, 'Opening stored state must not contact the provider');
    } finally { await reopened.close(); }
  } finally { mock.restore(); }
});

test('cancel every OAuth flow before exchange without replacing existing credentials', async t => {
  for (const provider of expected) await t.test(provider, async t => {
    const mock = installOAuthMock(), { models, store } = await application(t);
    const prior = { type: 'api_key', key: 'original-credential' }; await store.modify(provider, async () => prior);
    try {
      const ui = interaction(provider, { cancel: true });
      await assert.rejects(models.login(provider, 'oauth', ui, { getDeviceId: () => deviceId }));
      assert.deepEqual(await store.read(provider), prior);
      assert.ok(!mock.calls.some(call => call.grant === 'authorization_code'));
    } finally { mock.restore(); }
  });
});

test('device denial, expiry, pending approval, and failed refresh preserve stored credentials', async t => {
  for (const failure of ['access_denied', 'expired_token']) await t.test(failure, async t => {
    const mock = installOAuthMock({ failure }), { models, store } = await application(t);
    const prior = { type: 'api_key', key: 'original' }; await store.modify('xai', async () => prior);
    try {
      await assert.rejects(models.login('xai', 'oauth', interaction('xai')), /denied|expired/);
      assert.deepEqual(await store.read('xai'), prior);
    } finally { mock.restore(); }
  });
  await t.test('pending then approved', async t => {
    const mock = installOAuthMock({ pending: 1 }), { models, store } = await application(t);
    try {
      await models.login('xai', 'oauth', interaction('xai'));
      assert.equal(mock.calls.filter(call => call.path.endsWith('/token')).length, 2);
      const previous = { ...await store.read('xai'), expires: 0 }; await store.modify('xai', async () => previous);
      mock.control.failure = 'invalid_grant';
      await assert.rejects(models.getAuth('xai'));
      assert.deepEqual(await store.read('xai'), previous);
    } finally { mock.restore(); }
  });
});

test('OpenAI occupied callback port reports failure before token exchange', async t => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(1455, '127.0.0.1', resolve); });
  const mock = installOAuthMock(), { models } = await application(t);
  try {
    await assert.rejects(models.login('openai', 'oauth', interaction('openai'), { getDeviceId: () => deviceId }), /Port 1455 is in use/);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); await new Promise(resolve => server.close(resolve)); }
});
