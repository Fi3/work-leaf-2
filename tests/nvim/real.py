#!/usr/bin/env python3
"""Exercise the real Rust server and Pi adapter from an actual Neovim terminal."""
import contextlib
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from interactive import Editor, EVIDENCE, REPO, RESULTS, ARGS

sys.path.insert(0, str(REPO / 'tests/fixtures'))
from rpc import Rpc

BINARY = REPO / 'target/debug/harness'
MESSAGE = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux'; console.log(JSON.stringify(fauxAssistantMessage('Streamed answer λ 世界. '.repeat(400))));"], cwd=REPO, text=True))

class RealEditor(Editor):
    def __init__(self, name, active=True, message=None, rate=25, foreground=False, startup=False, responses=None, drop_receipt=False, launcher=None, first_run=False, oauth_mock=False, generation=None):
        self.server = self.observer = self.rpc = None
        self.request_ids = {}
        self.prepare_configuration(name, first_run, responses or [message or MESSAGE] * 12, rate)
        if oauth_mock or generation is not None: self.prepare_oauth()
        if generation is not None: self.prepare_generation(generation)
        if first_run: self.prepare_first_run()
        if drop_receipt:
            self.env.update(HARNESS_EXECUTABLE=str(REPO / 'tests/nvim/drop_receipt.py'), HARNESS_REAL_EXECUTABLE=str(BINARY), HARNESS_DROPPED_RECEIPT=str(self.root / 'dropped.json'))
        try:
            if startup: self.env['HARNESS_INITIAL_COMMAND'] = 'Harness'
            else: self.start_server(foreground, active)
            if launcher: self.launch_editor(launcher, first_run)
            else: self.launch(self.env)
            self.attach_session(startup, launcher)
        except BaseException:
            RealEditor.abort(self)
            raise

    def prepare_configuration(self, name, first_run, responses, rate):
        self.name = name
        self.root = EVIDENCE / name
        self.root.mkdir()
        (self.root / 'one').write_text('one\n')
        (self.root / 'two').write_text('two\n')
        self.socket_path = self.root / 'control.sock'
        self.config = self.root / 'config.json'
        if first_run:
            self.config = self.root / 'config/harness/config.json'
            self.socket_path = self.root / 'runtime/harness/control.sock'
            (self.root / 'runtime').mkdir(mode=0o700)
        else:
            self.config.write_text(json.dumps({'provider': 'faux', 'model': 'test', 'state_dir': str(self.root / 'state'), 'socket_path': str(self.socket_path), 'worker_path': str(REPO / 'adapter/worker.mjs')}))
        response_file = self.root / 'responses.json'
        response_file.write_text(json.dumps(responses))
        self.env = dict(os.environ, TERM='xterm-256color', HARNESS_REPO=str(REPO), HARNESS_EXECUTABLE=str(BINARY), HARNESS_WORKSPACE=str(self.root), HARNESS_CONFIG=str(self.config), HARNESS_SOCKET=str(self.socket_path), HARNESS_FAUX_RESPONSES=str(response_file), HARNESS_FAUX_TOKENS_PER_SECOND=str(rate))

    def prepare_oauth(self):
        self.env = {name:value for name,value in self.env.items() if name.startswith('HARNESS_') or name in ('PATH','TERM','LANG','LC_ALL','CARGO_HOME','RUSTUP_HOME')}
        self.env['HOME'] = str(self.root / 'home')
        self.env.update(NODE_OPTIONS='--import=' + str(REPO / 'tests/fixtures/oauth.mjs'),
                        HARNESS_TEST_OAUTH_RECORD=str(self.root / 'oauth-requests.jsonl'))
        directory = self.root / 'bin'
        directory.mkdir()
        opener = directory / 'xdg-open'
        opener.write_text('#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["HARNESS_BROWSER_LOG"],"a") as output: output.write(json.dumps(sys.argv[1:])+"\\n")\n')
        opener.chmod(0o700)
        self.env.update(PATH=str(directory)+':'+self.env['PATH'], HARNESS_BROWSER_LOG=str(self.root/'browser.jsonl'))

    def prepare_generation(self, generation):
        control = self.root / 'generation.json'
        control.write_text(json.dumps({'responses': generation}))
        self.env.update(NODE_OPTIONS='--import=' + str(REPO / 'tests/fixtures/generation.mjs'),
                        HARNESS_TEST_GENERATION_RECORD=str(self.root / 'generation-requests.jsonl'),
                        HARNESS_TEST_GENERATION_CONTROL=str(control),
                        OPENAI_API_KEY='sk-generation-test-NOT-FOR-OUTPUT')

    def prepare_first_run(self):
        self.env.pop('ANTHROPIC_API_KEY', None)
        self.env.update(HOME=str(self.root / 'home'), XDG_RUNTIME_DIR=str(self.root / 'runtime'),
                        CARGO_HOME=os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')),
                        RUSTUP_HOME=os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')))

    def connect_server(self):
        self.rpc = Rpc(self.socket_path)
        deadline = time.monotonic() + 10
        while not self.rpc.request('system.hello', {'api_version': 1})['storage_ready']:
            assert time.monotonic() < deadline, 'Worker readiness timed out'
            time.sleep(.01)

    def start_server(self, foreground, active):
        if foreground:
            self.log = open(self.root / 'serve.log', 'wb')
            self.server = subprocess.Popen([str(BINARY), '--config', str(self.config), 'serve'], env=self.env, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
            end = time.monotonic() + 10
            while not self.socket_path.exists() and time.monotonic() < end: time.sleep(.01)
        else: self.cli('start')
        self.connect_server()
        self.create('work')
        if active: self.submit('work', 'first')

    def launch_editor(self, launcher, first_run):
        self.env.update(NVIM_APPNAME='nvim', XDG_CONFIG_HOME=str(self.root / 'config'), XDG_DATA_HOME=str(self.root / 'data'), XDG_STATE_HOME=str(self.root / 'editor-state'), XDG_CACHE_HOME=str(self.root / 'cache'))
        user_init = self.root / 'config/nvim/init.lua'
        user_init.parent.mkdir(parents=True)
        user_init.write_text("vim.g.launcher_user_init = true\nvim.o.number = true\nvim.o.shadafile = 'NONE'\nvim.o.swapfile = false\nvim.cmd('edit one')\n" + ("vim.o.loadplugins = false\nvim.wo.wrap = false\nrequire('harness').setup({ width = 43, prompt_height = 5 })\n" if launcher == 'configured' else ''))
        command = [str(REPO / 'harness.sh')] + ([] if first_run else ['--config', str(self.config)]) if launcher == 'plain' else [str(BINARY), '--config', str(self.config), 'nvim']
        self.launch(self.env, command)
        self.wait(lambda: b'one' in self.output, 'normal Neovim startup', timeout=15)
        self.command('lua vim.fn.writefile({vim.json.encode({window=vim.api.nvim_get_current_win(), windows=#vim.api.nvim_list_wins(), loaded=vim.g.loaded_harness, mapped=vim.fn.maparg(";","n")~="", panels=vim.fn.bufnr("harness://prompt/.*")>0})}, vim.env.HARNESS_WORKSPACE .. "/before-sidebar.json")')
        self.wait(lambda: (self.root / 'before-sidebar.json').exists(), 'normal editor before opening sidebar')
        before = json.loads((self.root / 'before-sidebar.json').read_text())
        self.content_window = before.pop('window')
        self.launcher_state = before
        self.server_started_before_sidebar = self.socket_path.exists()
        self.keys(';')

    def attach_session(self, startup, launcher):
        if startup:
            self.wait(self.socket_path.exists, 'Neovim starts the server', timeout=12)
            self.connect_server()
            if launcher:
                self.sessions_before_new = self.rpc.request('session.list')['items']
                self.keys('n')
                self.wait(lambda: b'Message' in self.output, 'New opens a chat input immediately')
                self.new_chat_output = bytes(self.output)
            self.wait(lambda: len(self.rpc.request('session.list')['items']) == 1, 'Neovim creates a session')
            self.session_id = self.rpc.request('session.list')['items'][0]['session_id']
        else: self.session_id = 'work'
        self.display_name = self.rpc.request('session.get', {'session_id': self.session_id})['session'].get('name', self.session_id)
        self.wait(lambda: 'Session: ' + self.display_name in self.panel_text(), 'actual session panels')
        self.observer = Rpc(self.socket_path)
        self.observer.request('session.watch', {'session_id': self.session_id})

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        if kind is not None:
            self.abort()
            return False
        try: self.finish()
        except BaseException:
            self.abort()
            raise

    def abort(self):
        if getattr(self, 'process', None) and self.alive():
            with contextlib.suppress(Exception):
                self.command('noautocmd qa!')
                self.process.wait(timeout=5)
            if self.alive():
                self.process.kill()
                self.process.wait(timeout=5)
        if hasattr(self, 'output'):
            with contextlib.suppress(Exception): self.record()
        if getattr(self, 'master', None) is not None:
            with contextlib.suppress(OSError): os.close(self.master)
            self.master = None
        if self.socket_path.exists():
            with contextlib.suppress(Exception):
                connection = Rpc(self.socket_path)
                try: self.shutdown_server(connection)
                finally: connection.close()
        for connection in (self.rpc, self.observer):
            if connection:
                with contextlib.suppress(Exception): connection.close()
        if self.server:
            if self.server.poll() is None:
                self.server.kill()
                self.server.wait(timeout=5)
            self.log.close()

    @staticmethod
    def shutdown_server(connection):
        for session in connection.request('session.list')['items']:
            session_id = session['session_id']
            target = connection.request('session.get', {'session_id': session_id})['snapshot']['active_submission_id']
            if target: connection.request('run.stop', {'session_id': session_id, 'submission_id': target})
        connection.request('server.shutdown')

    def cli(self, *args):
        result = subprocess.run([str(BINARY), '--config', str(self.config), *args], env=self.env, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        return result.stdout

    def chat(self, text):
        self.command('lua for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)):match("^harness://prompt/") then vim.api.nvim_set_current_win(w); break end end; vim.cmd("startinsert!")')
        self.keys(text + '\r')

    def observe(self, expression):
        if not hasattr(self, 'editor_socket'):
            self.editor_socket = self.root / 'editor.sock'
            self.command('call serverstart(' + json.dumps(str(self.editor_socket)) + ')')
        encoded = 'luaeval(' + json.dumps('vim.json.encode(' + expression + ')') + ')'
        return json.loads(subprocess.check_output(['nvim', '--server', str(self.editor_socket), '--remote-expr', encoded], text=True, timeout=5))

    def windows(self):
        return self.observe('(function() local result={} for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do local b=vim.api.nvim_win_get_buf(w); local pos=vim.fn.win_screenpos(w); result[#result+1]={id=w,name=vim.api.nvim_buf_get_name(b),row=pos[1],col=pos[2],width=vim.api.nvim_win_get_width(w),height=vim.api.nvim_win_get_height(w),current=w==vim.api.nvim_get_current_win(),top=vim.api.nvim_win_call(w,function() return vim.fn.line("w0") end),cursor=vim.api.nvim_win_get_cursor(w)[1],lines=vim.api.nvim_buf_get_lines(b,0,-1,false)} end return result end)()')

    def choose(self, label):
        self.wait(lambda: any(window['name'] == 'harness://select' and any(label in line for line in window['lines'])
                              for window in self.windows()), 'visible choice ' + label)
        lines = next(window['lines'] for window in self.windows() if window['name'] == 'harness://select')
        row = next(index for index, line in enumerate(lines, 1) if label in line)
        self.keys(str(row) + 'G\r')

    def mouse(self, button, column, row):
        self.keys(f'\x1b[<{button};{column};{row}M')
        if button < 64: self.keys(f'\x1b[<{button};{column};{row}m')

    def browser_urls(self):
        path = self.root/'browser.jsonl'
        return [json.loads(line)[0] for line in path.read_text().splitlines()] if path.exists() else []

    def create(self, session_id):
        return self.rpc.request('session.create', {'session_id': session_id, 'workspace': str(self.root)})

    def submit(self, session_id, request_id):
        receipt = self.rpc.request('input.submit', {'session_id': session_id, 'request_id': request_id, 'text': 'Continue with the test task.', 'context': []})
        self.request_ids[session_id] = request_id
        return receipt

    def snapshot(self, session_id=None):
        session_id = session_id or self.session_id
        return self.rpc.request('session.get', {'session_id': session_id})['snapshot']

    def stop(self, session_id=None):
        session_id = session_id or self.session_id
        target = self.snapshot(session_id)['active_submission_id']
        if target: return self.rpc.request('run.stop', {'session_id': session_id, 'submission_id': target})

    def outcome(self, session_id=None):
        session_id = session_id or self.session_id
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
        self.master = None
        if self.rpc:
            self.shutdown_server(self.rpc)
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

def assert_launcher_startup(editor):
    assert editor.launcher_state == {'windows': 1, 'loaded': True, 'mapped': True, 'panels': False}
    assert not editor.server_started_before_sidebar, 'Loading the launcher must not start the server'
    assert editor.sessions_before_new == [], 'Opening the tree must not create an agent'
    assert b'New agent name:' not in editor.new_chat_output and b'Provider [1/2/q]:' not in editor.new_chat_output

def launcher_cases():
    for launcher in ('plain', 'configured'):
        editor = RealEditor('launcher-' + launcher, active=False, startup=True, launcher=launcher, rate=400)
        assert_launcher_startup(editor)
        initial = (editor.root / 'config/nvim/init.lua').read_text()
        assert ("require('harness')" in initial) == (launcher == 'configured')
        editor.command('lua local p=' + editor.panel('prompt') + '; local t=' + editor.panel() + '; local w=vim.fn.win_findbuf(p)[1]; local tw=vim.fn.win_findbuf(t)[1]; local source=vim.fn.bufnr(vim.env.HARNESS_WORKSPACE .. "/one"); vim.fn.writefile({vim.json.encode({init=vim.g.launcher_user_init, cwd=vim.fn.getcwd(), windows=#vim.api.nvim_list_wins(), prompt=vim.bo[p].modifiable, transcript=vim.bo[t].modifiable, listed=vim.bo[t].buflisted, width=vim.api.nvim_win_get_width(w), chat_width=vim.api.nvim_win_get_width(tw), height=vim.api.nvim_win_get_height(w), content_window=tw, source_loaded=vim.api.nvim_buf_is_loaded(source), source_hidden=#vim.fn.win_findbuf(source)==0, prompt_wrap=vim.wo[w].wrap, transcript_wrap=vim.wo[tw].wrap, cleared=vim.env.HARNESS_NVIM_RUNTIME==nil and vim.env.HARNESS_NVIM_OPTIONS==nil})}, vim.env.HARNESS_WORKSPACE .. "/launcher.json")')
        editor.wait(lambda: (editor.root / 'launcher.json').exists(), 'launcher loads user configuration and native panels')
        observed = json.loads((editor.root / 'launcher.json').read_text())
        assert observed == {'init': True, 'cwd': str(editor.root), 'windows': 3, 'prompt': True, 'transcript': False, 'listed': True, 'width': 87, 'chat_width': 87, 'height': 5 if launcher == 'configured' else 3, 'content_window': editor.content_window, 'source_loaded': True, 'source_hidden': True, 'prompt_wrap': True, 'transcript_wrap': True, 'cleared': True}, observed
        assert editor.snapshot(editor.session_id)['session']['workspace'] == str(editor.root)
        editor.chat('Launcher task λ 世界')
        editor.wait(lambda: editor.snapshot(editor.session_id)['active_submission_id'], 'launcher input admission')
        editor.wait(lambda: 'assistant progress' in editor.panel_text(), 'launcher streamed output', timeout=10)
        editor.wait(lambda: editor.snapshot(editor.session_id)['state'] == 'idle', 'launcher stored final result', timeout=15)
        assert any(item['kind'] == 'user' and item['text'] == 'Launcher task λ 世界' for item in editor.snapshot(editor.session_id)['entries'])
        assert (editor.root / 'config/nvim/init.lua').read_text() == initial
        editor.source()
        editor.command('lua vim.fn.writefile({vim.json.encode({window=vim.api.nvim_get_current_win(), wrap=vim.wo.wrap, number=vim.wo.number, windows=#vim.api.nvim_tabpage_list_wins(0), text=vim.api.nvim_get_current_line()})}, vim.env.HARNESS_WORKSPACE .. "/restored-file.json")')
        editor.wait(lambda: (editor.root / 'restored-file.json').exists(), 'return to file in the same window')
        assert json.loads((editor.root / 'restored-file.json').read_text()) == {'window': editor.content_window, 'wrap': launcher != 'configured', 'number': True, 'windows': 2, 'text': 'one'}
        editor.command('qa')
        editor.exits()
        assert b'Keep the listed agent runs in the background?' not in editor.output
        editor.finish()

def buffer_switch_case():
    editor = RealEditor('files-and-chat-buffers', active=False, startup=True, launcher='configured', rate=25)
    first = editor.session_id
    editor.source()
    editor.command('set nohidden | call setline(1, "Unsaved source λ 世界")')
    editor.command('Harness attach ' + first)
    editor.wait(lambda: 'Session: New chat' in editor.panel_text(), 'open chat over a modified file with nohidden')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1]); vim.cmd("startinsert!")')
    editor.keys('Original draft\x1b[13;2uSecond draft line')
    editor.command('buffer ' + str(editor.root / 'one'))
    editor.command('lua vim.fn.writefile({vim.json.encode({name=vim.api.nvim_buf_get_name(0), window=vim.api.nvim_get_current_win(), text=vim.api.nvim_buf_get_lines(0,0,-1,false), modified=vim.bo.modified, wrap=vim.wo.wrap, number=vim.wo.number, windows=#vim.api.nvim_tabpage_list_wins(0)})}, vim.env.HARNESS_WORKSPACE .. "/file-switch.json")')
    editor.wait(lambda: (editor.root / 'file-switch.json').exists(), 'native buffer command restores the source file')
    assert json.loads((editor.root / 'file-switch.json').read_text()) == {'name': str(editor.root / 'one'), 'window': editor.content_window, 'text': ['Unsaved source λ 世界'], 'modified': True, 'wrap': False, 'number': True, 'windows': 2}
    assert editor.panel_text('prompt') == 'Original draft\nSecond draft line\n'
    editor.command('set hidden')
    editor.keys('\x1e')
    editor.wait(lambda: 'Session: New chat' in editor.panel_text(), 'Ctrl-^ returns to the chat buffer')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1]); vim.cmd("startinsert!")')
    editor.keys('\r')
    editor.wait(lambda: editor.snapshot(first)['active_submission_id'], 'Enter sends the retained multiline draft')
    entries = [item for item in editor.snapshot(first)['entries'] if item['kind'] == 'user']
    assert len(entries) == 1 and entries[0]['text'] == 'Original draft\nSecond draft line', entries
    editor.command('buffer ' + str(editor.root / 'one'))
    editor.wait(lambda: editor.snapshot(first)['assistant']['text'], 'chat streams while a file is selected')
    editor.pump(.3)
    editor.command('lua vim.fn.writefile({vim.json.encode({name=vim.api.nvim_buf_get_name(0), window=vim.api.nvim_get_current_win(), text=vim.api.nvim_get_current_line(), windows=#vim.api.nvim_tabpage_list_wins(0)})}, vim.env.HARNESS_WORKSPACE .. "/stream-focus.json")')
    editor.wait(lambda: (editor.root / 'stream-focus.json').exists(), 'streaming leaves file focus unchanged')
    assert json.loads((editor.root / 'stream-focus.json').read_text()) == {'name': str(editor.root / 'one'), 'window': editor.content_window, 'text': 'Unsaved source λ 世界', 'windows': 2}
    editor.command('Harness new')
    editor.wait(lambda: len(editor.rpc.request('session.list')['items']) == 2, 'second chat opens over the unsaved file')
    second = next(item['session_id'] for item in editor.rpc.request('session.list')['items'] if item['session_id'] != first)
    editor.chat('\\name Second buffer')
    editor.wait(lambda: editor.snapshot(second)['session']['name'] == 'Second buffer', 'second chat is selected')
    editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ',0,-1,false,{"Second chat draft"})')
    editor.command('buffer harness://chat/' + first)
    editor.wait(lambda: 'Original draft' in editor.panel_text(), 'buffer command restores the first chat history')
    assert editor.panel_text('prompt') == '\n'
    editor.command('bnext')
    editor.wait(lambda: 'Session: Second buffer' in editor.panel_text(), ':bnext selects the next listed chat')
    assert editor.panel_text('prompt') == 'Second chat draft\n'
    editor.command('buffer ' + str(editor.root / 'one'))
    editor.command('bnext')
    editor.wait(lambda: 'Original draft' in editor.panel_text(), ':bnext moves from the file to a chat')
    assert (editor.root / 'one').read_text() == 'one\n'
    editor.finish()

