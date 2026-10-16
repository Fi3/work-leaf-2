#!/usr/bin/env python3
"""Exercise the real Rust server and Pi adapter from an actual Neovim terminal."""
import hashlib
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from interactive import Editor, EVIDENCE, REPO, RESULTS, ARGS

BINARY = REPO / 'target/debug/harness'
MESSAGE = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux'; console.log(JSON.stringify(fauxAssistantMessage('Streamed answer λ 世界. '.repeat(400))));"], cwd=REPO, text=True))

class Rpc:
    def __init__(self, path):
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(15)
        self.socket.connect(str(path))
        self.input = self.socket.makefile('rb')
        self.serial = 0
        self.events = []
        self.request('system.hello', {'api_version': 1})

    def request(self, method, params=None):
        self.serial += 1
        identifier = str(self.serial)
        self.socket.sendall((json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params or {}}) + '\n').encode())
        while True:
            line = self.input.readline()
            if not line: raise ConnectionError('Server disconnected')
            record = json.loads(line)
            if 'method' in record:
                self.events.append(record)
                continue
            assert record['id'] == identifier, record
            assert 'error' not in record, record
            return record['result']

    def close(self):
        self.input.close()
        self.socket.close()

class RealEditor(Editor):
    def __init__(self, name, active=True, message=None, rate=25, foreground=False, startup=False, responses=None, drop_receipt=False, launcher=None):
        self.name = name
        self.root = EVIDENCE / name
        self.root.mkdir()
        (self.root / 'one').write_text('one\n')
        (self.root / 'two').write_text('two\n')
        self.socket_path = self.root / 'control.sock'
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'provider': 'faux', 'model': 'test', 'state_dir': str(self.root / 'state'), 'socket_path': str(self.socket_path), 'worker_path': str(REPO / 'adapter/worker.mjs')}))
        response_file = self.root / 'responses.json'
        response_file.write_text(json.dumps(responses or [message or MESSAGE] * 12))
        self.env = dict(os.environ, TERM='xterm-256color', HARNESS_REPO=str(REPO), HARNESS_EXECUTABLE=str(BINARY), HARNESS_WORKSPACE=str(self.root), HARNESS_CONFIG=str(self.config), HARNESS_SOCKET=str(self.socket_path), HARNESS_FAUX_RESPONSES=str(response_file), HARNESS_FAUX_TOKENS_PER_SECOND=str(rate))
        if drop_receipt:
            self.env.update(HARNESS_EXECUTABLE=str(REPO / 'tests/nvim/drop_receipt.py'), HARNESS_REAL_EXECUTABLE=str(BINARY), HARNESS_DROPPED_RECEIPT=str(self.root / 'dropped.json'))
        self.server = None
        self.observer = None
        self.request_ids = {}
        self.rpc = None
        if not startup:
            if foreground:
                self.log = open(self.root / 'serve.log', 'wb')
                self.server = subprocess.Popen([str(BINARY), '--config', str(self.config), 'serve'], env=self.env, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
                end = time.monotonic() + 10
                while not self.socket_path.exists() and time.monotonic() < end: time.sleep(.01)
            else: self.cli('start')
            self.rpc = Rpc(self.socket_path)
            deadline = time.monotonic() + 10
            while not self.rpc.request('system.hello', {'api_version': 1})['storage_ready']:
                assert time.monotonic() < deadline, 'Worker readiness timed out'
                time.sleep(.01)
            self.create('work')
            if active: self.submit('work', 'first')
        else:
            self.env['HARNESS_INITIAL_COMMAND'] = 'Harness'
        if launcher:
            self.env.update(NVIM_APPNAME='nvim', XDG_CONFIG_HOME=str(self.root / 'config'), XDG_DATA_HOME=str(self.root / 'data'), XDG_STATE_HOME=str(self.root / 'editor-state'), XDG_CACHE_HOME=str(self.root / 'cache'))
            user_init = self.root / 'config/nvim/init.lua'
            user_init.parent.mkdir(parents=True)
            user_init.write_text("vim.g.launcher_user_init = true\nvim.o.number = true\nvim.o.shadafile = 'NONE'\nvim.o.swapfile = false\nvim.cmd('edit one')\n" + ("vim.o.loadplugins = false\nvim.wo.wrap = false\nrequire('harness').setup({ width = 43, prompt_height = 5 })\n" if launcher == 'configured' else ''))
            command = [str(REPO / 'harness.sh'), '--config', str(self.config)] if launcher == 'plain' else [str(BINARY), '--config', str(self.config), 'nvim']
            self.launch(self.env, command)
            self.wait(lambda: b'one' in self.output, 'normal Neovim startup', timeout=15)
            self.command('lua vim.fn.writefile({vim.json.encode({windows=#vim.api.nvim_list_wins(), loaded=vim.g.loaded_harness, mapped=vim.fn.maparg(";","n")~="", panels=vim.fn.bufnr("harness://prompt")>0})}, vim.env.HARNESS_WORKSPACE .. "/before-sidebar.json")')
            self.wait(lambda: (self.root / 'before-sidebar.json').exists(), 'normal editor before opening sidebar')
            assert json.loads((self.root / 'before-sidebar.json').read_text()) == {'windows': 1, 'loaded': True, 'mapped': True, 'panels': False}
            assert not self.socket_path.exists(), 'Loading the launcher must not start the server'
            self.keys(';')
        else:
            self.launch(self.env)
        if startup:
            self.wait(self.socket_path.exists, 'Neovim starts the server', timeout=12)
            self.rpc = Rpc(self.socket_path)
            self.wait(lambda: self.rpc.request('system.hello', {'api_version': 1})['storage_ready'], 'Neovim waits for worker readiness', timeout=12)
            if launcher:
                assert self.rpc.request('session.list')['items'] == [], 'Opening the tree must not create an agent'
                self.keys('n')
                self.wait(lambda: b'New agent name:' in self.output, 'native agent name input')
                self.keys('work\r')
            self.wait(lambda: len(self.rpc.request('session.list')['items']) == 1, 'Neovim creates a session')
            self.session_id = self.rpc.request('session.list')['items'][0]['session_id']
        else: self.session_id = 'work'
        self.wait(lambda: 'Session: ' + self.session_id in self.panel_text(), 'actual session panels')
        self.observer = Rpc(self.socket_path)
        self.observer.request('session.watch', {'session_id': self.session_id})

    def cli(self, *args):
        result = subprocess.run([str(BINARY), '--config', str(self.config), *args], env=self.env, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        return result.stdout

    def create(self, session_id):
        return self.rpc.request('session.create', {'session_id': session_id, 'workspace': str(self.root)})

    def submit(self, session_id, request_id):
        receipt = self.rpc.request('input.submit', {'session_id': session_id, 'request_id': request_id, 'text': 'Continue with the test task.', 'context': []})
        self.request_ids[session_id] = request_id
        return receipt

    def snapshot(self, session_id='work'):
        return self.rpc.request('session.get', {'session_id': session_id})['snapshot']

    def stop(self, session_id='work'):
        target = self.snapshot(session_id)['active_submission_id']
        if target: return self.rpc.request('run.stop', {'session_id': session_id, 'submission_id': target})

    def outcome(self, session_id='work'):
        return self.rpc.request('submission.get', {'session_id': session_id, 'request_id': self.request_ids[session_id]})

    def reconnect_server(self):
        self.rpc.close()
        self.observer.close()
        self.observer = None
        self.cli('start')
        self.rpc = Rpc(self.socket_path)
        self.command('Harness')
        self.wait(lambda: 'Connection: connected' in self.panel_text(), 'reconnect after server failure')

    def finish(self):
        if self.alive():
            self.command('noautocmd qa!')
            self.exits()
        self.record()
        os.close(self.master)
        if self.rpc:
            for session in self.rpc.request('session.list')['items']: self.stop(session['session_id'])
            self.rpc.request('server.shutdown')
            self.rpc.close()
        if self.observer: self.observer.close()
        if self.server:
            self.server.wait(timeout=10)
            self.log.close()
        terminal = self.root / 'terminal.raw'
        RESULTS.append({'case': self.name, 'passed': True, 'terminal': str(terminal), 'sha256': hashlib.sha256(terminal.read_bytes()).hexdigest()})

def basic(command, answer, should_exit, label):
    editor = RealEditor(command + '-' + label)
    if command in ('q', 'wq'): editor.source(True)
    target = editor.snapshot()['active_submission_id']
    editor.prompt(command)
    editor.keys(answer)
    if should_exit: editor.exits()
    else: editor.stays()
    if answer == 'no\r':
        outcome = editor.outcome()
        assert outcome['status'] == 'unanswered' and outcome['reason'] == 'cancelled', outcome
        assert editor.observer.request('session.get', {'session_id': 'work'})['snapshot']['active_submission_id'] is None
    else: assert editor.snapshot()['active_submission_id'] == target
    editor.finish()

def exit_cases():
    for cmd in ('q', 'qa', 'wq', 'wqa'):
        for label, answer, exits in [('yes', 'yes\r', True), ('no', 'no\r', True), ('empty', '\r', False), ('invalid', 'Yes\r', False), ('escape', '\x1b', False), ('yes-escape', 'yes\x1b', False), ('space', 'yes \r', False)]:
            basic(cmd, answer, exits, label)

    editor = RealEditor('window-only')
    editor.command('q')
    editor.stays()
    assert editor.snapshot()['active_submission_id']
    editor.finish()

    for cmd in ('q', 'qa', 'wq', 'wqa'):
        editor = RealEditor(cmd + '-modified')
        editor.source(cmd in ('q', 'wq'))
        editor.command('call setline(1, "changed")')
        editor.prompt(cmd)
        editor.keys('yes\r')
        if cmd in ('q', 'qa'):
            editor.stays()
            assert (editor.root / 'one').read_text() == 'one\n'
        else:
            editor.exits()
            assert (editor.root / 'one').read_text() == 'changed\n'
        editor.finish()

    for cmd in ('qa', 'wqa'):
        editor = RealEditor(cmd + '-hidden-modified')
        editor.source()
        editor.command('call setline(1, "changed") | edit two | call setline(1, "second")')
        editor.prompt(cmd)
        editor.keys('yes\r')
        if cmd == 'qa': editor.stays()
        else:
            editor.exits()
            assert (editor.root / 'one').read_text() == 'changed\n'
            assert (editor.root / 'two').read_text() == 'second\n'
        editor.finish()

    for cmd in ('wq', 'wqa'):
        editor = RealEditor(cmd + '-write-failure')
        editor.source(True)
        editor.command('call setline(1, "changed") | set readonly')
        if cmd == 'wqa':
            editor.prompt(cmd)
            editor.keys('yes\r')
        else: editor.command(cmd)
        editor.stays()
        assert (editor.root / 'one').read_text() == 'one\n'
        editor.finish()

    for cmd in ('wq', 'wqa'):
        editor = RealEditor(cmd + '-cancel-write-intent')
        editor.source(True)
        editor.command('call setline(1, "changed")')
        editor.prompt(cmd)
        editor.keys('\x1b')
        editor.stays()
        assert (editor.root / 'one').read_text() == ('changed\n' if cmd == 'wq' else 'one\n')
        editor.finish()

    editor = RealEditor('guard-cleanup')
    editor.source(True)
    editor.prompt('q')
    editor.keys('\r')
    editor.stays()
    editor.command('lua vim.fn.writefile({tostring(#vim.api.nvim_list_wins())}, vim.env.HARNESS_WORKSPACE .. "/windows.txt")')
    editor.wait(lambda: (editor.root / 'windows.txt').exists(), 'guard leaves one original buffer window')
    assert (editor.root / 'windows.txt').read_text() == '1\n'
    editor.prompt('q')
    editor.keys('no\r')
    editor.exits()
    assert editor.outcome()['reason'] == 'cancelled'
    editor.finish()

def launcher_cases():
    for launcher in ('plain', 'configured'):
        editor = RealEditor('launcher-' + launcher, active=False, startup=True, launcher=launcher, rate=400)
        initial = (editor.root / 'config/nvim/init.lua').read_text()
        assert ("require('harness')" in initial) == (launcher == 'configured')
        editor.command('lua local p=vim.fn.bufnr("harness://prompt"); local t=vim.fn.bufnr("harness://transcript"); local w=vim.fn.win_findbuf(p)[1]; local s=vim.fn.win_findbuf(vim.fn.bufnr(vim.env.HARNESS_WORKSPACE .. "/one"))[1]; vim.fn.writefile({vim.json.encode({init=vim.g.launcher_user_init, cwd=vim.fn.getcwd(), windows=#vim.api.nvim_list_wins(), prompt=vim.bo[p].modifiable, transcript=vim.bo[t].modifiable, width=vim.api.nvim_win_get_width(w), height=vim.api.nvim_win_get_height(w), source=vim.api.nvim_win_get_width(s), source_wrap=vim.wo[s].wrap, prompt_wrap=vim.wo[w].wrap, transcript_wrap=vim.wo[vim.fn.win_findbuf(t)[1]].wrap, cleared=vim.env.HARNESS_NVIM_RUNTIME==nil and vim.env.HARNESS_NVIM_OPTIONS==nil})}, vim.env.HARNESS_WORKSPACE .. "/launcher.json")')
        editor.wait(lambda: (editor.root / 'launcher.json').exists(), 'launcher loads user configuration and native panels')
        observed = json.loads((editor.root / 'launcher.json').read_text())
        assert observed == {'init': True, 'cwd': str(editor.root), 'windows': 4, 'prompt': True, 'transcript': False, 'width': 43, 'height': 5 if launcher == 'configured' else 6, 'source': 43, 'source_wrap': launcher != 'configured', 'prompt_wrap': True, 'transcript_wrap': True, 'cleared': True}, observed
        assert editor.snapshot(editor.session_id)['session']['workspace'] == str(editor.root)
        editor.keys('iLauncher task λ 世界\x13')
        editor.wait(lambda: editor.snapshot(editor.session_id)['active_submission_id'], 'launcher input admission')
        editor.wait(lambda: 'assistant progress' in editor.panel_text(), 'launcher streamed output', timeout=10)
        editor.wait(lambda: editor.snapshot(editor.session_id)['state'] == 'idle', 'launcher stored final result', timeout=15)
        assert any(item['kind'] == 'user' and item['text'] == 'Launcher task λ 世界' for item in editor.snapshot(editor.session_id)['entries'])
        assert (editor.root / 'config/nvim/init.lua').read_text() == initial
        editor.command('qa')
        editor.exits()
        assert b'Keep the listed agent runs in the background?' not in editor.output
        editor.finish()

def integration_cases():
    launcher_cases()
    editor = RealEditor('sidebar-controls', active=False, startup=True, launcher='configured')
    editor.create('second')
    (editor.root / 'other').mkdir()
    editor.rpc.request('session.create', {'session_id': 'remote', 'workspace': str(editor.root / 'other')})
    editor.submit('work', 'work-task')
    editor.submit('second', 'second-task')
    editor.tree_row('work [')
    editor.keys('r')
    editor.wait(lambda: 'second [running]' in editor.panel_text('agents') and 'remote [idle]' in editor.panel_text('agents'), 'tree refreshes all workspace groups')
    editor.tree_row('- other (')
    editor.keys('\r')
    assert 'remote [' not in editor.panel_text('agents')
    editor.keys('\r')
    assert 'remote [idle]' in editor.panel_text('agents')
    editor.tree_row('second [')
    editor.keys('\r')
    editor.wait(lambda: 'Session: second' in editor.panel_text(), 'Enter selects second agent')
    editor.keys('iDraft survives tree hiding\x1b')
    editor.tree_row('work [')
    editor.keys('s')
    editor.wait(lambda: editor.outcome('work')['status'] == 'unanswered', 's stops the highlighted agent')
    assert editor.outcome('work')['reason'] == 'cancelled'
    assert editor.outcome('second')['status'] == 'accepted', 'Stopping a highlighted row must preserve another selected run'
    editor.keys('q')
    editor.command('lua vim.fn.writefile(vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt"),0,-1,false),vim.env.HARNESS_WORKSPACE .. "/tree-draft.txt")')
    editor.wait(lambda: (editor.root / 'tree-draft.txt').exists(), 'draft after sidebar hide')
    assert (editor.root / 'tree-draft.txt').read_text() == 'Draft survives tree hiding\n'
    editor.keys(';')
    editor.wait(lambda: 'second [running]' in editor.panel_text('agents'), 'semicolon reopens the sidebar')
    editor.tree_row('second [')
    editor.keys('n')
    editor.keys('bad name\r')
    assert len(editor.rpc.request('session.list')['items']) == 3, 'Invalid agent names cannot create sessions'
    editor.stays()
    editor.prompt('qa')
    editor.keys('no\r')
    editor.exits()
    assert editor.outcome('second')['reason'] == 'cancelled'
    editor.finish()

    editor = RealEditor('multiple-sessions')
    for session_id in ('second', 'other-client-only'):
        editor.create(session_id)
        editor.submit(session_id, 'first')
    editor.command('Harness attach second')
    editor.wait(lambda: 'Session: second' in editor.panel_text(), 'second attached session')
    editor.prompt('HarnessQuit')
    editor.keys('no\r')
    editor.exits()
    for session_id in ('work', 'second'): assert editor.outcome(session_id)['reason'] == 'cancelled'
    assert editor.snapshot('other-client-only')['active_submission_id']
    editor.finish()

    short = dict(MESSAGE, content=[{'type': 'text', 'text': 'Natural completion. ' * 40}])
    editor = RealEditor('completion-during-prompt', message=short, rate=200)
    editor.prompt('qa')
    editor.wait(lambda: editor.outcome()['status'] == 'done', 'natural completion during native prompt', timeout=10)
    editor.keys('no\r')
    editor.exits()
    assert editor.outcome()['status'] == 'done'
    editor.finish()

    editor = RealEditor('new-run-during-prompt')
    editor.prompt('qa')
    editor.stop()
    new = editor.submit('work', 'second')
    start = len(editor.output)
    editor.keys('yes\r')
    editor.wait(lambda: new['submission_id'].encode() in editor.output[start:], 'new target needs a new prompt')
    editor.keys('\x1b')
    editor.stays()
    assert editor.snapshot()['active_submission_id'] == new['submission_id']
    editor.finish()

    editor = RealEditor('connection-failure-during-stop', foreground=True)
    editor.prompt('qa')
    os.kill(editor.server.pid, signal.SIGSTOP)
    editor.keys('no\r')
    os.kill(editor.server.pid, signal.SIGKILL)
    editor.server.wait(timeout=5)
    editor.stays()
    editor.reconnect_server()
    editor.finish()

    editor = RealEditor('connection-failure-during-prompt', foreground=True)
    target = editor.snapshot()['active_submission_id']
    editor.prompt('qa')
    os.kill(editor.server.pid, signal.SIGKILL)
    editor.server.wait(timeout=5)
    editor.keys('yes\r')
    editor.stays()
    editor.reconnect_server()
    assert editor.snapshot()['active_submission_id'] == target
    editor.finish()

    editor = RealEditor('escape-during-stop-wait', foreground=True)
    editor.prompt('qa')
    children = Path(f'/proc/{editor.server.pid}/task/{editor.server.pid}/children').read_text().split()
    assert len(children) == 1, children
    worker = int(children[0])
    os.kill(worker, signal.SIGSTOP)
    try:
        editor.keys('no\r')
        editor.keys('\x1b')
        editor.stays()
    finally:
        os.kill(worker, signal.SIGCONT)
    editor.wait(lambda: editor.outcome()['status'] == 'unanswered', 'stop continues after exit cancellation')
    assert editor.outcome()['reason'] == 'cancelled'
    editor.stays()
    editor.finish()

    editor = RealEditor('forced-exit-and-recovery')
    target = editor.snapshot()['active_submission_id']
    editor.command('noautocmd qa!')
    editor.exits()
    assert editor.snapshot()['active_submission_id'] == target
    editor.record()
    os.close(editor.master)
    editor.launch(editor.env)
    editor.wait(lambda: b'Session: work' in editor.output, 'reconnect after forced editor exit')
    assert editor.snapshot()['active_submission_id'] == target
    editor.finish()

    editor = RealEditor('neovim-starts-missing-server', active=False, startup=True)
    editor.stays()
    assert editor.snapshot(editor.session_id)['state'] == 'idle'
    editor.command('qa')
    editor.exits()
    editor.finish()

    editor = RealEditor('hidden-unsent-draft', active=False)
    editor.command('lua vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false, {"Retained unsent text"})')
    editor.source(True)
    editor.command('Harness')
    editor.wait(lambda: 'Connection: connected' in editor.panel_text(), 'reopen hidden panels')
    editor.command('lua vim.fn.writefile(vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false), vim.env.HARNESS_WORKSPACE .. "/draft.txt")')
    editor.wait(lambda: (editor.root / 'draft.txt').exists(), 'draft after panel hide')
    assert (editor.root / 'draft.txt').read_text() == 'Retained unsent text\n'
    assert editor.snapshot()['active_submission_id'] is None
    editor.finish()

    editor = RealEditor('explicit-editor-context-and-streaming', active=False)
    editor.source()
    editor.command('lua vim.api.nvim_buf_set_lines(0, 0, -1, false, {"unsaved λ 世界", "selection line", "last line"}); vim.g.context_tick = vim.api.nvim_buf_get_changedtick(0)')
    editor.command('Harness context buffer')
    editor.source()
    editor.command('2,2Harness context selection')
    editor.command('lua vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false, {"Context request"})')
    editor.command('Harness send')
    editor.wait(lambda: editor.snapshot()['active_submission_id'], 'actual input admission')
    entries = editor.snapshot()['entries']
    assert any('unsaved λ 世界' in item['text'] and 'Explicit selection snapshot: one lines 2-2' in item['text'] for item in entries), entries
    editor.wait(lambda: editor.snapshot()['assistant']['text'], 'actual streamed assistant text')
    panel = editor.panel_text()
    assert 'assistant progress' in panel and 'Context request' in panel
    assert (editor.root / 'one').read_text() == 'one\n'
    editor.source()
    editor.command('lua vim.fn.writefile({vim.json.encode({modified=vim.bo.modified, unchanged=vim.g.context_tick == vim.api.nvim_buf_get_changedtick(0), windows=#vim.api.nvim_list_wins()})}, vim.env.HARNESS_WORKSPACE .. "/buffer.json")')
    editor.wait(lambda: (editor.root / 'buffer.json').exists(), 'editor responds during model output')
    observed = json.loads((editor.root / 'buffer.json').read_text())
    assert observed == {'modified': True, 'unchanged': True, 'windows': 3}, observed
    editor.finish()

    tool = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux'; console.log(JSON.stringify(fauxAssistantMessage(fauxToolCall('bash',{command:'echo tool-visible; sleep 1; echo tool-complete'}),{stopReason:'toolUse'})));"], cwd=REPO, text=True))
    editor = RealEditor('actual-tool-activity', responses=[tool, MESSAGE], rate=1000)
    editor.wait(lambda: 'bash' in editor.panel_text(), 'actual bash tool name')
    editor.stays()
    editor.wait(lambda: 'tool-complete' in editor.panel_text(), 'actual bash result', timeout=10)
    editor.finish()

    editor = RealEditor('lost-receipt-draft-and-duplicate', active=False, drop_receipt=True)
    editor.command('lua vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false, {"Original request"})')
    editor.command('Harness send')
    editor.wait(lambda: (editor.root / 'dropped.json').exists(), 'durable receipt before injected disconnect')
    receipt = json.loads((editor.root / 'dropped.json').read_text())
    editor.wait(lambda: 'Connection closed' in editor.panel_text(), 'visible uncertain receipt')
    editor.command('lua vim.fn.writefile(vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false), vim.env.HARNESS_WORKSPACE .. "/draft.txt")')
    editor.wait(lambda: (editor.root / 'draft.txt').exists(), 'retained draft')
    assert (editor.root / 'draft.txt').read_text() == 'Original request\n'
    editor.command('Harness')
    editor.wait(lambda: 'Connection: connected' in editor.panel_text(), 'reconnect after receipt loss')
    editor.command('lua vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false, {"New unsent request"})')
    editor.command('Harness send')
    editor.pump(.3)
    stored = editor.rpc.request('submission.get', {'session_id': 'work', 'request_id': receipt['request_id']})
    assert stored['submission_id'] == receipt['submission_id']
    inputs = [item for item in editor.snapshot()['entries'] if item['kind'] == 'user']
    assert len(inputs) == 1 and inputs[0]['text'] == 'Original request', inputs
    editor.command('lua vim.fn.writefile(vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt"), 0, -1, false), vim.env.HARNESS_WORKSPACE .. "/new-draft.txt")')
    editor.wait(lambda: (editor.root / 'new-draft.txt').exists(), 'new draft after duplicate retry')
    assert (editor.root / 'new-draft.txt').read_text() == 'New unsent request\n'
    editor.finish()

def main():
    if ARGS.group in ('all', 'exit'): exit_cases()
    if ARGS.group in ('all', 'integration'): integration_cases()
    evidence = {'nvim': subprocess.check_output(['nvim', '--version'], text=True).splitlines()[0], 'mode': 'real terminal, actual Rust server, actual Pi faux provider', 'cases': RESULTS}
    (EVIDENCE / 'results.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps({'passed': len(RESULTS), 'evidence': str(EVIDENCE / 'results.json')}))

if __name__ == '__main__':
    main()
