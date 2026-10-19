import { fstatSync } from 'node:fs';
import { openApplication } from './pi.mjs';
import { appError, limits, parseRequest, publicError } from './protocol.mjs';

process.umask(0o077);
let application, ending = false, greeted = false, buffered = Buffer.alloc(0), blocked = false, closingOutput = false, inputPaused = false;
const requests = new Set(), responses = [], watches = new Map();
let responseBytes = 0, reservedBytes = 0;
const controlReserve = limits.clients * limits.pending_requests * 1024;
const queuedBytes = () => responseBytes + process.stdout.writableLength + reservedBytes;
function flowInput() {
  if (ending) return;
  if (queuedBytes() >= limits.output_bytes - controlReserve) { inputPaused = true; process.stdin.pause(); }
  else if (inputPaused) {
    inputPaused = false;
    queueMicrotask(() => { consume(); if (!inputPaused && !ending) process.stdin.resume(); });
  }
}
function flush() {
  if (blocked) { flowInput(); return; }
  while (responses.length || watches.size) {
    let line;
    if (responses.length) { line = responses.shift(); responseBytes -= Buffer.byteLength(line); }
    else { const [id, value] = watches.entries().next().value; watches.delete(id); line = value; }
    if (!process.stdout.write(line)) { blocked = true; flowInput(); return; }
  }
  flowInput();
  if (closingOutput && !requests.size) process.stdout.end();
}
function send(record, mayReduce = false) {
  let line = `${JSON.stringify(record)}\n`, delivered = true;
  if (record.method === 'session.state') {
    if (Buffer.byteLength(line) > limits.record_bytes) return false;
    watches.set(record.params.watch_id, line);
  } else {
    if (mayReduce && queuedBytes() + Buffer.byteLength(line) > limits.output_bytes - controlReserve) {
      line = `${JSON.stringify({jsonrpc:'2.0',id:record.id,error:publicError(appError('resource_limit','Worker output queue is full'))})}\n`;
      delivered = false;
    }
    responseBytes += Buffer.byteLength(line); responses.push(line);
  }
  flush(); return delivered;
}
process.stdout.on('drain', () => { blocked = false; flush(); });
process.stdout.on('error', () => { void finish(); });
async function finish() {
  if (ending) return; ending = true; process.stdin.pause();
  try { await application?.close(); } catch { process.stderr.write('Worker cleanup failed\n'); }
  process.exitCode = 0;
  process.stdin.destroy();
  if (!blocked) process.stdout.end();
  // A dead parent must not keep the storage lock through an unread output pipe.
  setTimeout(() => process.exit(0), 100).unref();
}
async function dispatch(bytes) {
  let request, admitted = false, reservation = 0;
  try {
    request = parseRequest(bytes);
    if (requests.has(request.id)) throw appError('conflict', 'Request id is already pending');
    if (requests.size >= limits.clients * limits.pending_requests) throw appError('resource_limit', 'Worker request limit reached');
    if (!greeted && request.method !== 'system.hello') throw appError('incompatible_version', 'Call system.hello first');
    const control = !['configuration.get', 'session.create', 'session.configure', 'session.watch', 'session.get', 'session.list', 'transcript.list', 'entry.read'].includes(request.method);
    const cost = ['session.create', 'session.configure'].includes(request.method) ? limits.snapshot_bytes + 1024 : 2048;
    if (queuedBytes() + cost > limits.output_bytes - (control ? 0 : controlReserve)) throw appError('resource_limit', 'Worker output capacity is reserved');
    reservation = cost; reservedBytes += reservation;
    requests.add(request.id); admitted = true;
    const value = await application.dispatch(request.method, request.params, request.id, send);
    reservedBytes -= reservation; reservation = 0;
    if (request.method === 'system.hello') greeted = true;
    if (request.method === 'session.unwatch') watches.delete(request.params.watch_id);
    if (request.method === 'worker.release') for (const id of request.params.watch_ids) watches.delete(id);
    if (request.method === 'session.watch') {
      if (send({ jsonrpc: '2.0', id: request.id, result: value.result }, true)) value.start();
      else await application.unwatch(value.result.watch_id);
    }
    else send({ jsonrpc: '2.0', id: request.id, result: value }, ['configuration.get', 'session.list', 'session.get', 'transcript.list', 'entry.read'].includes(request.method));
    if (request.method === 'worker.close' || request.method === 'worker.shutdown') { ending = true; closingOutput = true; watches.clear(); process.stdin.destroy(); }
  } catch (error) {
    reservedBytes -= reservation; reservation = 0;
    if (!error?.code) process.stderr.write(`Internal error for request ${request?.id ?? 'invalid'}\n`);
    send({ jsonrpc: '2.0', id: request?.id ?? null, error: publicError(error) });
  } finally { if (admitted) requests.delete(request.id); if (closingOutput) flush(); }
}
function consume(part) {
  if (part) buffered = Buffer.concat([buffered, part]);
  let index;
  while (!inputPaused && !ending && (index = buffered.indexOf(10)) >= 0) {
    if (index + 1 > limits.record_bytes) { void finish(); return; }
    const line = buffered.subarray(0, index); buffered = buffered.subarray(index + 1);
    void dispatch(line);
    flowInput();
  }
  if (buffered.length >= limits.record_bytes && buffered.indexOf(10) < 0) void finish();
}
try {
  if (!process.env.HARNESS_LOCK_FD) throw Error('Storage ownership descriptor is missing');
  fstatSync(Number(process.env.HARNESS_LOCK_FD));
  application = await openApplication(JSON.parse(process.env.HARNESS_CONFIG));
  application.harness.closed.then(end => { if (end.reason === 'failed') { process.stderr.write('Pi storage failed\n'); void finish(); } });
  process.stdin.on('data', consume);
  process.stdin.on('end', () => { void finish(); });
  process.stdin.on('error', () => { void finish(); });
  process.on('SIGTERM', () => { void finish(); });
  process.on('SIGINT', () => { void finish(); });
} catch {
  process.stderr.write('Cannot open Pi worker; check configuration and storage paths\n');
  process.exitCode = 1;
}
