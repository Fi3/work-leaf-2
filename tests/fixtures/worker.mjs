import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = JSON.parse(process.env.HARNESS_CONFIG);
const fixture = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
appendFileSync(`${config.state_dir}/worker-pids`, `${process.pid}\n`);
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const mode = process.env.HARNESS_FAKE_MODE;
process.on('SIGHUP', () => {});
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), { id, method, params } = request;
  if (method === 'system.hello') {
    send(id, { api_version: 1, node_version: process.version, artifacts: { durable: '1.3.0', ai: '1.3.0', chord: '1.3.0' }, ready: mode !== 'paused', scheduling_enabled: mode !== 'paused' });
    if (mode === 'crash') setTimeout(() => process.exit(9), 60);
  } else if (method === 'session.watch') {
    setTimeout(() => {
      const watch_id = `watch-${id}`;
      send(id, { watch_id, snapshot: fixture.snapshot });
    }, 50);
  } else if (method === 'session.list') send(id, fixture.list);
  else if (method === 'session.get') send(id, { session: fixture.snapshot.session, snapshot: fixture.snapshot });
  else if (method === 'submission.wait') { /* A pending operation must not block the next request. */ }
  else if (method === 'run.stop') send(id, fixture.outcomes[2]);
  else if (method === 'worker.release') {
    appendFileSync(`${config.state_dir}/released`, `${JSON.stringify(params)}\n`); send(id, {});
  } else if (method === 'worker.close' || method === 'worker.shutdown') { send(id, {}); process.exit(0); }
  else if (method === 'entry.read') send(id, { text: 'x'.repeat(65536), next_offset: 65536, end: false });
  else send(id, {});
}).on('close', () => {
  if (mode === 'orphan') setInterval(() => {}, 1000);
  else process.exit(0);
});
