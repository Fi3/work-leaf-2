#!/usr/bin/env python3
"""Optional Alacritty and tmux login test with actual desktop mouse input."""
import hashlib
import json
import os
import subprocess
import time

from interactive import REPO
from login_gui import GuiEditor, desktop, login
from desktop import Desktop

URL = 'https://login.example.test/device?state=' + 'abc%2F09' * 200


class NativeEditor(GuiEditor):
    def cli(self, *arguments):
        preload = self.root / 'long-device-url.mjs'
        preload.write_text(
            'import ' + json.dumps(str(REPO / 'tests/fixtures/oauth.mjs')) + ';\n'
            'const fetch = globalThis.fetch;\n'
            'globalThis.fetch = async (...args) => {\n'
            '  const result = await fetch(...args);\n'
            "  if (String(args[0]).endsWith('/login/device/code')) {\n"
            '    const body = await result.json();\n'
            '    return Response.json({...body, verification_uri: ' + json.dumps(URL)
            + ', verification_uri_complete: ' + json.dumps(URL) + '});\n'
            '  }\n  return result;\n};\n')
        self.env.update(NODE_OPTIONS='--import=' + str(preload), LIBGL_ALWAYS_SOFTWARE='1', WINIT_UNIX_BACKEND='x11')
        self.env.pop('TMUX', None)
        return super().cli(*arguments)

    def launch(self, env, command=None):
        self.master, self.output = os.open('/dev/null', os.O_RDONLY), bytearray()
        self.control, self.editor_socket = str(self.root / 'tmux.sock'), self.root / 'editor.sock'
        config, tmux = self.root / 'alacritty.toml', self.root / 'tmux.conf'
        config.write_text('[window]\ntitle="Harness URL test"\ndynamic_title=false\n'
                          'dimensions={columns=120,lines=40}\n[font]\nsize=12\n')
        tmux.write_text("set -g mouse on\nset -g default-terminal 'alacritty'\n"
                        "set -ga terminal-overrides ',alacritty:RGB'\n")
        self.terminal_log = (self.root / 'alacritty.log').open('wb')
        command = command or ['nvim', '-u', 'NONE', '-n', '-i', 'NONE', '--listen', str(self.editor_socket),
                              '--cmd', 'lua dofile(vim.env.HARNESS_REPO .. "/tests/nvim/interactive_init.lua")']
        self.process = subprocess.Popen(
            ['alacritty', '--config-file', str(config), '-e', 'tmux', '-S', self.control, '-f', str(tmux), 'new-session', *command],
            cwd=self.root, env=env, stdout=self.terminal_log, stderr=self.terminal_log)
        self.wait(self.editor_socket.exists, 'Alacritty starts actual Neovim through tmux', 15)

    def pump(self, seconds=.08):
        time.sleep(seconds)
        result = subprocess.run(['tmux', '-S', self.control, 'capture-pane', '-e', '-p'], capture_output=True, timeout=5)
        if result.returncode == 0: self.output.extend(result.stdout)

    def keys(self, text):
        subprocess.run(['tmux', '-S', self.control, 'send-keys', '-l', '--', text], check=True, capture_output=True, timeout=5)
        self.pump()

    def record(self):
        (self.root / 'terminal.raw').write_bytes(self.output)

    def screenshot(self, name):
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x960',
                        '-i', self.display, '-frames:v', '1', '-y', str(self.root / (name + '.png'))], check=True)

    def mouse(self, button, column, row, modifiers=()):
        assert button == 0, 'Desktop login controls use the left mouse button'
        columns, lines = self.observe('{vim.o.columns,vim.o.lines}')
        with Desktop(self.display) as desktop:
            window = desktop.find('Harness URL test', exact=True)
            assert window, 'Cannot find the Alacritty window'
            desktop.click(window, column, row, columns, lines + 1, modifiers)
        self.pump(.5)


def main():
    with desktop() as display:
        editor = None
        try:
            editor = NativeEditor('alacritty-tmux-browser-link', display, pending=100000)
            login(editor, 'github-copilot', 'GitHub Copilot')
            editor.wait(lambda: any('GitHub Enterprise URL' in line for window in editor.windows() for line in window['lines']),
                        'GitHub host prompt')
            editor.keys('\r')
            editor.wait(editor.browser_urls, 'the editor opens the browser automatically')
            editor.pump(.5)
            assert editor.browser_urls() == [URL], 'Login must open the complete URL exactly once'
            window = next(window for window in editor.windows() if window['name'] == 'harness://setup')
            assert not any('https://' in line for line in window['lines']), 'The default view must not expose a wrapped URL'
            row = next(index for index, line in enumerate(window['lines'], 1) if line == '[ Open browser ]')
            position = editor.observe('vim.fn.screenpos(' + str(window['id']) + ',' + str(row) + ',6)')
            assert position['row'] > 0 and position['col'] > 0, 'The action must be visible'
            editor.mouse(0, position['col'], position['row'])
            editor.wait(lambda: len(editor.browser_urls()) == 2, 'a native mouse click opens the browser')
            assert editor.browser_urls() == [URL, URL], 'The mouse action must preserve the complete URL'
            editor.mouse(0, position['col'], position['row'], modifiers=(0xffe3, 0xffe1))
            assert editor.browser_urls() == [URL, URL], 'Outer terminal link detection must not open a partial URL'
            editor.screenshot('native-login')
            editor.keys('\x03')
            editor.wait(lambda: not any(window['name'] == 'harness://setup' for window in editor.windows()), 'cancel returns to chat')
            report = {
                'passed': True, 'command': 'python3 tests/nvim/native_login.py',
                'scope': 'Actual Alacritty, tmux, Neovim, Rust and Pi; synthetic device replies; browser opener captured; no real account',
                'input': 'X11 XTest mouse; tmux send-keys keyboard',
                'terminal_format': 'Successive tmux capture-pane screens with ANSI colors',
                'runtimes': {name: subprocess.check_output(command, text=True).splitlines()[0] for name, command in [
                    ('alacritty', ['alacritty', '--version']), ('tmux', ['tmux', '-V']), ('neovim', ['nvim', '--version']),
                    ('node', ['node', '--version']), ('python', ['python3', '--version'])]},
                'checks': {'automatic_open_count': 1, 'native_click_open_count': 1, 'long_target_preserved': True,
                           'outer_terminal_modifier_click_cannot_open_truncated_url': True, 'cancel_returned_to_chat': True},
                'url_bytes': len(URL), 'exact_opener_arguments': editor.browser_urls(),
                'source_sha256': {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for folder in ('src', 'adapter', 'lua', 'plugin', 'tests/nvim', 'tests/fixtures')
                                  for path in sorted((REPO / folder).rglob('*')) if path.is_file() and '__pycache__' not in str(path)},
            }
            editor.finish()
            for name in ('native-login.png', 'terminal.raw'):
                report[name + '_sha256'] = hashlib.sha256((editor.root / name).read_bytes()).hexdigest()
            (editor.root / 'observed.json').write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps({'passed': 1, 'evidence': str(editor.root / 'observed.json')}))
        finally:
            if editor: editor.abort()
            for instance in GuiEditor.instances:
                if not instance.finished: instance.abort()


if __name__ == '__main__':
    main()
