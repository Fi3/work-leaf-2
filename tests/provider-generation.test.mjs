import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openApplication } from '../adapter/pi.mjs';
import { apiKey, accountToken, answer, installGenerationMock } from './fixtures/generation.mjs';
import { secret as oauthSecret } from './fixtures/oauth.mjs';
import { application as openTestApplication } from './fixtures/application.mjs';

async function application(t, type = 'api_key') {
  const { app, config, workspace, call } = await openTestApplication(t, { prefix: 'harness-provider-',
    settings: { provider: 'openai', model: 'gpt-6-sol', instructions: '' } });
  await app.credentials.modify('openai', async () => type === 'api_key'
    ? { type, key: apiKey } : { type, access: accountToken, refresh: 'synthetic-refresh', expires: Date.now() + 3600000, clientId: 'test-client' });
  await call('session.create', { session_id: 'chat', workspace });
  const send = request_id => call('input.submit', { session_id: 'chat', request_id, text: 'Run the provider test.', context: [] });
  const wait = request_id => call('submission.wait', { session_id: 'chat', request_id, timeout_ms: 25000 });
  return { app, config, call, send, wait, workspace };
}

function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [apiKey, accountToken, oauthSecret]) assert.ok(!text.includes(secret), 'Public output must omit provider credentials');
}

test('OpenAI API-key and account requests use the real SDK, stream Unicode, execute a tool, and retain the answer', async t => {
  for (const type of ['api_key', 'oauth']) await t.test(type, async t => {
    const mock = installGenerationMock({ scenarios: [{ kind: 'tool' }, { kind: 'answer', delay_ms: 40 }] });
    const { app, config, call, send, wait, workspace } = await application(t, type);
    t.after(() => mock.restore());
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = apiKey;
    t.after(() => {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    });
    const frames = [], watch = await app.dispatch('session.watch', { session_id: 'chat' }, 'watch', frame => frames.push(frame.params.snapshot));
    watch.start();
    const receipt = await send('first'), result = await wait('first');
    assert.equal(result.status, 'done');
    assert.equal(result.submission_id, receipt.submission_id);
    assert.equal((await call('entry.read', { session_id: 'chat', entry_id: result.answer_entry_id })).text, answer);
    assert.equal(await readFile(join(workspace, 'provider-result.txt'), 'utf8'), 'provider tool ran\n');
    assert.equal(mock.requests.length, 2, 'The tool result causes exactly one follow-up model request');
    for (const request of mock.requests) {
      assert.equal(request.model, 'gpt-6-sol');
      assert.equal(request.credential_kind, type);
      assert.equal(request.stream, true);
      assert.deepEqual(request.tools, ['read', 'write', 'edit', 'bash']);
      if (type === 'oauth') assert.ok(!('max_output_tokens' in request.body), 'Subscription requests omit unsupported output limits');
    }
    assert.ok(mock.requests[1].body.input.some(item => item.type === 'function_call_output' && JSON.stringify(item).includes('provider tool ran')));
    assert.ok(frames.some(frame => frame.active_submission_id && frame.assistant.text.includes('\u03bb \u4e16\u754c')), 'A live snapshot must precede the final result');
    const snapshot = (await call('session.get', { session_id: 'chat' })).snapshot;
    assert.equal(snapshot.error, null);
    assert.ok(snapshot.entries.some(entry => entry.kind === 'tool' && entry.text.includes('provider tool ran')));
    noSecrets([snapshot, frames, result]);
    await app.close();
    const reopened = await openApplication(config);
    try {
      assert.deepEqual(await reopened.dispatch('submission.get', { session_id: 'chat', request_id: 'first' }), result);
      assert.equal((await reopened.dispatch('entry.read', { session_id: 'chat', entry_id: result.answer_entry_id })).text, answer);
      assert.equal(mock.requests.length, 2, 'Reopening completed work must not make another generation request');
    } finally { await reopened.close(); }
  });
});

