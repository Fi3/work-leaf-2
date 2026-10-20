import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { installOAuthMock, secret as oauthSecret } from './oauth.mjs';

export const apiKey = 'sk-generation-test-NOT-FOR-OUTPUT';
export const accountToken = 'generation-account-token-NOT-FOR-OUTPUT';
export const answer = 'OpenAI streamed λ 世界 and completed the task.';

function events(scenario, index) {
  const id = `resp_fixture_${index}`;
  if (scenario.kind === 'failed') return [
    { type: 'response.created', response: { id } },
    { type: 'response.failed', response: { id, status: 'failed', error: {
      ...(scenario.code ? { code: scenario.code } : {}),
      message: `${scenario.message} ${apiKey} ${accountToken} ${oauthSecret}`,
    } } },
  ];
  const item = scenario.kind === 'tool'
    ? { type: 'function_call', id: `fc_fixture_${index}`, call_id: `call_fixture_${index}`,
      name: 'bash', arguments: JSON.stringify({ command: "printf 'provider tool ran\\n' | tee provider-result.txt" }), status: 'completed' }
    : { type: 'message', id: `msg_fixture_${index}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const result = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], arguments: '' } },
  ];
  if (scenario.kind === 'tool') {
    result.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
  } else {
    result.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OpenAI streamed λ 世界' });
    result.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' and completed the task.' });
  }
  if (scenario.kind !== 'incomplete') result.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } } } },
  );
  return result;
}

// Exercise the installed OpenAI SDK and Pi parser. No real provider request is permitted.
export function installGenerationMock({ scenarios = [{ kind: 'answer' }], record, control, oauthRecord } = {}) {
  const oauth = installOAuthMock({ record: oauthRecord }), fallback = globalThis.fetch, requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href !== 'https://api.openai.com/v1/responses') return fallback(input, init);
    const selected = control ? JSON.parse(readFileSync(control, 'utf8')).responses : scenarios;
    const scenario = selected[Math.min(requests.length, selected.length - 1)];
    const headers = new Headers(init.headers), token = headers.get('authorization') ?? '';
    if (![`Bearer ${apiKey}`, `Bearer ${accountToken}`].includes(token) && !token.includes(oauthSecret)) {
      throw Error('Generation fixture rejects a non-test credential');
    }
    const body = JSON.parse(init.body);
    const summary = { model: body.model, stream: body.stream, credential_kind: token.startsWith('Bearer sk-') ? 'api_key' : 'oauth',
      tools: (body.tools ?? []).map(tool => tool.name), input_items: body.input.length, response: scenario.kind };
    requests.push({ body, ...summary });
    if (record) appendFileSync(record, JSON.stringify(summary) + '\n');
    if (scenario.kind === 'network') throw new TypeError('Synthetic connection failure');
    if (scenario.kind === 'http') {
      return Response.json({ error: { code: scenario.code, type: 'invalid_request_error',
        message: `${scenario.message ?? 'Rejected synthetic request'} ${apiKey} ${accountToken} ${oauthSecret}` } },
      { status: scenario.status, headers: { 'x-request-id': 'synthetic-request-id', 'x-should-retry': 'false' } });
    }
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const event of events(scenario, requests.length)) {
            if (closed) return;
            init.signal?.throwIfAborted();
            const bytes = Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            // Split within a multibyte character when present, and within a JSON frame otherwise.
            const unicode = bytes.indexOf(0xce), boundary = unicode < 0 ? Math.floor(bytes.length / 2) : unicode + 1;
            controller.enqueue(bytes.subarray(0, boundary));
            controller.enqueue(bytes.subarray(boundary));
            await delay(scenario.delay_ms ?? 20);
          }
          if (!closed) controller.close();
        } catch (error) { if (!closed) controller.error(error); }
      },
      cancel() { closed = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { requests, restore() { oauth.restore(); } };
}

if (process.env.HARNESS_TEST_GENERATION_RECORD) {
  installGenerationMock({ record: process.env.HARNESS_TEST_GENERATION_RECORD, control: process.env.HARNESS_TEST_GENERATION_CONTROL,
    oauthRecord: process.env.HARNESS_TEST_OAUTH_RECORD });
}