def model_picker_case():
    editor = RealEditor('model-picker-keyboard-and-mouse', active=False, startup=True, launcher='plain', first_run=True)
    editor.observe('true')
    editor.resize(80, 18)
    catalog = editor.rpc.request('configuration.get', {'session_id': editor.session_id})['models']
    editor.chat('\\model')
    editor.wait(lambda: any(w['name']=='harness://select' for w in editor.windows()), 'model list opens')
    picker = next(w for w in editor.windows() if w['name']=='harness://select')
    assert len(picker['lines']) == len(catalog) and len(picker['lines']) > picker['height']
    assert not any('[current]' in line for line in picker['lines']), 'Unconfigured chat cannot mark a paid model as selected'
    editor.keys('\x1b[6~')
    assert next(w for w in editor.windows() if w['name']=='harness://select')['cursor'] > 1
    editor.keys('G')
    picker = next(w for w in editor.windows() if w['name']=='harness://select')
    assert picker['cursor'] == len(catalog) and picker['top'] > 1
    editor.keys('\r')
    editor.wait(lambda: editor.snapshot()['session']['provider']=='faux', 'last catalog choice selects local demo')
    editor.chat('\\model')
    editor.wait(lambda: any(w['name']=='harness://select' for w in editor.windows()), 'reopen model list')
    editor.keys('gg')
    before = next(w for w in editor.windows() if w['name']=='harness://select')
    for _ in range(3): editor.mouse(65, before['col']+3, before['row']+3)
    after = next(w for w in editor.windows() if w['name']=='harness://select')
    assert after['top'] > before['top'], (before, after)
    x, y = after['col']+3, after['row']+after['height']//2
    editor.mouse(0,x,y)
    target_line = next(w for w in editor.windows() if w['name']=='harness://select')['cursor']
    assert editor.snapshot()['session']['provider']=='faux', 'Single click moves the row without applying it'
    editor.pump(.6)
    click=f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m'
    editor.keys(click+click)
    selected = catalog[target_line-1]
    editor.wait(lambda: editor.snapshot()['session']['model']==selected['id'] and editor.snapshot()['session']['provider']==selected['provider'], 'double click applies the visible provider and model')
    editor.chat('\\model demo')
    editor.wait(lambda: editor.snapshot()['session']['provider']=='faux', 'restore local demo without a model request')
    editor.chat('\\model')
    editor.wait(lambda: any(w['name']=='harness://select' for w in editor.windows()), 'reopen model picker before cancellation')
    editor.observe('(function() vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt/' + editor.session_id + '"),0,-1,false,{"Draft survives model cancellation"}); return true end)()')
    editor.keys('\x1b')
    editor.wait(lambda: not any(w['name']=='harness://select' for w in editor.windows()), 'Escape cancels selection')
    assert editor.snapshot()['session']['provider']=='faux'
    assert editor.panel_text('prompt')=='Draft survives model cancellation\n'
    editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ',0,-1,false,{""})')
    editor.chat('\\model')
    editor.wait(lambda: any(w['name']=='harness://select' for w in editor.windows()), 'open picker before outside click')
    transcript = next(w for w in editor.windows() if w['name']=='harness://chat/'+editor.session_id)
    editor.mouse(0, transcript['col']+transcript['width']-1, transcript['row']+1)
    editor.wait(lambda: not any(w['name']=='harness://select' for w in editor.windows()), 'outside click cancels picker')
    assert editor.observe('vim.api.nvim_get_current_win()') == transcript['id'], 'Cancellation must retain clicked window focus'
    assert editor.snapshot()['session']['provider']=='faux' and not editor.snapshot()['entries']
    editor.finish()