test('OpenAI HTTP and stream failures expose a safe remedy in outcomes, entries, and reopened history', async t => {
  const cases = [
    ['login', { kind: 'http', status: 401, code: 'invalid_api_key' }, /\\login/],
    ['permission', { kind: 'http', status: 403, code: 'permission_denied' }, /permissions/],
    ['model', { kind: 'http', status: 404, code: 'model_not_found' }, /\\model/],
    ['quota', { kind: 'http', status: 429, code: 'insufficient_quota' }, /usage and billing/],
    ['subscription usage', { kind: 'http', status: 429, code: 'subscription_sharing_usage_limit_exceeded' }, /ChatGPT Settings > Usage/],
    ['request format', { kind: 'http', status: 400, code: 'unsupported_parameter' }, /request format/],
    ['API credits without an HTTP status', { kind: 'failed', message: 'The API organization has no credit. Check billing.' }, /usage and billing/],
    ['network', { kind: 'network' }, /network/],
    ['truncated stream', { kind: 'incomplete' }, /connection/],
  ];
  for (const [name, scenario, remedy] of cases) await t.test(name, async t => {
    const mock = installGenerationMock({ scenarios: [scenario] });
    const { app, config, call, send, wait } = await application(t);
    t.after(() => mock.restore());
    await send('failed');
    const result = await wait('failed'), snapshot = (await call('session.get', { session_id: 'chat' })).snapshot;
    assert.equal(result.status, 'unanswered');
    assert.equal(result.reason, 'provider_error');
    assert.match(result.message, remedy);
    assert.deepEqual(snapshot.error, { kind: 'provider_error', message: result.message });
    const entries = (await call('transcript.list', { session_id: 'chat' })).items;
    if (scenario.kind === 'incomplete') {
      assert.ok(entries.some(entry => entry.kind === 'assistant' && entry.text.includes('\u03bb \u4e16\u754c')), 'Partial output remains available');
    } else {
      const failure = entries.at(-1);
      assert.equal(failure.kind, 'error');
      assert.equal(failure.text, result.message);
      assert.equal((await call('entry.read', { session_id: 'chat', entry_id: failure.entry_id })).text, result.message);
    }
    noSecrets([result, snapshot, entries]);
    const requests = mock.requests.length;
    await app.close();
    const reopened = await openApplication(config);
    try {
      assert.deepEqual(await reopened.dispatch('submission.get', { session_id: 'chat', request_id: 'failed' }), result);
      assert.deepEqual((await reopened.dispatch('transcript.list', { session_id: 'chat' })).items, entries);
      assert.equal(mock.requests.length, requests);
    } finally { await reopened.close(); }
  });
});

test('OpenAI rate-limit retry uses Pi policy and completes the original accepted input once', async t => {
  const mock = installGenerationMock({ scenarios: [{ kind: 'http', status: 429, code: 'rate_limit_exceeded' }, { kind: 'answer' }] });
  const { app, call, send, wait } = await application(t);
  t.after(() => mock.restore());
  const frames = [], watch = await app.dispatch('session.watch', { session_id: 'chat' }, 'watch', frame => frames.push(frame.params.snapshot));
  watch.start();
  const receipt = await send('limited'), result = await wait('limited');
  assert.equal(result.status, 'done');
  assert.equal(result.submission_id, receipt.submission_id);
  assert.equal(mock.requests.length, 2);
  assert.ok(frames.some(frame => frame.activity?.retry), 'Retry progress remains visible');
  const snapshot = (await call('session.get', { session_id: 'chat' })).snapshot;
  assert.equal(snapshot.entries.filter(entry => entry.kind === 'user').length, 1);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.assistant.text, answer);
  noSecrets([snapshot, frames]);
});

test('Stopping an actual OpenAI stream preserves cancellation and permits the next input', async t => {
  const mock = installGenerationMock({ scenarios: [{ kind: 'answer', delay_ms: 1000 }, { kind: 'answer' }] });
  const { call, send, wait } = await application(t);
  t.after(() => mock.restore());
  const receipt = await send('stop');
  for (let tries = 0; tries < 100; tries++) {
    if ((await call('session.get', { session_id: 'chat' })).snapshot.assistant.text.includes('\u03bb \u4e16\u754c')) break;
    await delay(50);
  }
  assert.ok((await call('session.get', { session_id: 'chat' })).snapshot.assistant.text.includes('\u03bb \u4e16\u754c'));
  const stopped = await call('run.stop', { session_id: 'chat', submission_id: receipt.submission_id });
  assert.equal(stopped.reason, 'cancelled');
  assert.deepEqual(await wait('stop'), stopped);
  await send('next');
  assert.equal((await wait('next')).status, 'done');
  assert.equal(mock.requests.length, 2);
});
