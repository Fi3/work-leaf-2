import { appendFileSync } from 'node:fs';

export const secret = 'oauth-test-secret-DO-NOT-PRINT';
const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.${secret}`;
const device = { device_code: 'test-device', user_code: 'TEST-CODE', verification_uri: 'https://login.example.test/device',
  verification_uri_complete: 'https://login.example.test/device?code=TEST-CODE', expires_in: 60, interval: 0.01 };
const endpoints = new Map([
  ['platform.claude.com/v1/oauth/token', 'token'],
  ['auth.openai.com/api/accounts/oauth/token', 'token'],
  ['auth.openai.com/oauth/token', 'token'],
  ['auth.openai.com/api/accounts/deviceauth/usercode', 'codex-device'],
  ['auth.openai.com/api/accounts/deviceauth/token', 'codex-code'],
  ['github.com/login/device/code', 'device'],
  ['github.com/login/oauth/access_token', 'token'],
  ['api.github.com/copilot_internal/v2/token', 'copilot'],
  ['api.individual.githubcopilot.com/models', 'models'],
  ['auth.kimi.com/api/oauth/device_authorization', 'device'],
  ['auth.kimi.com/api/oauth/token', 'token'],
  ['auth.meta.com/oidc/device/authorization/', 'device'],
  ['auth.meta.com/oidc/device/token/', 'token'],
  ['api.meta.ai/muse-code/key', 'meta-key'],
  ['openrouter.ai/api/v1/auth/keys', 'key'],
  ['radius.pi.dev/v1/oauth', 'discovery'],
  ['radius.pi.dev/v1/oauth/token', 'token'],
  ['radius.pi.dev/v1/oauth/device', 'device'],
  ['radius.pi.dev/v1/config', 'radius-models'],
  ['auth.x.ai/oauth2/device/code', 'device'],
  ['auth.x.ai/oauth2/token', 'token'],
]);

// The installed providers run unchanged. Only their external HTTP replies are replaced.
// Unknown URLs fail closed, so these tests cannot reach a model or a real account.
export function installOAuthMock({ record, failure, pending = 0 } = {}) {
  const original = globalThis.fetch, calls = [];
  let refreshes = 0;
  const control = { failure, pending };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const kind = endpoints.get(url.host + url.pathname);
    if (url.protocol !== 'https:' || !kind) throw Error(`Unexpected OAuth test request: ${url.origin}${url.pathname}`);
    init.signal?.throwIfAborted();
    const text = String(init.body ?? '');
    const body = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    const grant = body.grant_type;
    const call = { host: url.host, path: url.pathname, method: init.method ?? 'GET', ...(grant ? { grant } : {}) };
    calls.push(call);
    if (record) appendFileSync(record, JSON.stringify(call) + '\n');
    const tokenRequest = ['token', 'key', 'copilot', 'meta-key', 'codex-code'].includes(kind);
    if (tokenRequest && (control.failure || control.pending-- > 0)) {
      const error = control.failure ?? 'authorization_pending';
      return Response.json({ error, error_description: secret }, { status: url.host === 'github.com' ? 200 : 400 });
    }
    if (grant === 'refresh_token' || kind === 'copilot' || kind === 'meta-key') refreshes++;
    const token = { access_token: jwt + refreshes, refresh_token: `${secret}-refresh-${refreshes}`, expires_in: 3600,
      id_token: 'synthetic-id-token', scope: 'openid chatgpt.tokens.use.direct' };
    const replies = {
      token, device, 'codex-device': { device_auth_id: 'test-device', user_code: device.user_code, interval: 0.01 },
      'codex-code': { authorization_code: 'test-code', code_verifier: 'test-verifier' },
      copilot: { token: `${secret}-${refreshes}`, expires_at: Math.floor(Date.now() / 1000) + 3600 },
      models: { data: [{ id: 'gpt-4o', model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { supports: { tool_calls: true } } }] },
      'meta-key': { api_key: `${secret}-${refreshes}` }, key: { key: secret },
      discovery: { authorizationEndpoint: 'https://radius.pi.dev/authorize' },
      'radius-models': { baseUrl: 'https://radius.pi.dev', models: [{
        id: 'harness-radius-test', name: 'Harness Radius test', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
      }] },
    };
    return Response.json(replies[kind]);
  };
  return { calls, control, restore() { globalThis.fetch = original; } };
}

if (process.env.HARNESS_TEST_OAUTH_RECORD) installOAuthMock({
  record: process.env.HARNESS_TEST_OAUTH_RECORD, pending: Number(process.env.HARNESS_TEST_OAUTH_PENDING ?? 0),
});
