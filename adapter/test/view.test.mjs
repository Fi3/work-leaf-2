import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../view.mjs';

test('provider failures give safe actions for authentication, access, limits and connection errors', () => {
  const cases = [
    ['OpenAI API error (401): {"code":"invalid_api_key"}', /rejected the login.*\\login/],
    ['401 {"type":"authentication_error"}', /rejected the login.*\\login/],
    ['OpenAI API error (403): denied', /denied access.*permissions/],
    ['OpenAI API error (404): {"code":"model_not_found"}', /model is not available.*\\model/],
    ['OpenAI API error (429): {"code":"insufficient_quota"}', /no available quota.*billing/],
    ['HTTP 403 insufficient_quota', /no available quota.*billing/],
    ['The API organization has no credit. Check billing.', /no available quota or credit.*billing/],
    ['OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded"}', /ChatGPT shared usage.*Settings > Usage/],
    ['OpenAI API error (429): {"code":"rate_limit_exceeded"}', /rate limit.*Wait/],
    ['HTTP 503 unavailable', /temporarily unavailable.*Wait/],
    ['503 status code (no body)', /temporarily unavailable.*Wait/],
    ['OpenAI API error (400): {"code":"context_length_exceeded"}', /input is too large.*new chat/],
    ['OpenAI API error (400): {"code":"unsupported_parameter"}', /request format.*update Harness/],
    ['Connection error.', /connection failed.*network/],
    ['Stream ended before a terminal response event', /connection failed.*network/],
    ['Token expired', /rejected the login.*\\login/],
  ];
  for (const [detail, action] of cases) {
    const output = providerError(`${detail} SECRET_RESPONSE_BODY sk-secret https://secret.test/?token=secret \x1b[31m`);
    assert.match(output, action, detail);
    assert.doesNotMatch(output, /SECRET|sk-secret|secret\.test|\x1b/, detail);
  }
});

test('unknown provider details cannot become public diagnostic text', () => {
  const fallback = providerError(undefined);
  for (const detail of [null, {}, 401, '', 'PRIVATE_PRIVATE', 'sk-secret', 'https://secret.test/token', '\x1b[2J', '秘密λ'.repeat(20000)]) {
    assert.equal(providerError(detail), fallback);
  }
  assert.match(fallback, /\\model/);
});