def login_case():
    editor = RealEditor('provider-login-native-terminal', active=False, oauth_mock=True)
    editor.observe('true')
    editor.chat('\\model openai/gpt-4o')
    editor.wait(lambda: editor.snapshot()['session']['provider']=='openai', 'select OpenAI without a key')
    instance = editor.rpc.request('system.hello', {'api_version': 1})['instance_id']
    config = editor.config.read_bytes()
    def status():
        return editor.rpc.request('configuration.get', {'session_id': editor.session_id})
    def terminal_text():
        return '\n'.join(line for w in editor.windows() if w['name']=='harness://setup' for line in w['lines'])
    def terminal_closed():
        return not any(w['name']=='harness://setup' for w in editor.windows())
    def connected(provider):
        return next(item for item in status()['providers'] if item['id']==provider)['authenticated']
    def draft():
        return editor.observe('vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt/work"),0,-1,false)')

    editor.chat('\\login')
    editor.choose('OpenAI ·')
    editor.choose('OpenAI API key')
    editor.wait(lambda: 'Enter OpenAI API key' in terminal_text(), 'private OpenAI prompt')
    assert editor.observe('vim.fn.mode(1)') == 't', 'Typed login must immediately accept terminal keys'
    editor.observe('(function() vim.api.nvim_buf_set_lines(vim.fn.bufnr("harness://prompt/work"),0,-1,false,{"Retain this task"}); return true end)()')
    secret = 'native-login-secret-DO-NOT-PRINT'
    editor.keys(secret)
    assert secret not in terminal_text()
    editor.keys('\x03')
    editor.wait(terminal_closed, 'Ctrl-C cancels native login')
    assert not connected('openai') and draft()==['Retain this task']
    assert editor.snapshot()['session']['model']=='gpt-4o' and not editor.snapshot()['entries']

    editor.command('Harness login openai')
    editor.choose('OpenAI API key')
    editor.wait(lambda: 'Enter OpenAI API key' in terminal_text(), 'retry OpenAI key entry')
    assert editor.observe('vim.fn.mode(1)') == 't'
    editor.keys(secret + '\r')
    editor.wait(terminal_closed, 'key entry completes without mode changes')
    editor.wait(lambda: connected('openai'), 'OpenAI credential is ready')
    assert draft()==['Retain this task']
    assert editor.rpc.request('system.hello', {'api_version': 1})['instance_id']==instance, 'Login must not replace the server'
    assert editor.config.read_bytes()==config
    assert not editor.snapshot()['entries']

    def browser_login():
        opened = len(editor.browser_urls())
        editor.command('Harness login openrouter')
        editor.choose('Sign in with OpenRouter')
        editor.wait(lambda: len(editor.browser_urls())==opened+1, 'actual Pi browser login opens automatically once')
        assert editor.observe('vim.fn.mode(1)') == 't'
        authorize = urllib.parse.urlsplit(editor.browser_urls()[-1])
        assert authorize.scheme=='https' and authorize.hostname=='openrouter.ai'
        assert urllib.parse.parse_qs(authorize.query)['code_challenge_method']==['S256']
        redirect = urllib.parse.parse_qs(authorize.query)['callback_url'][0]
        callback = urllib.parse.urlsplit(redirect)
        assert callback.hostname in ('127.0.0.1','localhost') and callback.scheme=='http'
        return redirect
    browser_login()
    editor.keys('\x1b')
    editor.wait(lambda: editor.observe('vim.fn.mode(1)')=='nt', 'Escape leaves terminal input without cancelling login')
    assert not terminal_closed()
    editor.keys('\x03')
    editor.wait(terminal_closed, 'Ctrl-C cancels browser login')
    assert not connected('openrouter') and connected('openai')
    assert draft()==['Retain this task']
    redirect=browser_login()
    with urllib.request.urlopen(redirect + '?code=test-code', timeout=5) as response:
        assert response.status==200
    editor.wait(terminal_closed, 'browser callback completes while manual prompt waits, without Enter')
    assert connected('openrouter') and connected('openai'), 'A second provider preserves the first credential'
    assert draft()==['Retain this task'] and not editor.snapshot()['entries']
    assert editor.snapshot()['session']['provider']=='openai', 'Login does not change the selected model'
    assert editor.config.read_bytes()==config
    assert secret.encode() not in editor.output and b'oauth-test-secret-DO-NOT-PRINT' not in editor.output
    assert secret not in json.dumps(status()) and 'oauth-test-secret-DO-NOT-PRINT' not in json.dumps(status())
    for path in (editor.root/'state/logs').glob('*'):
        data=path.read_bytes()
        assert secret.encode() not in data and b'oauth-test-secret-DO-NOT-PRINT' not in data
    requests=[json.loads(line) for line in (editor.root/'oauth-requests.jsonl').read_text().splitlines()]
    assert [(item['host'],item['path']) for item in requests]==[('openrouter.ai','/api/v1/auth/keys')]
    editor.rpc.request('server.shutdown')
    editor.rpc.close()
    editor.wait(lambda: not editor.socket_path.exists(), 'idle server releases socket after saved login')
    editor.cli('start')
    editor.rpc=Rpc(editor.socket_path)
    editor.wait(lambda: editor.rpc.request('system.hello', {'api_version': 1})['storage_ready'], 'reopen stored provider credentials')
    assert connected('openai') and connected('openrouter')
    assert not editor.snapshot()['entries']
    editor.finish()


