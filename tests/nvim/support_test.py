#!/usr/bin/env python3
"""Check terminal observation and test-file cleanup with real child processes."""
import json
import ctypes
import os
import pty
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from desktop import Desktop

SUPPORT = Path(__file__).resolve().parent
PROGRAM = '''
import os
from interactive import EVIDENCE, run_tests
print(EVIDENCE, flush=True)
def main():
    (EVIDENCE / 'terminal.raw').write_bytes(b'test output')
    if os.environ.get('FAIL_TEST'):
        raise AssertionError('controlled failure')
    return {'cases': [{'case': 'example', 'passed': True}]}
run_tests(main, keep=bool(os.environ.get('KEEP_TEST')))
'''


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='harness-evidence-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.sentinel = self.root / 'unrelated'
        self.sentinel.write_text('keep')

    def run_case(self, *arguments, **environment):
        env = dict(os.environ, PYTHONPATH=str(SUPPORT), TMPDIR=str(self.root))
        env.pop('FAIL_TEST', None)
        env.pop('KEEP_TEST', None)
        env.update(environment)
        result = subprocess.run([sys.executable, '-c', PROGRAM, *arguments], env=env, text=True, capture_output=True, timeout=10)
        lines = result.stdout.splitlines()
        self.assertTrue(lines, result.stderr)
        self.assertEqual(self.sentinel.read_text(), 'keep')
        return result, Path(lines[0]), json.loads(lines[1]) if len(lines) > 1 else None

    def test_success_removes_only_generated_files(self):
        result, evidence, summary = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(evidence.exists())
        self.assertEqual(summary, {'passed': 1, 'temporary_files_removed': True})
        self.assertEqual(list(self.root.iterdir()), [self.sentinel])

    def test_explicit_evidence_keeps_report_and_files(self):
        requested = self.root / 'requested'
        requested.mkdir()
        (requested / 'existing').write_text('keep')
        result, evidence, summary = self.run_case('--evidence', str(requested))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence, requested)
        self.assertEqual((requested / 'existing').read_text(), 'keep')
        self.assertEqual((evidence / 'terminal.raw').read_bytes(), b'test output')
        report = json.loads(Path(summary['evidence']).read_text())
        self.assertEqual(report['cases'], [{'case': 'example', 'passed': True}])
        self.assertNotIn('temporary_files_removed', summary)

    def test_requested_recording_keeps_generated_files(self):
        result, evidence, summary = self.run_case(KEEP_TEST='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((evidence / 'terminal.raw').read_bytes(), b'test output')
        self.assertTrue(Path(summary['evidence']).is_file())

    def test_failure_retains_files_and_reports_path(self):
        result, evidence, summary = self.run_case(FAIL_TEST='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(summary)
        self.assertEqual((evidence / 'terminal.raw').read_bytes(), b'test output')
        self.assertIn(f'Test files retained at {evidence}', result.stderr)
        self.assertIn('controlled failure', result.stderr)
        self.assertFalse((evidence / 'results.json').exists())


class ObservationTests(unittest.TestCase):
    def test_observation_keeps_json_off_the_calling_terminal(self):
        with tempfile.TemporaryDirectory(prefix='harness-observe-') as directory:
            root = Path(directory)
            socket = root / 'editor.sock'
            server = subprocess.Popen(['nvim', '--headless', '-u', 'NONE', '-n', '-i', 'NONE', '--listen', str(socket)],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            master, slave = pty.openpty()
            os.set_blocking(master, False)
            try:
                deadline = time.monotonic() + 5
                while not socket.exists() and server.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(socket.exists(), 'Observation server did not start')
                program = '''
import json, os
from types import SimpleNamespace
from real import RealEditor
editor = SimpleNamespace(editor_socket=os.environ['HARNESS_OBSERVE_SOCKET'])
print(json.dumps(RealEditor.observe(editor, '({flag=true,text="\u03bb \u4e16\u754c",items={1,2,3}})')))
'''
                env = dict(os.environ, PYTHONPATH=str(SUPPORT), TMPDIR=str(root), HARNESS_OBSERVE_SOCKET=str(socket))
                for terminal_stdin in (False, True):
                    for terminal_stderr in (False, True):
                        with self.subTest(stdin_terminal=terminal_stdin, stderr_terminal=terminal_stderr):
                            result = subprocess.run([sys.executable, '-c', program, '--evidence', str(root / 'evidence')],
                                env=env, stdin=slave if terminal_stdin else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=slave if terminal_stderr else subprocess.PIPE,
                                text=True, timeout=15)
                            terminal_output = bytearray()
                            while True:
                                try: terminal_output.extend(os.read(master, 65536))
                                except BlockingIOError: break
                            self.assertEqual(result.returncode, 0, result.stderr or terminal_output.decode())
                            self.assertEqual(json.loads(result.stdout), {'flag': True, 'text': '\u03bb \u4e16\u754c', 'items': [1, 2, 3]})
                            self.assertFalse(result.stderr)
                            self.assertFalse(terminal_output)
            finally:
                os.close(slave)
                os.close(master)
                if server.poll() is None: server.terminate()
                try: server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
                server.stderr.close()


class DesktopTests(unittest.TestCase):
    def setUp(self):
        executable = os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb')
        self.assertTrue(executable, 'Desktop support tests require Xvfb')
        read_fd, write_fd = os.pipe()
        try:
            self.server = subprocess.Popen([executable, '-displayfd', str(write_fd), '-screen', '0', '320x240x24', '-nolisten', 'tcp'],
                                           pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        finally:
            os.close(write_fd)
        self.addCleanup(self.stop_server)
        with os.fdopen(read_fd) as selected:
            self.display = ':' + selected.readline().strip()
        self.assertNotEqual(self.display, ':', 'The test X server did not start')
        self.desktop = Desktop(self.display)
        self.addCleanup(self.desktop.close)
        pointer, window = ctypes.c_void_p, ctypes.c_ulong
        signatures = {
            'XCreateSimpleWindow': ([pointer, window, ctypes.c_int, ctypes.c_int, *[ctypes.c_uint] * 3, window, window], window),
            'XStoreName': ([pointer, window, ctypes.c_char_p], ctypes.c_int),
            'XDestroyWindow': ([pointer, window], ctypes.c_int),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.desktop.x11, name)
            function.argtypes, function.restype = arguments, result

    def stop_server(self):
        if self.server.poll() is None: self.server.terminate()
        try: self.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait(timeout=5)
        self.server.stderr.close()

    def window(self, title):
        desktop = self.desktop
        root = desktop.x11.XDefaultRootWindow(desktop.connection)
        window = desktop.x11.XCreateSimpleWindow(desktop.connection, root, 0, 0, 100, 100, 0, 0, 0)
        desktop.x11.XStoreName(desktop.connection, window, title.encode())
        desktop.x11.XSync(desktop.connection, 0)
        return window

    def test_closed_windows_do_not_stop_window_discovery(self):
        closed = self.window('Closed test window')
        existing = self.window('Existing test window')
        self.assertEqual(self.desktop.title(closed), 'Closed test window')
        self.desktop.x11.XDestroyWindow(self.desktop.connection, closed)
        self.desktop.x11.XSync(self.desktop.connection, 0)
        self.assertEqual(self.desktop.title(closed), '')
        self.assertIsNone(self.desktop.find('Closed test window', closed, exact=True))
        self.assertEqual(self.desktop.find('Existing test window', exact=True), existing)

    def test_focus_and_input_errors_restore_the_previous_handler(self):
        window = self.window('Unmapped test window')
        errors = []
        handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda *_: errors.append(True) or 0)
        previous = self.desktop.x11.XSetErrorHandler(ctypes.cast(handler, ctypes.c_void_p))
        try:
            # Focusing an existing but unmapped window must still reject BadMatch.
            with self.assertRaisesRegex(RuntimeError, 'X11 error 8, request 42'):
                self.desktop.focus(window)
            self.desktop.x11.XDestroyWindow(self.desktop.connection, window)
            self.desktop.x11.XSync(self.desktop.connection, 0)
            with self.assertRaisesRegex(RuntimeError, 'X11 error 3'):
                self.desktop.key(window, ord('a'))
            with self.assertRaisesRegex(RuntimeError, 'X11 error 9'):
                self.desktop.click(window, 1, 1, 80, 24)
            self.assertFalse(errors, 'The checked operations must raise through Python')
            self.desktop.x11.XRaiseWindow(self.desktop.connection, window)
            self.desktop.x11.XSync(self.desktop.connection, 0)
            self.assertEqual(len(errors), 1, 'The preceding handler must be restored after an error')
        finally:
            self.desktop.x11.XSetErrorHandler(previous)

    def test_pending_errors_are_not_hidden_by_discovery_with_two_connections(self):
        window = self.window('Closed test window')
        self.desktop.x11.XDestroyWindow(self.desktop.connection, window)
        self.desktop.x11.XSync(self.desktop.connection, 0)
        other = Desktop(self.display)
        try:
            # This error belongs to focus, not to the following optional title read.
            self.desktop.x11.XRaiseWindow(self.desktop.connection, window)
            with self.assertRaisesRegex(RuntimeError, 'X11 error 3, request 12'):
                self.desktop.title(window)
            self.assertEqual(self.desktop.title(window), '')
            self.desktop.close()
            self.assertIsNone(other.find('No matching window', exact=True))
        finally:
            other.close()


if __name__ == '__main__':
    unittest.main()
