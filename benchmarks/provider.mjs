import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// This fixture replaces network access, not Pi's model loop, SDK, or coding tools.
const profile = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url)));
const answer = 'Synthetic benchmark answer. '.repeat(Math.ceil(profile.simulated_output_bytes / 28)).slice(0, profile.simulated_output_bytes);
let sequence = 0;

function responseEvents(body, id) {
  const last = body.input.at(-1);
  const tool = last?.type !== 'function_call_output' && body.tools?.some(item => item.name === 'bash');
  const item = tool
    ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'bash',
      arguments: JSON.stringify({ command: "python3 -c \"print('benchmark tool output ' * 2048)\"" }), status: 'completed' }
    : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], arguments: '' } },
  ];
  if (tool) events.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
  else for (let offset = 0; offset < answer.length; offset += 64) {
    events.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer.slice(offset, offset + 64) });
  }
  events.push({ type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: {
      input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body.input)) / 4), output_tokens: tool ? 32 : Math.ceil(answer.length / 4),
      input_tokens_details: { cached_tokens: 0 },
    } } });
  return events;
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url !== 'https://api.openai.com/v1/responses'
    || new Headers(init.headers).get('authorization') !== 'Bearer sk-benchmark-synthetic') {
    throw Error('Benchmark permits only the synthetic model endpoint and credential');
  }
  const body = JSON.parse(init.body);
  if (body.model !== profile.model || body.stream !== true) throw Error('Unexpected benchmark model request');
  const events = responseEvents(body, `bench_${++sequence}`);
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for (const event of events) {
          if (cancelled) return;
          init.signal?.throwIfAborted();
          controller.enqueue(Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          await delay(profile.simulated_chunk_delay_ms);
        }
        if (!cancelled) controller.close();
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
};