def provider_generation_case():
    with RealEditor('openai-generation-login-and-retry', active=False, generation=[
        {'kind': 'failed', 'message': 'The API organization has no credit. Check billing.'},
        {'kind': 'tool'}, {'kind': 'answer', 'delay_ms': 80},
    ]) as editor:
        editor.observe('true')
        editor.keys('i\\model openai/gpt-6-sol\r')
        editor.wait(lambda: editor.snapshot()['session']['model']=='gpt-6-sol', 'select the reported OpenAI model')
        assert editor.observe('vim.fn.mode(1)')=='i', 'Model selection must leave the prompt ready for typing'
        instance = editor.rpc.request('system.hello', {'api_version': 1})['instance_id']
        config = editor.config.read_bytes()
        def draft():
            return editor.observe('vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt/work"),0,-1,false)')
        def transcript():
            return '\n'.join(line for window in editor.windows() if window['name']=='harness://chat/work' for line in window['lines'])

        editor.keys('Run the provider test.\r')
        assert editor.observe('vim.fn.mode(1)') == 'i', 'Enter must leave the prompt ready for the next draft'
        editor.wait(lambda: draft()==[''], 'accepted submission clears the sent draft')
        editor.keys('Unsent draft stays here.')
        editor.wait(lambda: editor.snapshot()['error'] is not None, 'actual OpenAI SDK reports the API credit failure')
        editor.wait(lambda: '[error] Run failed' in transcript(), 'provider failure appears in the visible chat')
        failed = editor.snapshot()
        failure = failed['entries'][-1]
        assert failed['error']['kind']=='provider_error'
        assert 'quota or credit' in failure['text'] and 'usage and billing' in failure['text'] and '\\login' in failure['text']
        assert failure['kind']=='error'
        assert editor.rpc.request('entry.read', {'session_id':'work','entry_id':failure['entry_id']})['text']==failure['text']
        assert transcript().count('[error] Run failed')==1 and '[assistant] Agent' not in transcript()
        assert transcript().endswith(failure['text']), 'The current failure must appear after usage and notices'
        assert draft()==['Unsent draft stays here.'], ('Typing after Enter must preserve every character', draft())

        editor.command('Harness login openai')
        editor.choose('Sign in with ChatGPT')
        editor.wait(lambda: len(editor.browser_urls())==1, 'actual Pi ChatGPT account opens automatically')
        assert editor.observe('vim.fn.mode(1)')=='t', 'Account login must immediately accept terminal input'
        authorize = urllib.parse.urlsplit(editor.browser_urls()[0])
        assert authorize.scheme=='https' and authorize.hostname=='auth.openai.com'
        query = urllib.parse.parse_qs(authorize.query)
        assert query['code_challenge_method']==['S256']
        callback = urllib.parse.urlsplit(query['redirect_uri'][0])
        assert callback.scheme=='http' and callback.hostname in ('localhost','127.0.0.1')
        parameters = urllib.parse.urlencode({'code':'test-code','state':query['state'][0],'client_id':'test-issued-client'})
        with urllib.request.urlopen(query['redirect_uri'][0] + '?' + parameters, timeout=5) as response:
            assert response.status==200
        editor.wait(lambda: not any(window['name']=='harness://setup' for window in editor.windows()), 'account callback completes without Enter')
        editor.wait(lambda: editor.observe('vim.fn.mode(1)')=='i', 'login returns to the same draft')
        assert draft()==['Unsent draft stays here.'], draft()
        assert editor.snapshot()['session']['model']=='gpt-6-sol'
        assert editor.rpc.request('system.hello', {'api_version':1})['instance_id']==instance
        assert editor.config.read_bytes()==config
        editor.keys('\x13')
        assert editor.observe('vim.fn.mode(1)')=='i', 'Ctrl-S must also leave the prompt ready for the next draft'
        editor.wait(lambda: draft()==[''], 'accepted Ctrl-S submission clears the sent draft')
        editor.keys('Next draft stays intact.')
        editor.wait(lambda: editor.snapshot()['active_submission_id'] is not None
                    and 'λ 世界' in editor.snapshot()['assistant']['text'], 'actual OpenAI SDK streams Unicode into the same chat')
        editor.wait(lambda: editor.snapshot()['state']=='idle' and editor.snapshot()['assistant']['text']=='OpenAI streamed λ 世界 and completed the task.',
                    'actual OpenAI SDK receives the tool result and completes the reply')
        editor.wait(lambda: 'OpenAI streamed λ 世界 and completed the task.' in transcript(), 'successful reply is displayed')
        current = editor.snapshot()
        assert current['error'] is None
        assert [entry['text'] for entry in current['entries'] if entry['kind']=='user']==['Run the provider test.','Unsent draft stays here.']
        assert sum(entry['kind']=='error' and entry['entry_id']==failure['entry_id'] for entry in current['entries'])==1
        assert transcript().count('[error] Run failed')==1
        assert transcript().count('[assistant] Agent')==2, 'The tool request and final reply each have a nonempty assistant entry'
        assert transcript().count('OpenAI streamed λ 世界 and completed the task.')==1
        assert draft()==['Next draft stays intact.'], draft()
        assert (editor.root/'provider-result.txt').read_text()=='provider tool ran\n'
        requests = [json.loads(line) for line in (editor.root/'generation-requests.jsonl').read_text().splitlines()]
        assert [request['credential_kind'] for request in requests]==['api_key','oauth','oauth'], 'Saved account credentials must replace the inherited API key on actual requests'
        assert [request['response'] for request in requests]==['failed','tool','answer']
        assert all(request['model']=='gpt-6-sol' for request in requests)
        public = editor.output + json.dumps(current).encode()
        for path in (editor.root/'state/logs').glob('*'): public += path.read_bytes()
        for secret in (b'sk-generation-test-NOT-FOR-OUTPUT',b'generation-account-token-NOT-FOR-OUTPUT',b'oauth-test-secret-DO-NOT-PRINT'):
            assert secret not in public, 'Provider errors, logs, and terminal output must not expose credentials'


def chat_actions_case():
    editor = RealEditor('chat-actions-retain-draft',active=False)
    editor.observe('true')
    expected = 'Unsent task'
    editor.keys('i'+expected)
    def cancelled(suffix):
        nonlocal expected
        editor.keys('\x1b')
        editor.wait(lambda:not any(window['name']=='harness://select' for window in editor.windows()),'choice cancelled')
        assert editor.observe('vim.fn.mode(1)')=='i', 'Cancellation must return directly to prompt input'
        editor.keys(suffix)
        expected += suffix
        assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==[expected]
        assert not editor.snapshot()['entries']
    editor.keys('\x1bOP')
    editor.wait(lambda:any(window['name']=='harness://select' for window in editor.windows()),'F1 opens chat actions')
    cancelled(' after actions')
    editor.keys('\x1bOP')
    editor.choose('Choose a model')
    editor.wait(lambda:any(window['name']=='harness://select' and len(window['lines'])>20 for window in editor.windows()),'full model choice')
    cancelled(' after model')
    editor.keys('\x1bOP')
    editor.choose('Connect an account')
    editor.wait(lambda:any(window['name']=='harness://select' and len(window['lines'])>20 for window in editor.windows()),'provider choice')
    cancelled(' after provider')
    editor.keys('\x1bOP')
    editor.choose('Connect an account')
    editor.choose('OpenAI ·')
    editor.wait(lambda:any(window['name']=='harness://select' and len(window['lines'])==2 for window in editor.windows()),'login method choice')
    cancelled(' after method')
    editor.keys('\x1bOP')
    editor.choose('Attach source buffer')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','attachment returns to the unchanged draft')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==[expected]
    assert 'Context snapshot: one (buffer)' in '\n'.join(line for window in editor.windows() if window['name']=='harness://chat/work' for line in window['lines'])
    editor.keys('\r')
    editor.wait(lambda:editor.snapshot()['active_submission_id'] is not None,'send the preserved draft once')
    assert len([entry for entry in editor.snapshot()['entries'] if entry['kind']=='user'])==1
    editor.keys('Next draft')
    editor.keys('\x1bOP')
    editor.choose('Stop current task')
    editor.wait(lambda:editor.snapshot()['active_submission_id'] is None,'stop through chat actions')
    assert editor.observe('vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt/work"),0,-1,false)')==['Next draft']
    assert editor.snapshot()['session']['provider']=='faux'
    editor.finish()


