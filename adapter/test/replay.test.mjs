import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

async function open(directory, mode, resumed) {
  const models = createModels(), faux = fauxProvider({models:[{id:'test'}]}); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(CodingTools);
  registry.install(defineExtension({ name: 'test-only', tools: [defineTool({ name: 'safe_probe', description: 'Observe replay', parameters: { type: 'object', properties: {} }, replay: 'safe', execute: async (_args, _api, ctx) => {
    await appendFile(join(directory, 'effects'), 'effect\n');
    if (!resumed) { process.stdout.write('ready\n'); await new Promise((resolve, reject) => ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true })); }
    return { output: [{ type: 'text', text: 'Completed safe probe' }] };
  } })] }));
  const env = new NodeExecutionEnv({ cwd: directory });
  if (resumed) faux.setResponses([fauxAssistantMessage('Recovered')]);
  else faux.setResponses([fauxAssistantMessage(fauxToolCall(mode === 'safe' ? 'safe_probe' : 'bash', mode === 'safe' ? {} : { command: 'echo $$ > shell.pid; echo effect >> effects; sleep 30' }), { stopReason: 'toolUse' })]);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'db')), { models, registry, env: () => env, settings: { compaction: { backgroundTokens: 0 } } }, context);
  return { harness, env };
}
const childConfig = process.env.HARNESS_REPLAY_TEST_CONFIG;
if (childConfig) {
  const { directory, mode } = JSON.parse(childConfig), { harness } = await open(directory, mode, false);
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' }, cwd: directory } });
  setInterval(() => {}, 1000);
  await conversation.submit({ type: 'input', content: 'Run the replay test', requestId: 'replay', whenBusy: 'reject' }, context);
  if (mode === 'unsafe') {
    for (;;) { try { await readFile(join(directory, 'effects')); break; } catch { await delay(10); } }
    process.stdout.write('ready\n');
  }
} else {
  for (const mode of ['safe', 'unsafe']) test(`SIGKILL follows Pi ${mode} tool replay policy`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-replay-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, HARNESS_REPLAY_TEST_CONFIG: JSON.stringify({ directory, mode }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit'); let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const ready = await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw Error(`Replay child exited before tool start: ${diagnostics}`); })]);
    assert.match(String(ready[0]), /ready/); child.kill('SIGKILL'); await exit; clearTimeout(timer);
    if (mode === 'unsafe') { const pid = Number(await readFile(join(directory, 'shell.pid'), 'utf8')); try { process.kill(-pid, 'SIGKILL'); } catch {} }
    const { harness, env } = await open(directory, mode, true);
    t.after(async () => { await harness.close(context); await env.cleanup(context); });
    const conversation = await harness.root(context);
    const record = await harness.commit(tx => tx.submissionByRequest(conversation.id, 'replay'), context);
    const result = await (await harness.submission(record.id, context)).wait(context); assert.equal(result.status, 'done');
    assert.equal((await readFile(join(directory, 'effects'), 'utf8')).trim().split('\n').length, mode === 'safe' ? 2 : 1);
    if (mode === 'unsafe') {
      const entries = await conversation.entries({}, 100, undefined, context);
      assert.ok(entries.items.some(entry => entry.kind === 'pi.tool-result' && entry.data?.diagnostics?.some(item => item.code === 'interrupted')));
    }
  });
}
