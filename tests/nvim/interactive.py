#!/usr/bin/env python3
"""Drive actual Neovim in a terminal and retain terminal output as evidence."""
import argparse
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
import fcntl
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((REPO / 'tests/fixtures/protocol.json').read_text())
PARSER = argparse.ArgumentParser()
PARSER.add_argument('--evidence', type=Path)
PARSER.add_argument('--group', choices=['all', 'exit', 'integration', 'legacy'], default='all')
PARSER.add_argument('--legacy-root', type=Path, help='Prior source tree with target/debug/harness and its original adapter')
ARGS = PARSER.parse_args()
EVIDENCE = ARGS.evidence or Path(tempfile.mkdtemp(prefix='harness-nvim-ui-evidence-'))
EVIDENCE.mkdir(parents=True, exist_ok=True)
RESULTS = []

class Editor:
    def __init__(self, name):
        self.name = name
        self.root = EVIDENCE / name
        self.root.mkdir()
        (self.root / 'one').write_text('one\n')
        (self.root / 'two').write_text('two\n')
        self.state_path = self.root / 'state.json'
        session = {'metadata': dict(FIXTURE['snapshot']['session'], workspace=str(self.root)), 'state': 'running', 'active': 'run-one'}
        self.save({'sessions': {'work': session}, 'calls': [], 'receipts': {}})
        env = dict(os.environ, TERM='xterm-256color', HARNESS_REPO=str(REPO), HARNESS_EXECUTABLE=str(REPO / 'tests/nvim/fake.py'), HARNESS_WORKSPACE=str(self.root), HARNESS_TEST_STATE=str(self.state_path))
        self.launch(env)
        self.wait(lambda: self.calls('session.watch'), 'initial watch')
        self.pump(.15)

    def launch(self, env, command=None):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        command = command or ['nvim', '-u', 'NONE', '-n', '-i', 'NONE', '--cmd', 'lua dofile(vim.env.HARNESS_REPO .. "/tests/nvim/interactive_init.lua")']
        def terminal_owner():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=self.root, env=env, preexec_fn=terminal_owner)
        os.close(slave)
        self.output = bytearray()

    def state(self):
        return json.loads(self.state_path.read_text())

    def save(self, state):
        temp = self.state_path.with_suffix('.external')
        temp.write_text(json.dumps(state))
        temp.replace(self.state_path)

    def calls(self, method):
        return [r for r in self.state()['calls'] if r['method'] == method]

    def pump(self, seconds=.08):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.master], [], [], .01)[0]:
                try: data = os.read(self.master, 65536)
                except OSError: break
                self.output.extend(data)
                # Reply to terminal queries. These replies prevent artificial
                # startup and shutdown delays in the terminal under test.
                if b'\x1b]11;?' in data: os.write(self.master, b'\x1b]11;rgb:0000/0000/0000\x07')
                if b'\x1b[5n' in data: os.write(self.master, b'\x1b[0n')
                if b'\x1b[c' in data: os.write(self.master, b'\x1b[?1;2c')
                if b'\x1b[>c' in data: os.write(self.master, b'\x1b[>0;0;0c')

    def wait(self, condition, message, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if condition(): return
        self.record()
        raise AssertionError(f'{self.name}: timed out: {message}')

    def keys(self, text):
        os.write(self.master, text.encode())
        self.pump()

    def command(self, text):
        self.keys('\x1b:' + text + '\r')

    def resize(self, columns, lines):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', lines, columns, 0, 0))
        self.pump(.2)

    @staticmethod
    def panel(kind='transcript'):
        if kind == 'agents': return 'vim.fn.bufnr("harness://agents")'
        # Read native buffer names, without reaching into plugin state.
        chat = '(function() for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do local b=vim.api.nvim_win_get_buf(w); if vim.api.nvim_buf_get_name(b):match("^harness://chat/") then vim.t.harness_test_chat=b; return b end end; return vim.t.harness_test_chat or -1 end)()'
        if kind == 'transcript': return chat
        return '(function() local b=' + chat + '; if b<0 then return -1 end; return vim.fn.bufnr((vim.api.nvim_buf_get_name(b):gsub("^harness://chat/","harness://prompt/"))) end)()'

    def source(self, only=False):
        self.command('lua local b=vim.fn.bufnr(vim.env.HARNESS_WORKSPACE .. "/one"); local w=vim.fn.win_findbuf(b)[1] or vim.fn.win_findbuf(' + self.panel() + ')[1]; if w then vim.api.nvim_set_current_win(w) end; vim.cmd("hide buffer " .. b)' + ('; vim.cmd("only")' if only else ''))

    def panel_text(self, kind='transcript'):
        path = self.root / (kind + '.txt')
        path.unlink(missing_ok=True)
        self.command('lua local b=' + self.panel(kind) + '; vim.fn.writefile(b>=0 and vim.api.nvim_buf_get_lines(b, 0, -1, false) or {}, vim.env.HARNESS_WORKSPACE .. "/' + kind + '.txt")')
        self.wait(path.exists, 'read actual transcript')
        return path.read_text()

    def tree_row(self, text):
        self.command('lua local b=vim.fn.bufnr("harness://agents"); vim.api.nvim_set_current_win(vim.fn.win_findbuf(b)[1]); for i,line in ipairs(vim.api.nvim_buf_get_lines(b,0,-1,false)) do if line:find(' + json.dumps(text) + ',1,true) then vim.api.nvim_win_set_cursor(0,{i,0}); break end end')

    def prompt(self, command):
        start = len(self.output)
        self.command(command)
        self.wait(lambda: b'Press Escape to cancel closing.' in self.output[start:], 'exit prompt')

    def alive(self):
        return self.process.poll() is None

    def exits(self):
        self.wait(lambda: not self.alive(), 'normal exit')

    def stays(self):
        self.pump(.2)
        assert self.alive(), f'{self.name}: editor exited'
        marker = self.root / 'alive'
        self.command('lua vim.fn.writefile({"alive"}, vim.env.HARNESS_WORKSPACE .. "/alive")')
        self.wait(marker.exists, 'editor accepts commands after cancellation')

    def record(self):
        (self.root / 'terminal.raw').write_bytes(self.output)

    def finish(self):
        if self.alive():
            self.command('noautocmd qa!')
            self.exits()
        self.record()
        os.close(self.master)
        RESULTS.append({'case': self.name, 'passed': True, 'terminal': str(self.root / 'terminal.raw')})

def basic(command, answer, should_exit, label):
    editor = Editor(command + '-' + label)
    if command in ('q', 'wq'): editor.source(True)
    editor.prompt(command)
    editor.keys(answer)
    if should_exit: editor.exits()
    else: editor.stays()
    stops = editor.calls('run.stop')
    assert len(stops) == (1 if answer == 'no\r' else 0)
    assert editor.state()['sessions']['work'].get('active') == (None if answer == 'no\r' else 'run-one')
    editor.finish()

def main():
    for cmd in ('q', 'qa', 'wq', 'wqa'):
        for label, answer, exits in [('yes', 'yes\r', True), ('no', 'no\r', True), ('empty', '\r', False), ('invalid', 'Yes\r', False), ('escape', '\x1b', False), ('yes-escape', 'yes\x1b', False), ('space', 'yes \r', False)]:
            basic(cmd, answer, exits, label)

    editor = Editor('window-only')
    editor.command('q')
    editor.stays()
    assert not editor.calls('session.get'), 'Window closure must not prompt or query exit state'
    editor.finish()

    for cmd in ('q', 'qa', 'wq', 'wqa'):
        editor = Editor(cmd + '-modified')
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
        editor = Editor(cmd + '-hidden-modified')
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
        editor = Editor(cmd + '-write-failure')
        editor.source(True)
        editor.command('call setline(1, "changed") | set readonly')
        if cmd == 'wqa':
            editor.prompt(cmd)
            editor.keys('yes\r')
        else: editor.command(cmd)
        editor.stays()
        assert (editor.root / 'one').read_text() == 'one\n'
        editor.finish()

    editor = Editor('multiple-sessions')
    state = editor.state()
    state['sessions']['second'] = {'metadata': dict(state['sessions']['work']['metadata'], session_id='second'), 'state': 'running', 'active': 'run-two'}
    state['sessions']['other-client-only'] = {'metadata': dict(state['sessions']['work']['metadata'], session_id='other-client-only'), 'state': 'running', 'active': 'run-three'}
    editor.save(state)
    editor.command('Harness attach second')
    editor.wait(lambda: len(editor.calls('session.watch')) == 2, 'second watch')
    editor.prompt('HarnessQuit')
    editor.keys('no\r')
    editor.exits()
    assert {(r['params']['session_id'], r['params']['submission_id']) for r in editor.calls('run.stop')} == {('work', 'run-one'), ('second', 'run-two')}
    assert editor.state()['sessions']['other-client-only']['active'] == 'run-three'
    editor.finish()

    for replacement in (None, 'run-new'):
        editor = Editor('prompt-' + ('completion' if replacement is None else 'new-run'))
        editor.prompt('qa')
        state = editor.state()
        state['sessions']['work'].update(active=replacement, state='running' if replacement else 'idle')
        editor.save(state)
        start = len(editor.output)
        editor.keys('yes\r')
        if replacement:
            editor.wait(lambda: b'run-new' in editor.output[start:], 'new run requires new prompt')
            editor.keys('\x1b')
            editor.stays()
        else: editor.exits()
        assert not editor.calls('run.stop')
        editor.finish()

    editor = Editor('stop-connection-failure')
    state = editor.state(); state['fail_stop'] = True; editor.save(state)
    editor.prompt('qa')
    editor.keys('no\r')
    editor.stays()
    assert len(editor.calls('run.stop')) == 1
    assert editor.state()['sessions']['work']['active'] == 'run-one'
    editor.finish()

    editor = Editor('forced-exit')
    editor.command('noautocmd qa!')
    editor.exits()
    assert editor.state()['sessions']['work']['active'] == 'run-one'
    assert not editor.calls('run.stop')
    editor.finish()

    editor = Editor('unknown-exit-state')
    state = editor.state()
    state['sessions']['work'].update(state='unavailable', active=None)
    editor.save(state)
    editor.command('qa')
    editor.stays()
    assert not editor.calls('run.stop')
    editor.finish()

    (EVIDENCE / 'results.json').write_text(json.dumps({'nvim': subprocess.check_output(['nvim', '--version'], text=True).splitlines()[0], 'mode': 'real terminal; fixture client', 'cases': RESULTS}, indent=2))
    print(json.dumps({'passed': len(RESULTS), 'evidence': str(EVIDENCE / 'results.json')}))

if __name__ == "__main__":
    main()