def login_cancel_case():
    editor = RealEditor('login-cancel-modes-and-resize',active=False,oauth_mock=True)
    editor.observe('true')
    editor.keys('iUnsent')
    expected = 'Unsent'
    instance = editor.rpc.request('system.hello',{'api_version':1})['instance_id']
    server_pid = struct.unpack('3i',editor.rpc.socket.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]
    children = Path(f'/proc/{server_pid}/task/{server_pid}/children')
    workers = children.read_text()
    assert workers.strip(), 'The real server has a Pi worker'
    def setup_window():
        return next((window for window in editor.windows() if window['name']=='harness://setup'),None)
    for mode in ('terminal','normal','visual','forced-close','retry'):
        opened = len(editor.browser_urls())
        editor.command('Harness login openai')
        editor.choose('Sign in with ChatGPT')
        editor.wait(lambda:setup_window() and len(editor.browser_urls())==opened+1,'waiting browser login with a complete URL')
        if mode in ('normal','visual','forced-close'): editor.keys('\x1c\x0e')
        if mode=='visual': editor.keys('v')
        if mode=='normal':
            editor.resize(50,16)
            editor.wait(lambda:setup_window()['col']+setup_window()['width']<=50
                        and setup_window()['row']+setup_window()['height']<16,'login remains inside the resized editor')
            editor.resize(120,40)
        if mode in ('terminal','retry'):
            editor.keys('\x1b')
            editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='nt','Escape leaves private input without cancelling login')
            assert setup_window() is not None
        editor.keys(':bd!\r' if mode=='forced-close' else '\x03')
        editor.wait(lambda:setup_window() is None,'cancel login from '+mode+' mode')
        assert editor.observe('vim.fn.mode(1)')=='i', ('Login cancellation must restore prompt input', mode, editor.observe('vim.fn.mode(1)'), editor.windows())
        editor.keys(' after '+mode)
        expected += ' after '+mode
        assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==[expected]
        assert editor.rpc.request('system.hello',{'api_version':1})['instance_id']==instance
        assert children.read_text()==workers, 'Closing a login terminal must not crash or replace the Pi worker'
        assert not editor.snapshot()['entries']
        provider = next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')
        assert not provider['authenticated']
    editor.finish()


def chat_write_case():
    editor = RealEditor('chat-native-write-commands', active=False)
    editor.observe('true')
    def chat_window():
        editor.observe('(function() for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w))=="harness://chat/work" then vim.api.nvim_set_current_win(w); return true end end return false end)()')
    editor.source()
    editor.keys('ggccSaved by wall\x1b')
    editor.command('Harness attach work')
    editor.wait(lambda: any(w['name']=='harness://chat/work' for w in editor.windows()), 'chat restores before write commands')
    chat_window()
    editor.command('wall')
    assert (editor.root/'one').read_text()=='Saved by wall\n', ':wall must save the modified source beside a clean chat'
    assert editor.observe('(function() local b=vim.fn.bufnr("harness://chat/work"); return vim.bo[b].readonly and not vim.bo[b].modifiable and not vim.bo[b].modified end)()')
    exported=editor.root/'exported-chat'
    editor.command('write! ' + str(exported))
    editor.wait(lambda: b'Chat history is stored by Harness' in editor.output, 'forced chat write reports its storage boundary')
    assert not exported.exists(), ':write! must not export a chat to a file'
    editor.keys('\r')
    chat_window()
    editor.command('wq')
    editor.stays()
    editor.keys('\r')
    assert not (editor.root/'harness:').exists()
    assert editor.observe('vim.api.nvim_buf_get_name(0)')=='harness://chat/work'
    editor.source()
    editor.keys('ggccSaved by wqa\x1b')
    editor.command('Harness attach work')
    editor.wait(lambda: any(w['name']=='harness://chat/work' for w in editor.windows()), 'chat restores before save-and-exit')
    chat_window()
    editor.command('wqa')
    editor.exits()
    assert (editor.root/'one').read_text()=='Saved by wqa\n', ':wqa must preserve native writes with a clean chat'
    editor.finish()


def prompt_window_case():
    editor = RealEditor('prompt-local-window-layout', active=True, rate=25)
    editor.observe('true')
    editor.command('set mouse=a')
    target=editor.snapshot()['active_submission_id']
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1])')
    editor.command('new')
    editor.wait(lambda: any(w['name']=='' and w['current'] for w in editor.windows()), 'horizontal new file opens outside the input')
    assert next(w for w in editor.windows() if w['name']=='' and w['current'])['height'] > 8
    assert not any(w['name'].startswith('harness://prompt/') for w in editor.windows())
    editor.command('q')
    editor.wait(lambda: any(w['name']=='harness://prompt/work' for w in editor.windows()), 'returning to chat restores its input')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1])')
    editor.command('vnew')
    editor.wait(lambda: any(w['name']=='' and w['current'] for w in editor.windows()), 'new file from prompt gets a file window')
    file_window=next(w for w in editor.windows() if w['name']=='' and w['current'])
    assert file_window['height'] > 10, file_window
    assert not any(w['name'].startswith('harness://prompt/') for w in editor.windows()), 'File focus hides chat input'
    editor.command('edit two')
    editor.command('Harness new')
    editor.wait(lambda: len(editor.rpc.request('session.list')['items'])==2, 'new chat uses the file area')
    second=next(item['session_id'] for item in editor.rpc.request('session.list')['items'] if item['session_id']!='work')
    def local_pair():
        windows=editor.windows()
        chats=[w for w in windows if w['name']=='harness://chat/'+second]
        prompts=[w for w in windows if w['name']=='harness://prompt/'+second]
        return len(prompts)==1 and prompts[0]['height']==5 and any(chat['col']==prompts[0]['col'] and chat['width']==prompts[0]['width'] and chat['row']+chat['height']+1 == prompts[0]['row'] for chat in chats)
    editor.wait(local_pair, 'input remains below its own chat column')
    windows=editor.windows(); second_main=next(w for w in windows if w['name']=='harness://chat/'+second)
    assert second_main['id']==file_window['id'] and second_main['height']>10
    prior_second=second
    editor.command('Harness new')
    editor.wait(lambda: len(editor.rpc.request('session.list')['items'])==3, 'new chat from input creates its own main-area conversation')
    second=next(item['session_id'] for item in editor.rpc.request('session.list')['items'] if item['session_id'] not in ('work',prior_second))
    editor.wait(local_pair, 'new chat replaces history and input together')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr("harness://chat/' + second + '"))[1])')
    editor.command('wincmd H')
    editor.wait(local_pair, 'moving a chat column repairs its local input without a resize command')
    assert next(w for w in editor.windows() if w['name']=='harness://chat/'+second)['id']==file_window['id']
    windows=editor.windows()
    first=next(w for w in windows if w['name']=='harness://chat/work')
    editor.mouse(0, first['col']+2, first['row']+1)
    editor.wait(lambda: any(w['name']=='harness://prompt/work' for w in editor.windows()), 'mouse selects the first chat input')
    assert not any(w['name']=='harness://prompt/'+second for w in editor.windows()), 'Other chat input stays hidden'
    editor.command('buffer one')
    editor.wait(lambda: not any(w['name'].startswith('harness://prompt/') for w in editor.windows()), 'file selection removes all chat inputs')
    windows=editor.windows(); other=next(w for w in windows if w['name']=='harness://chat/'+second)
    editor.mouse(0,other['col']+2,other['row']+1)
    editor.wait(local_pair, 'mouse return restores input only under selected chat')
    source_file=next(w for w in editor.windows() if w['name']==str(editor.root/'one'))
    editor.mouse(0,source_file['col']+2,source_file['row']+1)
    editor.wait(lambda: not any(w['name'].startswith('harness://prompt/') for w in editor.windows()), 'mouse focus on the file hides input')
    editor.mouse(0,other['col']+2,other['row']+1)
    editor.wait(local_pair, 'mouse focus on chat restores its local input')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr("harness://prompt/' + second + '"))[1])')
    editor.command('split')
    editor.wait(lambda: len([w for w in editor.windows() if w['name']=='harness://chat/'+second])==2 and local_pair(), 'copying a chat window keeps one local input')
    editor.command('q')
    editor.wait(lambda: len([w for w in editor.windows() if w['name']=='harness://chat/'+second])==1 and local_pair(), 'closing the copied chat returns input to the remaining chat')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr("harness://prompt/' + second + '"))[1])')
    editor.command('tab split')
    editor.wait(local_pair, 'copying a tab from input opens chat with a local input')
    assert len(editor.windows())==2, editor.windows()
    editor.command('tabclose')
    editor.wait(local_pair, 'returning to the split tab restores its local chat input')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr("harness://prompt/' + second + '"))[1])')
    editor.command('q')
    editor.pump(.3)
    assert not any(w['name'].startswith('harness://prompt/') for w in editor.windows()), ':q on input must keep it closed'
    editor.command('Harness attach '+second)
    editor.wait(local_pair, 'explicit chat open restores its input')
    editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr("harness://chat/' + second + '"))[1])')
    editor.command('q')
    editor.wait(lambda: not any(w['name'].startswith('harness://prompt/') for w in editor.windows()), 'closing chat removes its orphan input')
    assert editor.snapshot('work')['active_submission_id']==target, 'Window changes cannot stop accepted work'
    editor.finish()


