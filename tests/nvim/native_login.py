#!/usr/bin/env python3
"""Optional Alacritty and tmux login test with actual desktop mouse input."""
import ctypes
import hashlib
import json
import os
import subprocess
import time

from interactive import REPO
from login_gui import GuiEditor, desktop, login

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


class Mouse:
    def __init__(self, display):
        self.x, self.t = ctypes.CDLL('libX11.so.6'), ctypes.CDLL('libXtst.so.6')
        pointer, window = ctypes.c_void_p, ctypes.c_ulong
        self.x.XOpenDisplay.restype = pointer
        self.x.XDefaultRootWindow.argtypes, self.x.XDefaultRootWindow.restype = [pointer], window
        self.x.XQueryTree.argtypes = [pointer, window, ctypes.POINTER(window), ctypes.POINTER(window),
                                     ctypes.POINTER(ctypes.POINTER(window)), ctypes.POINTER(ctypes.c_uint)]
        self.x.XFetchName.argtypes = [pointer, window, ctypes.POINTER(pointer)]
        self.x.XGetGeometry.argtypes = [pointer, window, ctypes.POINTER(window), ctypes.POINTER(ctypes.c_int),
                                       ctypes.POINTER(ctypes.c_int), *[ctypes.POINTER(ctypes.c_uint)] * 4]
        self.x.XSetInputFocus.argtypes, self.x.XRaiseWindow.argtypes = [pointer, window, ctypes.c_int, window], [pointer, window]
        self.x.XKeysymToKeycode.argtypes = [pointer, window]
        self.x.XFlush.argtypes = self.x.XCloseDisplay.argtypes = self.x.XFree.argtypes = [pointer]
        self.t.XTestFakeMotionEvent.argtypes = [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int, window]
        self.t.XTestFakeButtonEvent.argtypes = self.t.XTestFakeKeyEvent.argtypes = [pointer, ctypes.c_uint, ctypes.c_int, window]
        self.connection = self.x.XOpenDisplay(display.encode())
        assert self.connection, 'Cannot open the isolated desktop'

    def find(self, window=None):
        window = window or self.x.XDefaultRootWindow(self.connection)
        name = ctypes.c_void_p()
        if self.x.XFetchName(self.connection, window, ctypes.byref(name)) and name.value:
            try: title = ctypes.string_at(name).decode(errors='replace')
            finally: self.x.XFree(name)
            if title == 'Harness URL test': return window
        root, parent, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
        children = ctypes.POINTER(ctypes.c_ulong)()
        if not self.x.XQueryTree(self.connection, window, ctypes.byref(root), ctypes.byref(parent),
                                 ctypes.byref(children), ctypes.byref(count)): return None
        try: items = [children[index] for index in range(count.value)]
        finally:
            if children: self.x.XFree(children)
        return next((found for child in items if (found := self.find(child))), None)

    def click(self, editor, column, row, modified=False):
        window, root, left, top = self.find(), ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int()
        assert window, 'Cannot find the Alacritty window'
        width, height, border, depth = [ctypes.c_uint() for _ in range(4)]
        assert self.x.XGetGeometry(self.connection, window, ctypes.byref(root), ctypes.byref(left), ctypes.byref(top),
                                  ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth))
        columns, lines = editor.observe('{vim.o.columns,vim.o.lines}')
        x, y = left.value + int((column - .5) * width.value / columns), top.value + int((row - .5) * height.value / (lines + 1))
        self.x.XRaiseWindow(self.connection, window)
        self.x.XSetInputFocus(self.connection, window, 1, 0)
        self.t.XTestFakeMotionEvent(self.connection, -1, x, y, 0)
        keys = [self.x.XKeysymToKeycode(self.connection, key) for key in (0xffe3, 0xffe1)] if modified else []
        for key in keys: self.t.XTestFakeKeyEvent(self.connection, key, 1, 0)
        self.t.XTestFakeButtonEvent(self.connection, 1, 1, 0)
        self.t.XTestFakeButtonEvent(self.connection, 1, 0, 0)
        for key in reversed(keys): self.t.XTestFakeKeyEvent(self.connection, key, 0, 0)
        self.x.XFlush(self.connection)
        editor.pump(.5)

    def close(self):
        self.x.XCloseDisplay(self.connection)


def main():
    with desktop() as display:
        mouse, editor = Mouse(display), None
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
            mouse.click(editor, position['col'], position['row'])
            editor.wait(lambda: len(editor.browser_urls()) == 2, 'a native mouse click opens the browser')
            assert editor.browser_urls() == [URL, URL], 'The mouse action must preserve the complete URL'
            mouse.click(editor, position['col'], position['row'], modified=True)
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
            mouse.close()
            if editor: editor.abort()
            for instance in GuiEditor.instances:
                if not instance.finished: instance.abort()


if __name__ == '__main__':
    main()
