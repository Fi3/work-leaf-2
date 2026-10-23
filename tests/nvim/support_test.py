#!/usr/bin/env python3
"""Check terminal observation and test-file cleanup with real child processes."""
import json
import os
import pty
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

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


if __name__ == '__main__':
    unittest.main()