def explorer_cases(plugin):
    plugin = Path(plugin).resolve()
    assert (plugin / 'plugin/NERD_tree.vim').is_file(), plugin
    for width in (40, 70):
        for key, label in (('\r', 'enter'), ('s', 'vertical'), ('i', 'horizontal')):
            editor = RealEditor(f'nerdtree-{width}-{label}', rate=1)
            try:
                target = editor.snapshot()['active_submission_id']
                editor.command('set mouse=a equalalways eadirection=both')
                editor.command('execute "set runtimepath^=" . fnameescape(' + json.dumps(str(plugin)) + ')')
                editor.command('runtime plugin/NERD_tree.vim')
                editor.command(f'let g:NERDTreeWinSize={width} | let g:NERDTreeQuitOnOpen=1 | let g:NERDTreeMinimalUI=1')
                editor.command('Harness')
                editor.keys('iRetained explorer draft\x1b')
                editor.command('Harness sidebar')
                editor.keys('\x17l')
                content = next(win for win in editor.windows() if win['current'])
                assert content['name'] == 'harness://chat/work'
                editor.command('NERDTree')
                editor.keys('/two\r')
                editor.keys(key)
                editor.wait(lambda: any(win['name'] == str(editor.root / 'two') for win in editor.windows())
                            and not any('NERD_tree_' in win['name'] for win in editor.windows()), 'native explorer opens the selected file and closes')
                editor.wait(lambda: all(win['width'] <= 32 for win in editor.windows() if win['name'] == 'harness://agents'),
                            'agent tree retains its bounded width')
                windows = editor.windows()
                file = next(win for win in windows if win['name'] == str(editor.root / 'two'))
                chats = [win for win in windows if win['name'] == 'harness://chat/work']
                assert file['current']
                assert not any(win['name'].startswith('harness://prompt/') for win in windows), 'A file must not retain a chat message box'
                if label == 'enter':
                    assert not chats, 'Enter replaces the chat in its content window'
                    assert file['id'] == content['id']
                    editor.command('buffer harness://chat/work')
                else:
                    assert len(chats) == 1
                    chat = chats[0]
                    if label == 'vertical':
                        assert file['col'] != chat['col'] and file['row'] == chat['row']
                        assert min(file['width'], chat['width']) >= 40, windows
                        assert abs(file['width'] - chat['width']) <= 1, windows
                    else:
                        assert file['col'] == chat['col'] and file['row'] != chat['row']
                        assert file['width'] == chat['width'], windows
                    editor.mouse(0, chat['col'] + 2, chat['row'] + 1)
                editor.wait(lambda: any(win['name'] == 'harness://prompt/work' for win in editor.windows()), 'selecting the chat restores its own input')
                windows = editor.windows()
                chat = next(win for win in windows if win['name'] == 'harness://chat/work')
                prompt = next(win for win in windows if win['name'] == 'harness://prompt/work')
                assert prompt['lines'] == ['Retained explorer draft']
                assert prompt['col'] == chat['col'] and prompt['width'] == chat['width']
                assert prompt['row'] == chat['row'] + chat['height'] + 1
                assert editor.snapshot()['active_submission_id'] == target, 'Explorer actions must not stop work'
            finally:
                editor.finish()

def first_run_setup_case():
    with RealEditor('first-run-setup', active=False, startup=True, launcher='plain', first_run=True, rate=400) as editor:
        assert_launcher_startup(editor)
        assert not editor.config.exists(), 'New chat does not require or create a default config'
        assert editor.snapshot()['session']['provider'] is None
        assert 'setup' not in editor.panel_text('agents').lower()
        editor.chat('Task before model choice')
        editor.wait(lambda: '\\model' in editor.panel_text(), 'missing-model remedy stays inside chat')
        assert not editor.snapshot()['entries'], 'A missing model cannot admit a task'
        assert editor.panel_text('prompt') == 'Task before model choice\n'
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ', 0, -1, false, {""})')
        editor.chat('\\model demo')
        editor.wait(lambda: editor.snapshot()['session']['provider'] == 'faux', 'chat command sets model without setup')
        editor.chat('\\name First chat')
        editor.wait(lambda: editor.snapshot()['session']['name'] == 'First chat', 'chat rename')
        editor.chat('\\instructions Give short answers.')
        editor.wait(lambda: editor.snapshot()['session']['instructions'] == 'Give short answers.', 'chat instructions')
        editor.chat('\\unknown')
        editor.wait(lambda: 'Unknown command' in editor.panel_text(), 'unknown commands stay local')
        assert not editor.snapshot()['entries']
        editor.chat('First chat task λ 世界\x1b[13;2uSecond line')
        editor.wait(lambda: any(item['kind'] == 'user' for item in editor.snapshot()['entries']), 'Enter sends the chat message')
        editor.wait(lambda: editor.snapshot()['state'] == 'idle', 'first chat completes', timeout=15)
        assert any(item['kind'] == 'user' and item['text'] == 'First chat task λ 世界\nSecond line' for item in editor.snapshot()['entries'])
        assert not editor.config.exists(), 'Chat settings are stored in Pi, not a second settings file'
        editor.command('qa')
        editor.exits()

def narrow_screen_controls_case():
    with RealEditor('narrow-screen-controls', active=False, startup=True, launcher='configured', rate=400) as editor:
        editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1]); vim.cmd("startinsert")')
        editor.keys('Draft λ 世界 across sizes\x1b')
        for columns, lines in ((80, 24), (60, 20), (120, 40)):
            editor.resize(columns, lines)
            path = editor.root / 'layout.json'
            path.unlink(missing_ok=True)
            editor.command('lua local p=vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1]; local t=vim.fn.win_findbuf(' + editor.panel() + ')[1]; vim.fn.writefile({vim.json.encode({columns=vim.o.columns, lines=vim.o.lines, prompt_width=vim.api.nvim_win_get_width(p), transcript_width=vim.api.nvim_win_get_width(t), prompt_row=vim.fn.win_screenpos(p)[1], transcript_row=vim.fn.win_screenpos(t)[1], prompt_help=vim.wo[p].winbar, windows=#vim.api.nvim_tabpage_list_wins(0)})}, vim.env.HARNESS_WORKSPACE .. "/layout.json")')
            editor.wait(path.exists, 'read responsive layout')
            layout = json.loads(path.read_text())
            assert layout['columns'] == columns and layout['lines'] == lines, layout
            assert 'send' in layout['prompt_help'], layout
            assert layout['prompt_width'] >= 35 and layout['transcript_width'] >= 35, layout
            assert layout['transcript_row'] < layout['prompt_row'] and layout['windows'] == 2, layout
            assert layout['prompt_width'] == columns and layout['transcript_width'] == columns, layout
            assert editor.panel_text('prompt') == 'Draft λ 世界 across sizes\n'

def sidebar_controls_case():
    with RealEditor('sidebar-controls', active=False, startup=True, launcher='configured') as editor:
        work = editor.session_id
        editor.rpc.request('session.configure', {'session_id': work, 'name': 'work'})
        editor.create('second')
        editor.rpc.request('session.create', {'session_id': 'child', 'workspace': str(editor.root), 'parent_session_id': work})
        (editor.root / 'other').mkdir()
        editor.rpc.request('session.create', {'session_id': 'remote', 'workspace': str(editor.root / 'other')})
        editor.submit(work, 'work-task')
        editor.submit('second', 'second-task')
        editor.tree_row('+ New chat')
        editor.keys('r')
        editor.wait(lambda: 'second [running]' in editor.panel_text('agents') and 'child [idle]' in editor.panel_text('agents'), 'current-directory agents and child are listed')
        assert 'remote [' not in editor.panel_text('agents'), 'Another directory must not appear'
        tree = editor.panel_text('agents').splitlines()
        assert next(i for i,line in enumerate(tree) if 'work [running]' in line) < next(i for i,line in enumerate(tree) if 'child [idle]' in line)
        editor.tree_row('work [')
        editor.keys('h')
        assert 'child [' not in editor.panel_text('agents'), 'Parent folds its actual children'
        editor.keys('l')
        editor.wait(lambda: 'child [idle]' in editor.panel_text('agents'), 'Parent expands')
        editor.tree_row('second [')
        editor.keys('\r')
        editor.wait(lambda: 'Session: second' in editor.panel_text(), 'Enter selects second agent')
        editor.keys('iDraft survives tree hiding\x1b')
        editor.tree_row('work [')
        editor.keys('s')
        editor.wait(lambda: editor.outcome(work)['status'] == 'unanswered', 's stops the highlighted agent')
        assert editor.outcome(work)['reason'] == 'cancelled'
        assert editor.outcome('second')['status'] == 'accepted', 'Stopping a highlighted row must preserve another selected run'
        editor.keys('q')
        assert editor.panel_text('prompt') == 'Draft survives tree hiding\n'
        editor.keys(';')
        editor.wait(lambda: 'second [running]' in editor.panel_text('agents'), 'semicolon reopens the sidebar')
        editor.tree_row('+ New chat')
        editor.keys('\r')
        editor.wait(lambda: len(editor.rpc.request('session.list')['items']) == 5, 'Enter on New creates a chat without a name dialog')
        editor.stays()
        editor.prompt('qa')
        editor.keys('no\r')
        editor.exits()
        assert editor.outcome('second')['reason'] == 'cancelled'

