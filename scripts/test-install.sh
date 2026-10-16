#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
task_dir=$(mktemp -d "${TMPDIR:-/tmp}/harness-install-XXXXXX")
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
npm_config_offline=true sh scripts/install.sh "$task_dir/prefix"
HARNESS_INSTALL_TEST_DIR="$task_dir" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd(), directory = process.env.HARNESS_INSTALL_TEST_DIR;
const prefix = join(directory, 'prefix'), executable = join(prefix, 'bin/harness');
const share = join(prefix, 'share/harness'), workspace = join(directory, 'work');
const state = join(directory, 'state'), socket = join(directory, 'control.sock');
const config = join(directory, 'config.json'), responses = join(directory, 'responses.json');
const { fauxAssistantMessage } = await import(pathToFileURL(join(share, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
await mkdir(workspace); await mkdir(state);
await writeFile(config, JSON.stringify({ provider: 'faux', model: 'test', state_dir: state, socket_path: socket }));
await writeFile(responses, JSON.stringify([
  fauxAssistantMessage('Installed answer. é世界🙂'),
  fauxAssistantMessage('Pending answer. '.repeat(2000)),
]));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory,
  HARNESS_FAUX_RESPONSES: responses, HARNESS_FAUX_TOKENS_PER_SECOND: '1000' };
let serverPid, workerPid;

function command(program, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function cli(args, input = '', code = 0) {
  const result = await command(executable, [...args, '--config', config], input);
  assert.equal(result.code, code, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

const json = async (args, input, code) => JSON.parse(await cli(args, input, code));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function alive(pid) {
  try { return !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z '); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

try {
  const hello = await json(['start']);
  assert.equal(hello.ready, true); assert.equal(hello.state_dir, state);
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const args = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
    const parts = args.split('\0');
    if (parts[0] === executable && parts[1] === 'serve' && parts.includes(config)) serverPid = Number(name);
  }
  assert.ok(serverPid, 'The installed command must start the server');
  const children = (await readFile(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')).trim().split(/\s+/);
  assert.equal(children.length, 1); workerPid = Number(children[0]);
  const workerArgs = (await readFile(`/proc/${workerPid}/cmdline`, 'utf8')).split('\0');
  const workerPath = join(share, 'adapter/worker.mjs');
  assert.ok(workerArgs.includes(workerPath), 'The server must run the installed adapter');
  assert.ok(!workerArgs.some(arg => arg.startsWith(root)), 'The worker must not use source paths');
  await json(['session', 'create', '--id', 'work', '--workspace', workspace]);
  assert.equal((await json(['session', 'list'])).items[0].session_id, 'work');
  const accepted = await json(['send', '--session', 'work', '--request-id', 'first', '--stdin'], 'First task');
  assert.equal(accepted.status, 'accepted');
  const answer = await cli(['wait', '--session', 'work', '--request-id', 'first', '--timeout-ms', '10000', '--text']);
  assert.equal(answer, 'Installed answer. é世界🙂');
  const pending = await json(['send', '--session', 'work', '--request-id', 'second', '--stdin'], 'Second task');
  const stopped = await json(['stop', '--session', 'work', '--submission-id', pending.submission_id]);
  assert.equal(stopped.reason, 'cancelled');
  assert.deepEqual(await json(['wait', '--session', 'work', '--request-id', 'second'], '', 5), stopped);

  const lua = join(directory, 'installed.lua');
  await writeFile(lua, `
vim.opt.runtimepath:append(${JSON.stringify(join(share, 'nvim'))})
vim.cmd('runtime plugin/harness.lua')
local harness = require('harness')
assert(debug.getinfo(harness.setup, 'S').source == '@' .. ${JSON.stringify(join(share, 'nvim/lua/harness/init.lua'))})
harness.setup({ executable = ${JSON.stringify(executable)}, config_path = ${JSON.stringify(config)}, workspace = ${JSON.stringify(workspace)}, autostart = false })
vim.cmd('Harness attach work')
local transcript, prompt
assert(vim.wait(10000, function()
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    local name = vim.api.nvim_buf_get_name(buffer)
    if name == 'harness://transcript' then transcript = buffer end
    if name == 'harness://prompt' then prompt = buffer end
  end
  if not transcript then return false end
  local text = table.concat(vim.api.nvim_buf_get_lines(transcript, 0, -1, false), '\\n')
  return text:find('Connection: connected', 1, true) and text:find('Session: work', 1, true)
    and text:find('State: idle', 1, true) and text:find('Installed answer.', 1, true)
end, 20), 'The installed interface must show the stored answer')
assert(#vim.api.nvim_list_wins() == 3, 'Source, transcript, and prompt windows')
assert(not vim.bo[transcript].modifiable and vim.bo[prompt].modifiable)
vim.cmd('qa')
`);
  const editor = await command('nvim', ['--headless', '-u', 'NONE', '-l', lua]);
  assert.equal(editor.code, 0, editor.stderr);
  await cli(['shutdown']);
  for (let count = 0; count < 200 && (await alive(serverPid) || await alive(workerPid)); count++) await delay(25);
  assert.ok(!await alive(serverPid) && !await alive(workerPid), 'Shutdown must stop both installed processes');
  const lock = JSON.parse(await readFile(join(share, 'package-lock.json')));
  const report = {
    verified_at: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    neovim: execFileSync('nvim', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    install: 'npm ci --ignore-scripts --omit=dev with npm_config_offline=true in a new temporary prefix',
    binary_sha256: await hash(executable), npm_lock_sha256: await hash(join(share, 'package-lock.json')),
    npm_packages: Object.keys(lock.packages).filter(Boolean).length,
    worker_path: relative(prefix, workerPath), source_worker_used: false, provider_credentials_supplied: false,
    passed: ['detached startup', 'installed worker path', 'create and list session', 'send and complete Unicode answer',
      'stop and retained cancelled outcome', 'installed Neovim runtime attaches and shows stored answer',
      'three windows with read-only transcript and editable prompt', 'server and worker shutdown'],
    neovim_mode: 'headless installed-runtime smoke; interactive interface evidence is separate',
  };
  await writeFile(resolve(root, 'tests/evidence/clean-install.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Clean installation passed: installed Rust, Pi adapter, and Neovim runtime; no provider credentials.');
} finally {
  for (const pid of [serverPid, workerPid]) {
    if (pid && await alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
NODE
