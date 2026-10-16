import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRequest, limits, validate, publicError } from '../protocol.mjs';
import { chunk, preview, parseCursor, cursor, snapshot, fitPage } from '../view.mjs';

test('shared requests use the same contract in Node and Rust', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/protocol.json', import.meta.url)));
  for (const request of fixture.valid) assert.deepEqual(parseRequest(Buffer.from(JSON.stringify(request))), request);
  for (const item of fixture.invalid) assert.throws(() => parseRequest(Buffer.from(JSON.stringify(item.request))), { code: item.code });
  assert.throws(() => parseRequest(Buffer.from([0xff])), { code: -32700 });
  assert.throws(() => parseRequest(Buffer.from('{}')), { code: -32600 });
  assert.throws(() => parseRequest(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'x',method:'session.list',params:null}))), {code:-32602});
  assert.throws(() => parseRequest(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'x',method:4,params:{}}))), {code:-32600});
  assert.throws(() => validate('input.submit', { session_id: 's', request_id: 'r', text: 'λ'.repeat(limits.input_bytes), context: [] }), { data: { kind: 'resource_limit' } });
  assert.throws(() => validate('session.list', { ['x'.repeat(1000000)]: true }), error => error.code === -32602 && Buffer.byteLength(JSON.stringify(publicError(error))) < 1024);
});

test('Unicode previews and chunks preserve original text for varied byte limits', () => {
  for (const text of ['', 'plain', 'λ世界😀\n'.repeat(100), '\"\\\t\n'.repeat(100)]) {
    for (const limit of [4, 5, 7, 19, 64, 10000]) {
      const first = preview(text, limit); assert.ok(Buffer.byteLength(first.text) <= limit); assert.ok(text.startsWith(first.text));
      let position = 0, recovered = '';
      do { const part = chunk(text, position, limit); recovered += part.text; assert.ok(Buffer.byteLength(part.text) <= limit); position = part.next_offset; if (part.end) break; } while (true);
      assert.equal(recovered, text);
    }
  }
  assert.throws(() => chunk('😀', 1));
  assert.throws(() => chunk('😀', 0, 1));
  assert.throws(() => chunk('x', 2));
});

test('cursors reject another session or query', () => {
  const value = cursor('first', 'transcript', 10);
  assert.equal(parseCursor(value, 'first', 'transcript'), 10);
  assert.throws(() => parseCursor(value, 'second', 'transcript'));
  assert.throws(() => parseCursor(value, 'first', 'sessions'));
});

test('encoded snapshot and page bounds include JSON escape expansion', async () => {
  const metadata = {session_id:'large',workspace:'/tmp',provider:'faux',model:'test',instructions:'x'.repeat(limits.snapshot_bytes - 18000),schema_version:1,tools:['read','write','edit','bash']};
  const value = snapshot(metadata, {entries:[{id:1,kind:'pi.assistant',model:[{content:[{type:'text',text:'\0'.repeat(8192)}]}]}],docs:{}});
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= limits.snapshot_bytes);
  assert.equal(value.assistant.truncated, true); assert.equal(value.truncated, true);
  const page = fitPage(Array.from({length:100},(_,id)=>({entry_id:String(id),text:'\0'.repeat(8192)})));
  assert.ok(page.length > 0 && page.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify({items:page,next_cursor:'cursor'})) < limits.record_bytes);
  assert.throws(() => parseCursor(Buffer.from('null').toString('base64url'),'first','transcript'), {code:-32602});
});