def separate_tab_chats_case():
    with RealEditor('separate-tab-chats', active=False, startup=True, launcher='plain') as editor:
        first = editor.session_id
        editor.chat('\\name First tab')
        editor.wait(lambda: editor.snapshot(first)['session']['name'] == 'First tab', 'first tab name')
        editor.command('lua vim.g.first_source = vim.fn.win_findbuf(' + editor.panel() + ')[1]; vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ',0,-1,false,{"Draft in first tab"})')
        (editor.root / 'other').mkdir()
        editor.command('tabnew | execute "tcd " .. fnameescape($HARNESS_WORKSPACE .. "/other")')
        editor.keys(';')
        editor.wait(lambda: '+ New chat' in editor.panel_text('agents'), 'second directory tree')
        assert 'First tab [' not in editor.panel_text('agents')
        editor.keys('n')
        editor.wait(lambda: len(editor.rpc.request('session.list')['items']) == 2, 'new chat in second tab')
        second = next(item['session_id'] for item in editor.rpc.request('session.list')['items'] if item['session_id'] != first)
        assert editor.snapshot(second)['session']['workspace'] == str(editor.root / 'other')
        editor.wait(lambda: 'Session: New chat' in editor.panel_text(), 'second tab selected')
        editor.chat('\\name Second tab')
        editor.wait(lambda: editor.snapshot(second)['session']['name'] == 'Second tab', 'second tab name')
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ',0,-1,false,{"Draft in second tab"})')
        editor.command('tabprevious')
        editor.wait(lambda: 'Session: First tab' in editor.panel_text(), 'first tab selection restored')
        assert editor.panel_text('prompt') == 'Draft in first tab\n'
        editor.wait(lambda: 'First tab [' in editor.panel_text('agents'), 'first directory tree restored')
        assert 'Second tab [' not in editor.panel_text('agents')
        editor.command('lua vim.fn.writefile({tostring(vim.api.nvim_win_is_valid(vim.g.first_source) and vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(vim.g.first_source)):match("^harness://chat/") ~= nil and vim.api.nvim_buf_is_loaded(vim.fn.bufnr(vim.env.HARNESS_WORKSPACE .. "/one")))}, vim.env.HARNESS_WORKSPACE .. "/source-preserved")')
        editor.wait(lambda: (editor.root / 'source-preserved').exists(), 'source window preserved')
        assert (editor.root / 'source-preserved').read_text() == 'true\n'
        editor.command('tabnext')
        editor.wait(lambda: 'Session: Second tab' in editor.panel_text(), 'second tab selection restored')
        assert editor.panel_text('prompt') == 'Draft in second tab\n'

def multiple_sessions_case():
    with RealEditor('multiple-sessions') as editor:
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

def completion_during_prompt_case():
    short = dict(MESSAGE, content=[{'type': 'text', 'text': 'Natural completion. ' * 40}])
    with RealEditor('completion-during-prompt', message=short, rate=200) as editor:
        editor.prompt('qa')
        editor.wait(lambda: editor.outcome()['status'] == 'done', 'natural completion during native prompt', timeout=10)
        editor.keys('no\r')
        editor.exits()
        assert editor.outcome()['status'] == 'done'

def new_run_during_prompt_case():
    with RealEditor('new-run-during-prompt') as editor:
        editor.prompt('qa')
        editor.stop()
        new = editor.submit('work', 'second')
        start = len(editor.output)
        editor.keys('yes\r')
        editor.wait(lambda: new['submission_id'].encode() in editor.output[start:], 'new target needs a new prompt')
        editor.keys('\x1b')
        editor.stays()
        assert editor.snapshot()['active_submission_id'] == new['submission_id']

def connection_failure_during_stop_case():
    with RealEditor('connection-failure-during-stop', foreground=True) as editor:
        editor.prompt('qa')
        os.kill(editor.server.pid, signal.SIGSTOP)
        editor.keys('no\r')
        os.kill(editor.server.pid, signal.SIGKILL)
        editor.server.wait(timeout=5)
        editor.stays()
        editor.reconnect_server()

def connection_failure_during_prompt_case():
    with RealEditor('connection-failure-during-prompt', foreground=True) as editor:
        target = editor.snapshot()['active_submission_id']
        editor.prompt('qa')
        os.kill(editor.server.pid, signal.SIGKILL)
        editor.server.wait(timeout=5)
        editor.keys('yes\r')
        editor.stays()
        editor.reconnect_server()
        assert editor.snapshot()['active_submission_id'] == target

def escape_during_stop_wait_case():
    with RealEditor('escape-during-stop-wait', foreground=True) as editor:
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

def forced_exit_and_recovery_case():
    with RealEditor('forced-exit-and-recovery') as editor:
        target = editor.snapshot()['active_submission_id']
        editor.command('noautocmd qa!')
        editor.exits()
        assert editor.snapshot()['active_submission_id'] == target
        editor.record()
        os.close(editor.master)
        editor.launch(editor.env)
        editor.wait(lambda: 'Session: work' in editor.panel_text(), 'reconnect after forced editor exit')
        assert editor.snapshot()['active_submission_id'] == target

def neovim_starts_missing_server_case():
    with RealEditor('neovim-starts-missing-server', active=False, startup=True) as editor:
        editor.stays()
        assert editor.snapshot(editor.session_id)['state'] == 'idle'
        editor.command('qa')
        editor.exits()

def hidden_unsent_draft_case():
    with RealEditor('hidden-unsent-draft', active=False) as editor:
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ', 0, -1, false, {"Retained unsent text"})')
        editor.source(True)
        editor.command('Harness')
        editor.wait(lambda: 'Connection: connected' in editor.panel_text(), 'reopen hidden panels')
        assert editor.panel_text('prompt') == 'Retained unsent text\n'
        assert editor.snapshot()['active_submission_id'] is None

def explicit_editor_context_and_streaming_case():
    with RealEditor('explicit-editor-context-and-streaming', active=False) as editor:
        editor.source()
        editor.command('lua vim.api.nvim_buf_set_lines(0, 0, -1, false, {"unsaved λ 世界", "selection line", "last line"}); vim.g.context_tick = vim.api.nvim_buf_get_changedtick(0)')
        editor.command('Harness context buffer')
        editor.source()
        editor.command('2,2Harness context selection')
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ', 0, -1, false, {"Context request"})')
        editor.command('Harness send')
        editor.wait(lambda: editor.snapshot()['active_submission_id'], 'actual input admission')
        entries = editor.snapshot()['entries']
        assert any('unsaved λ 世界' in item['text'] and 'Explicit selection snapshot: one lines 2-2' in item['text'] for item in entries), entries
        editor.wait(lambda: editor.snapshot()['assistant']['text'], 'actual streamed assistant text')
        assert editor.panel_text().strip() == '', 'A hidden transcript releases generated text during streaming'
        editor.command('Harness')
        editor.wait(lambda: 'assistant progress' in editor.panel_text(), 'reopening restores the current assistant progress')
        panel = editor.panel_text()
        assert 'assistant progress' in panel and 'Context request' in panel
        assert (editor.root / 'one').read_text() == 'one\n'
        editor.source()
        editor.command('lua vim.fn.writefile({vim.json.encode({modified=vim.bo.modified, unchanged=vim.g.context_tick == vim.api.nvim_buf_get_changedtick(0), windows=#vim.api.nvim_list_wins()})}, vim.env.HARNESS_WORKSPACE .. "/buffer.json")')
        editor.wait(lambda: (editor.root / 'buffer.json').exists(), 'editor responds during model output')
        observed = json.loads((editor.root / 'buffer.json').read_text())
        assert observed == {'modified': True, 'unchanged': True, 'windows': 1}, observed

def actual_tool_activity_case():
    tool = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux'; console.log(JSON.stringify(fauxAssistantMessage(fauxToolCall('bash',{command:'echo tool-visible; sleep 1; echo tool-complete'}),{stopReason:'toolUse'})));"], cwd=REPO, text=True))
    with RealEditor('actual-tool-activity', responses=[tool, MESSAGE], rate=1000) as editor:
        editor.wait(lambda: 'bash' in editor.panel_text(), 'actual bash tool name')
        editor.stays()
        editor.wait(lambda: 'tool-complete' in editor.panel_text(), 'actual bash result', timeout=10)

def tool_created_child_tree_case():
    child_command = '"$HARNESS_EXECUTABLE" --socket "$HARNESS_SOCKET" session create --id tool-child --workspace "$PWD" --name "Tool child"'
    child_tool = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux'; console.log(JSON.stringify(fauxAssistantMessage(fauxToolCall('bash',{command:process.argv[1]}),{stopReason:'toolUse'})));", child_command], cwd=REPO, text=True))
    with RealEditor('tool-created-child-tree', active=False, startup=True, launcher='plain', responses=[child_tool, MESSAGE], rate=1000) as editor:
        editor.chat('Create a child agent with the command client.')
        editor.wait(lambda: len(editor.rpc.request('session.list')['items']) == 2, 'Bash creates an actual child agent', timeout=15)
        child = editor.snapshot('tool-child')['session']
        assert child['parent_session_id'] == editor.session_id and child['workspace'] == str(editor.root), child
        editor.observe('true')
        editor.wait(lambda: editor.snapshot()['active_submission_id'] is None, 'parent finishes after creating the child', timeout=15)
        def tree_lines():
            return next(window['lines'] for window in editor.windows() if window['name']=='harness://agents')
        editor.wait(lambda: any('Tool child [idle]' in line for line in tree_lines()), 'tool child appears without refreshing or entering the open tree')
        lines = tree_lines()
        parent = next(i for i,line in enumerate(lines) if 'New chat [' in line)
        nested = next(i for i,line in enumerate(lines) if 'Tool child [' in line)
        assert nested > parent and lines[nested].startswith('    '), lines
        editor.tree_row('Tool child [')
        editor.keys('\r')
        editor.wait(lambda: 'Session: Tool child' in editor.panel_text(), 'Enter selects tool-created chat')
        assert not editor.snapshot('tool-child')['entries'], 'Child history is separate'

