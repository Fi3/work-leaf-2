import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function until(predicate, message) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}
export async function pty(t) {
  // Python's standard library supplies a real PTY; no terminal emulation package is needed.
  const child = spawn('python3', ['-u', '-c', `
import os, pty, select, sys, json, base64
master, slave = pty.openpty()
print(json.dumps({"path": os.ttyname(slave)}), flush=True)
while True:
    for fd in select.select([master, sys.stdin], [], [])[0]:
        if fd == master:
            data = os.read(master, 65536)
            print(json.dumps({"output": base64.b64encode(data).decode()}), flush=True)
        else:
            data = sys.stdin.readline()
            if not data: sys.exit(0)
            os.write(master, base64.b64decode(json.loads(data)["input"]))
`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const terminal = { text: '', write: value => child.stdin.write(JSON.stringify({ input: Buffer.from(value).toString('base64') }) + '\n') };
  let partial = '';
  child.stdout.on('data', bytes => {
    partial += bytes; let newline;
    while ((newline = partial.indexOf('\n')) >= 0) {
      const value = JSON.parse(partial.slice(0, newline)); partial = partial.slice(newline + 1);
      if (value.path) terminal.path = value.path;
      if (value.output) terminal.text += Buffer.from(value.output, 'base64').toString();
    }
  });
  t.after(() => new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.stdin.end(); } }));
  await until(() => terminal.path, 'PTY must open');
  terminal.wait = text => until(() => terminal.text.includes(text), `Terminal must show ${text}`);
  return terminal;
}
