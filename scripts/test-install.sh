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
await writeFile(join(workspace, 'installed.txt'), 'Installed source file.\n');
await writeFile(config, JSON.stringify({ provider: 'faux', model: 'test', state_dir: state, socket_path: socket }));
await writeFile(responses, JSON.stringify([
  fauxAssistantMessage('Installed answer. é世界🙂'),
  fauxAssistantMessage('Pending answer. '.repeat(2000)),
  fauxAssistantMessage('Installed Enter answer.'),
]));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory,
  HARNESS_FAUX_RESPONSES: responses, HARNESS_FAUX_TOKENS_PER_SECOND: '1000' };
let serverPid, workerPid;

function command(program, args, input = '', environment = env, cwd = directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
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
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
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
  let streaming = false;
  for (let attempt = 0; attempt < 100 && !streaming; attempt++) {
    const records = (await cli(['rpc'], [
      { jsonrpc: '2.0', id: 'hello', method: 'system.hello', params: { api_version: 1 } },
      { jsonrpc: '2.0', id: 'get', method: 'session.get', params: { session_id: 'work' } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')).trim().split('\n').map(JSON.parse);
    streaming = records.find(value => value.id === 'get').result.snapshot.assistant.text.length > 0;
    if (!streaming) await delay(20);
  }
  assert.ok(streaming, 'The cancellable response must start before testing stop');
  const stopped = await json(['stop', '--session', 'work', '--submission-id', pending.submission_id]);
  assert.equal(stopped.reason, 'cancelled');
  assert.deepEqual(await json(['wait', '--session', 'work', '--request-id', 'second'], '', 5), stopped);

  const actualNvim = execFileSync('sh', ['-c', 'command -v nvim'], { encoding: 'utf8' }).trim();
  const wrappers = join(directory, 'bin'), userConfig = join(directory, 'nvim');
  await mkdir(wrappers); await mkdir(userConfig);
  await writeFile(join(wrappers, 'nvim'), '#!/bin/sh\nexec "$HARNESS_INSTALL_NVIM" --headless "$@"\n', { mode: 0o755 });
  const lua = join(userConfig, 'init.lua');
  await writeFile(lua, `
vim.g.install_user_config_loaded = true
vim.opt.number = true
vim.o.columns, vim.o.lines = 120, 40
vim.cmd.edit('installed.txt')
local content_window = vim.api.nvim_get_current_win()
local source_buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = function()
  vim.schedule(function()
    local ok, message = pcall(function()
      assert(vim.g.install_user_config_loaded and vim.o.number, 'Load normal user configuration')
      assert(vim.fn.getcwd() == ${JSON.stringify(workspace)}, 'Keep the caller project directory')
      assert(vim.env.HARNESS_NVIM_RUNTIME == nil and vim.env.HARNESS_NVIM_OPTIONS == nil)
      local harness = require('harness')
      assert(debug.getinfo(harness.setup, 'S').source == '@' .. ${JSON.stringify(join(share, 'nvim/lua/harness/init.lua'))})
      assert(#vim.api.nvim_list_wins() == 1, 'The launcher must keep the normal initial editor')
      assert(vim.fn.maparg(';', 'n') ~= '', 'Enable the sidebar key')
      vim.api.nvim_feedkeys(';', 'xt', false)
      local agents
      assert(vim.wait(10000, function()
        agents = vim.fn.bufnr('harness://agents')
        if agents == -1 then return false end
        for row, line in ipairs(vim.api.nvim_buf_get_lines(agents, 0, -1, false)) do
          if line:match('work %[') then
            vim.api.nvim_win_set_cursor(vim.fn.win_findbuf(agents)[1], { row, 0 })
            return true
          end
        end
        return false
      end, 20), 'The sidebar must list the installed session')
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'xt', false)
      local transcript, prompt
      assert(vim.wait(10000, function()
        for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
          local name = vim.api.nvim_buf_get_name(buffer)
          if name == 'harness://chat/work' then transcript = buffer end
          if name == 'harness://prompt/work' then prompt = buffer end
        end
        if not transcript then return false end
        local text = table.concat(vim.api.nvim_buf_get_lines(transcript, 0, -1, false), '\\n')
        return text:find('Connection: connected', 1, true) and text:find('Session: work', 1, true)
          and text:find('State: idle', 1, true) and text:find('Installed answer.', 1, true)
      end, 20), 'Selecting an agent must show the stored answer')
      assert(#vim.api.nvim_list_wins() == 3, 'Tree, main chat, and prompt windows')
      assert(vim.fn.win_findbuf(transcript)[1] == content_window, 'Use the normal file window for chat history')
      assert(vim.bo[transcript].buflisted, 'Chat history must be a listed buffer')
      assert(not vim.bo[transcript].modifiable and vim.bo[prompt].modifiable)
      vim.api.nvim_set_current_win(vim.fn.win_findbuf(prompt)[1])
      vim.api.nvim_buf_set_lines(prompt, 0, -1, false, { 'Installed Enter task' })
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'xt', false)
      assert(vim.wait(10000, function()
        local text = table.concat(vim.api.nvim_buf_get_lines(transcript, 0, -1, false), '\\n')
        return text:find('Installed Enter task', 1, true) and text:find('Installed Enter answer.', 1, true)
          and text:find('State: idle', 1, true)
      end, 20), 'Enter must send a task and show its final answer through the installed runtime')
      vim.cmd('buffer ' .. source_buffer)
      assert(vim.wait(1000, function()
        return vim.api.nvim_get_current_win() == content_window and vim.api.nvim_get_current_buf() == source_buffer
          and #vim.api.nvim_list_wins() == 2
      end), 'Native file selection finishes after the input window is removed')
      assert(vim.api.nvim_get_current_win() == content_window and vim.api.nvim_get_current_buf() == source_buffer)
      assert(#vim.api.nvim_list_wins() == 2 and vim.wo.number, 'File selection hides input and restores file options')
      vim.cmd('buffer ' .. transcript)
      assert(vim.api.nvim_get_current_win() == content_window and vim.api.nvim_get_current_buf() == transcript)
      assert(vim.wait(1000, function() return #vim.api.nvim_list_wins() == 3 end), 'Chat selection restores its input')
      local pid = vim.fn.getpid()
      local children = assert(io.open('/proc/' .. pid .. '/task/' .. pid .. '/children'))
      local processes = children:read('*a'); children:close()
      local installed_client = false
      for child in processes:gmatch('%d+') do
        if vim.uv.fs_readlink('/proc/' .. child .. '/exe') == ${JSON.stringify(executable)} then installed_client = true end
      end
      assert(installed_client, 'The installed runtime must use the installed command client')
    end)
    if not ok then io.stderr:write(tostring(message) .. '\\n'); vim.cmd('cquit 1') end
    vim.cmd('qa')
  end)
end })
`);
  const editor = await command(executable, ['nvim', '--config', config], '', {
    ...env, PATH: `${wrappers}:${env.PATH}`, HARNESS_INSTALL_NVIM: actualNvim,
    XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'),
  }, workspace);
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
      'stop and retained cancelled outcome', 'harness nvim loads normal user configuration and enables the sidebar key',
      'installed runtime uses the installed command client and shows stored answer',
      'semicolon opens the tree; Enter selects an agent',
      'three windows with agent tree, main chat and editable prompt',
      'Enter sends through installed client and displays the final answer',
      'native buffer commands switch between file and chat in one content window', 'server and worker shutdown'],
    neovim_mode: 'installed harness nvim launcher with actual Neovim in headless mode; interactive interface evidence is separate',
  };
  await writeFile(resolve(root, 'tests/evidence/clean-install.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Clean installation passed: installed Rust, Pi adapter, and Neovim runtime; no provider credentials.');
} finally {
  for (const pid of [serverPid, workerPid]) {
    if (pid && await alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
NODE