def lost_receipt_draft_and_duplicate_case():
    with RealEditor('lost-receipt-draft-and-duplicate', active=False, drop_receipt=True) as editor:
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ', 0, -1, false, {"Original request"})')
        editor.command('Harness send')
        editor.wait(lambda: (editor.root / 'dropped.json').exists(), 'durable receipt before injected disconnect')
        receipt = json.loads((editor.root / 'dropped.json').read_text())
        editor.wait(lambda: 'Connection closed' in editor.panel_text(), 'visible uncertain receipt')
        assert editor.panel_text('prompt') == 'Original request\n'
        editor.command('Harness')
        editor.wait(lambda: 'Connection: connected' in editor.panel_text(), 'reconnect after receipt loss')
        editor.command('lua vim.api.nvim_buf_set_lines(' + editor.panel('prompt') + ', 0, -1, false, {"New unsent request"})')
        editor.command('Harness send')
        editor.pump(.3)
        stored = editor.rpc.request('submission.get', {'session_id': 'work', 'request_id': receipt['request_id']})
        assert stored['submission_id'] == receipt['submission_id']
        inputs = [item for item in editor.snapshot()['entries'] if item['kind'] == 'user']
        assert len(inputs) == 1 and inputs[0]['text'] == 'Original request', inputs
        assert editor.panel_text('prompt') == 'New unsent request\n'

def integration_cases():
    launcher_cases()
    buffer_switch_case()
    model_picker_case()
    login_case()
    provider_generation_case()
    chat_actions_case()
    login_cancel_case()
    chat_write_case()
    prompt_window_case()
    if os.environ.get('HARNESS_TEST_NERDTREE'):
        explorer_cases(os.environ['HARNESS_TEST_NERDTREE'])
    first_run_setup_case()
    narrow_screen_controls_case()
    sidebar_controls_case()
    separate_tab_chats_case()
    multiple_sessions_case()
    completion_during_prompt_case()
    new_run_during_prompt_case()
    connection_failure_during_stop_case()
    connection_failure_during_prompt_case()
    escape_during_stop_wait_case()
    forced_exit_and_recovery_case()
    neovim_starts_missing_server_case()
    hidden_unsent_draft_case()
    explicit_editor_context_and_streaming_case()
    actual_tool_activity_case()
    tool_created_child_tree_case()
    lost_receipt_draft_and_duplicate_case()

def legacy_case(prior):
    root = EVIDENCE / 'legacy-server-upgrade-and-enter'
    root.mkdir()
    (root / 'one').write_text('one\n')
    (root / 'two').write_text('two\n')
    config, socket_path = root / 'config.json', root / 'control.sock'
    config.write_text(json.dumps({'provider': 'faux', 'model': 'test', 'state_dir': str(root / 'state'), 'socket_path': str(socket_path)}))
    responses = root / 'responses.json'
    old_answer = dict(MESSAGE, content=[{'type': 'text', 'text': 'History from the prior server.'}])
    responses.write_text(json.dumps([old_answer, MESSAGE]))
    env = dict(os.environ, TERM='xterm-256color', HARNESS_REPO=str(REPO), HARNESS_EXECUTABLE=str(BINARY),
               HARNESS_WORKSPACE=str(root), HARNESS_CONFIG=str(config), HARNESS_SOCKET=str(socket_path),
               HARNESS_FAUX_RESPONSES=str(responses), HARNESS_FAUX_TOKENS_PER_SECOND='100', HARNESS_INITIAL_COMMAND='Harness new')
    old_binary = prior / 'target/debug/harness'
    start = subprocess.run([str(old_binary), '--config', str(config), 'start'], env=env, text=True, capture_output=True, timeout=15)
    assert start.returncode == 0, start.stderr
    original = Rpc(socket_path)
    original_hello = original.request('system.hello', {'api_version': 1})
    assert original_hello.get('api_revision', 0) < 4, original_hello
    original.request('session.create', {'session_id': 'stored', 'workspace': str(root)})
    original.request('input.submit', {'session_id': 'stored', 'request_id': 'history', 'text': 'Preserve the prior history.', 'context': []})
    history_outcome = original.request('submission.wait', {'session_id': 'stored', 'request_id': 'history', 'timeout_ms': 10000})
    assert history_outcome['status'] == 'done'
    active = original.request('input.submit', {'session_id': 'stored', 'request_id': 'active', 'text': 'Keep accepted work until an explicit stop.', 'context': []})
    editor = Editor.__new__(Editor)
    editor.name, editor.root = 'legacy-server-upgrade-and-enter', root
    editor.launch(env)
    current = None
    try:
        editor.wait(lambda: b'harness upgrade' in editor.output.lower(), 'old live server is identified before any chat request')
        RealEditor.chat(editor, 'il cane di dio')
        assert 'il cane di dio' in editor.panel_text('prompt')
        assert b'Unknown parameter field' not in editor.output
        editor.command('Harness upgrade')
        editor.wait(lambda: b'Active work prevents shutdown' in editor.output, 'explicit upgrade refuses active prior work')
        assert original.request('system.hello', {'api_version': 1})['instance_id'] == original_hello['instance_id']
        assert original.request('submission.get', {'session_id': 'stored', 'request_id': 'active'})['submission_id'] == active['submission_id']
        assert len(original.request('session.list')['items']) == 1, 'Rejected creation must not create a chat on the old server'
        original.request('run.stop', {'session_id': 'stored', 'submission_id': active['submission_id']})
        after_answer = dict(MESSAGE, content=[{'type': 'text', 'text': 'The upgraded chat received the Enter task.'}])
        responses.write_text(json.dumps([after_answer]))
        editor.command('Harness upgrade')
        editor.wait(lambda: 'Session: New chat' in editor.panel_text(), 'explicit idle upgrade finishes and reconnects', timeout=20)
        original.close()
        current = Rpc(socket_path)
        hello = current.request('system.hello', {'api_version': 1})
        assert hello['api_revision'] == 4 and hello['instance_id'] != original_hello['instance_id']
        assert hello['state_dir'] == original_hello['state_dir']
        editor.wait(lambda: len(current.request('session.list')['items']) == 2, 'retained new chat is admitted after upgrade')
        created = next(item['session_id'] for item in current.request('session.list')['items'] if item['session_id'] != 'stored')
        assert editor.panel_text('prompt') == 'il cane di dio\n'
        editor.command('lua vim.api.nvim_set_current_win(vim.fn.win_findbuf(' + editor.panel('prompt') + ')[1]); vim.cmd("startinsert!")')
        editor.keys('\r')
        editor.wait(lambda: 'The upgraded chat received the Enter task.' in editor.panel_text(), 'Enter submits through the upgraded real Rust and Pi processes', timeout=10)
        snapshot = current.request('session.get', {'session_id': created})['snapshot']
        assert snapshot['state'] == 'idle'
        assert [entry['text'] for entry in snapshot['entries'] if entry['kind'] == 'user'] == ['il cane di dio']
        editor.command('Harness attach stored')
        editor.wait(lambda: 'History from the prior server.' in editor.panel_text(), 'prior chat history is visible after upgrade')
        assert current.request('submission.get', {'session_id': 'stored', 'request_id': 'history'}) == history_outcome
        (root / 'observed.json').write_text(json.dumps({'prior_api_revision': original_hello.get('api_revision'), 'current_api_revision': hello['api_revision'],
            'prior_binary_sha256': hashlib.sha256(old_binary.read_bytes()).hexdigest(),
            'current_binary_sha256': hashlib.sha256(BINARY.read_bytes()).hexdigest(),
            'prior_adapter_sha256': hashlib.sha256((prior / 'adapter/pi.mjs').read_bytes()).hexdigest(),
            'current_adapter_sha256': hashlib.sha256((REPO / 'adapter/pi.mjs').read_bytes()).hexdigest(),
            'busy_upgrade_preserved_instance_and_submission': True, 'state_directory_preserved': True,
            'prior_history_and_exact_outcome_preserved': True, 'draft_preserved': True, 'enter_submitted_once': True}, indent=2))
    finally:
        editor.finish()
        connection = Rpc(socket_path)
        for session in connection.request('session.list')['items']:
            snapshot = connection.request('session.get', {'session_id': session['session_id']})['snapshot']
            if snapshot['active_submission_id']:
                connection.request('run.stop', {'session_id': session['session_id'], 'submission_id': snapshot['active_submission_id']})
        connection.request('server.shutdown')
        connection.close()
        if current: current.close()
        original.close()

def main():
    if ARGS.group in ('all', 'exit'): exit_cases()
    if ARGS.group in ('all', 'integration'): integration_cases()
    if ARGS.group == 'legacy' or ARGS.legacy_root:
        assert ARGS.legacy_root, '--group legacy requires --legacy-root'
        legacy_case(ARGS.legacy_root)
    evidence = {'nvim': subprocess.check_output(['nvim', '--version'], text=True).splitlines()[0], 'mode': 'real terminal, actual Rust server and Pi; faux provider and fail-closed OpenAI SDK fixtures', 'cases': RESULTS}
    (EVIDENCE / 'results.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps({'passed': len(RESULTS), 'evidence': str(EVIDENCE / 'results.json')}))

if __name__ == '__main__':
    main()
