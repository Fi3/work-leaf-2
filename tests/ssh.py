#!/usr/bin/env python3
"""Test browser sign-in through actual SSH with separate loopback networks."""
import argparse
import atexit
import fcntl
import http.server
import json
import os
import pty
import pwd
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BINARY = REPO / 'target/debug/harness'


def run(*arguments, **options):
    return subprocess.run(arguments, check=True, text=True, capture_output=True, timeout=15, **options).stdout


def wait(condition, message, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition(): return
        time.sleep(.05)
    raise AssertionError(message)


def available(port, host='127.0.0.1'):
    with socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: listener.bind((host, port)); return True
        except OSError: return False


def remote_peer():
    """Replace only the editor boundary for transport failure tests."""
    import tty
    tty.setraw(0)
    child, server = None, None
    records = []
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))

    def emit(value):
        print('HARNESS_TEST ' + json.dumps(value), flush=True)

    def close():
        nonlocal child, server
        if child:
            child.stdin.close()
            child.wait(timeout=10)
            child = None
        if server:
            server.shutdown(); server.server_close()
            server = None

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            records.append(self.path)
            self.send_response(200); self.end_headers(); self.wfile.write(b'REMOTE CALLBACK')

    path = Path(os.environ['HARNESS_BROWSER_SOCKET'])
    emit({'ready': True, 'socket': str(path), 'mode': path.stat().st_mode & 0o777,
          'directory_mode': path.parent.stat().st_mode & 0o777,
          'network': os.readlink('/proc/self/ns/net')})
    try:
        for line in sys.stdin:
            command = json.loads(line)
            if command['op'] == 'exit': break
            if command['op'] == 'close':
                close(); emit({'closed': True}); continue
            if command['op'] == 'records':
                emit({'records': records}); continue
            assert command['op'] == 'open'
            close()
            request = command['request']
            callback = request.get('callback')
            if callback:
                address = callback['host'] if callback['host'] != 'localhost' else '127.0.0.1'
                class Server(http.server.ThreadingHTTPServer):
                    address_family = socket.AF_INET6 if ':' in address else socket.AF_INET
                server = Server((address, callback['port']), Handler)
                callback['port'] = server.server_port
                threading.Thread(target=server.serve_forever, daemon=True).start()
            child = subprocess.Popen([str(BINARY), 'browser'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            child.stdin.write(json.dumps(request) + '\n'); child.stdin.flush()
            assert select.select([child.stdout], [], [], 15)[0], 'Browser helper did not reply'
            reply = child.stdout.readline()
            emit({'request': request, 'reply': json.loads(reply) if reply else None})
    finally:
        close()


class Network:
    def __init__(self, root):
        self.root = root
        self.root.mkdir()
        self.anchor = subprocess.Popen(['unshare', '--net', 'sleep', '3600'])
        self.servers, self.logs, self.sessions = [], [], []
        self.closed = False
        atexit.register(self.close)
        wait(lambda: os.readlink(f'/proc/{self.anchor.pid}/ns/net') != os.readlink('/proc/self/ns/net'),
             'Remote network namespace did not start')
        run('ip', 'link', 'add', 'client', 'type', 'veth', 'peer', 'name', 'server')
        run('ip', 'link', 'set', 'server', 'netns', str(self.anchor.pid))
        run('ip', 'address', 'add', '192.0.2.1/30', 'dev', 'client')
        run('ip', 'link', 'set', 'client', 'up')
        self.remote('ip', 'link', 'set', 'lo', 'up')
        self.remote('ip', 'address', 'add', '192.0.2.2/30', 'dev', 'server')
        self.remote('ip', 'link', 'set', 'server', 'up')
        for name in ('host', 'identity'):
            run('/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root/name))
        self.port = 2222
        self.unrelated = 22445
        (root/'known_hosts').write_text('[192.0.2.2]:2222 ' + (root/'host.pub').read_text())
        self.client_config = root/'client.conf'
        self.client_config.write_text(
            f'Host harness-test\n HostName 192.0.2.2\n Port 2222\n User {pwd.getpwuid(os.getuid()).pw_name}\n'
            f' IdentityFile {root}/identity\n IdentitiesOnly yes\n UserKnownHostsFile {root}/known_hosts\n'
            f' StrictHostKeyChecking yes\n BatchMode yes\n LocalForward 127.0.0.1:{self.unrelated} 127.0.0.1:9\n')
        self.bin = root/'bin'; self.bin.mkdir()
        self.calls = root/'ssh-calls'
        wrapper = self.bin/'ssh'
        wrapper.write_text('#!/bin/sh\nprintf "invoked\\n" >> ' + shlex.quote(str(self.calls)) +
                           '\nexec /usr/bin/ssh -F ' + shlex.quote(str(self.client_config)) + ' "$@"\n')
        wrapper.chmod(0o700)
        self.start()

    def remote(self, *arguments, **options):
        return run('nsenter', '-t', str(self.anchor.pid), '--net', *arguments, **options)

    def start(self, tcp=True, stream=True):
        self.stop_server()
        configuration = self.root/'sshd.conf'
        configuration.write_text(
            f'Port {self.port}\nListenAddress 192.0.2.2\nHostKey {self.root}/host\n'
            f'PidFile {self.root}/sshd.pid\nAuthorizedKeysFile {self.root}/identity.pub\n'
            'StrictModes no\nUsePAM no\nPermitRootLogin yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n'
            'UseDNS no\nLogLevel VERBOSE\n'
            f'AllowTcpForwarding yes\nPermitOpen {"any" if tcp else "none"}\n'
            f'AllowStreamLocalForwarding {"yes" if stream else "no"}\n')
        log = (self.root/f'sshd-{len(self.logs)}.log').open('wb'); self.logs.append(log)
        server = subprocess.Popen(['nsenter', '-t', str(self.anchor.pid), '--net', '/usr/bin/sshd',
                                   '-D', '-e', '-f', str(configuration)], stdout=log, stderr=log)
        self.servers.append(server)
        def ready():
            assert server.poll() is None, 'The test SSH server exited'
            with socket.socket() as probe:
                return probe.connect_ex(('192.0.2.2', self.port)) == 0
        wait(ready, 'Test SSH server did not start')

    def stop_server(self):
        for server in self.servers:
            if server.poll() is None:
                server.terminate(); server.wait(timeout=5)

    def close(self):
        if self.closed: return
        self.closed = True
        failure = None
        try:
            for session in self.sessions:
                try: session.close()
                except Exception as error:
                    if failure is None: failure = error
        finally:
            self.stop_server()
            self.anchor.terminate(); self.anchor.wait(timeout=5)
            for log in self.logs: log.close()
        if failure: raise failure


class Session:
    def __init__(self, network, root, temporary=None):
        self.root, self.network = root, network
        self.closed, self.ready, self.killed = False, None, False
        root.mkdir()
        self.bin = root/'bin'; self.bin.mkdir()
        self.browser_log = root/'browser.jsonl'
        opener = self.bin/'xdg-open'
        opener.write_text('#!/usr/bin/python3\nimport json,sys\nwith open(' + repr(str(self.browser_log)) +
                          ',"a") as output: output.write(json.dumps(sys.argv[1:])+"\\n")\n')
        opener.chmod(0o700)
        for name in ('node', 'nvim'):
            denied = self.bin/name
            denied.write_text('#!/bin/sh\nprintf unexpected-local-runtime >&2\nexit 99\n')
            denied.chmod(0o700)
        remote = root/"remote harness's entry"
        remote.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + shlex.quote(str(Path(__file__).resolve())) + ' --peer\n')
        remote.chmod(0o700)
        self.temporary = temporary or network.root.parent/('s'+str(len(network.sessions)))
        self.temporary.mkdir(mode=0o700)
        self.env = dict(os.environ, PATH=str(self.bin)+':'+str(network.bin)+':'+os.environ['PATH'], TMPDIR=str(self.temporary))
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        def owner():
            os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.process = subprocess.Popen([str(BINARY), 'ssh', '--host', 'harness-test', '--workspace',
                                         str(root), '--remote-command', str(remote)],
                                        env=self.env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=owner)
        os.close(slave)
        self.output, self.records = bytearray(), []
        network.sessions.append(self)
        self.ready = self.receive(lambda record: record.get('ready'), allow_exit=True)
        if self.ready:
            assert self.ready['mode'] == 0o600 and self.ready['directory_mode'] == 0o700
            assert self.ready['network'] != os.readlink('/proc/self/ns/net')
            assert available(network.unrelated), 'User-configured forwards must not leak into launcher sessions'

    def receive(self, predicate, allow_exit=False):
        deadline = time.monotonic()+15
        pending = bytearray()
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], .05)[0]:
                try: data = os.read(self.master, 65536)
                except OSError: data = b''
                self.output.extend(data); pending.extend(data)
                while b'\n' in pending:
                    line, _, rest = pending.partition(b'\n'); pending = bytearray(rest)
                    if b'HARNESS_TEST ' in line:
                        record = json.loads(line.split(b'HARNESS_TEST ', 1)[1])
                        self.records.append(record)
                        if predicate(record): return record
            if self.process.poll() is not None:
                if allow_exit: return None
                raise AssertionError(self.output.decode(errors='replace'))
        raise AssertionError('SSH fixture timed out: ' + self.output.decode(errors='replace'))

    def command(self, command, key):
        os.write(self.master, (json.dumps(command)+'\n').encode())
        return self.receive(lambda record: key in record)

    def open(self, host=None, port=0, url=None):
        return self.command({'op': 'open', 'request': {'id': len(self.records),
                            'url': url or f'https://account.example.test/authorize?state=all%2Fbytes&scope=one%20two&attempt={len(self.records)}',
                            'callback': {'host': host, 'port': port} if host else None}}, 'reply')

    def urls(self):
        return [json.loads(line) for line in self.browser_log.read_text().splitlines()] if self.browser_log.exists() else []

    def close_login(self):
        self.command({'op': 'close'}, 'closed')

    def close(self):
        if self.closed: return
        self.closed = True
        try:
            if self.process.poll() is None:
                try: os.write(self.master, b'{"op":"exit"}\n')
                except OSError: pass
                try: self.process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    self.process.send_signal(signal.SIGINT)
                    try: self.process.wait(timeout=10)
                    except subprocess.TimeoutExpired: pass
        finally:
            try:
                if self.process.poll() is None:
                    self.process.kill(); self.process.wait(timeout=5)
            finally:
                os.close(self.master)
                (self.root/'terminal.raw').write_bytes(self.output)
        if self.ready:
            wait(lambda: not Path(self.ready['socket']).parent.exists(), 'Owned remote socket directory survived exit')
        directories = list(self.temporary.glob('harness-ssh-*'))
        if self.killed:
            for directory in directories:
                with socket.socket(socket.AF_UNIX) as probe:
                    assert probe.connect_ex(str(directory/'browser.sock')) != 0, 'A killed launcher left a live browser socket'
        else:
            assert not directories, 'Owned local socket directory survived exit'
            self.temporary.rmdir()


def callback(port, host='127.0.0.1'):
    with socket.create_connection((host, port), timeout=3) as connection:
        connection.sendall(b'GET /complete?state=exact HTTP/1.0\r\nHost: localhost\r\n\r\n')
        data = b''
        while chunk := connection.recv(4096): data += chunk
        assert b'200 OK' in data and data.endswith(b'REMOTE CALLBACK'), data


def components(network, evidence):
    results = []
    before = network.calls.read_bytes() if network.calls.exists() else b''
    parent = tempfile.gettempdir()
    if len(parent) > 20: parent = '/tmp'
    temporary = Path(tempfile.mkdtemp(prefix='l-', dir=parent))
    try:
        selected = temporary/('x'*(41-len(str(temporary))-1))
        long = Session(network, evidence/'long-path', temporary=selected)
        try:
            assert long.ready is None and b'Set TMPDIR to a shorter path' in long.output, long.output
            assert long.process.returncode == 2
            assert (network.calls.read_bytes() if network.calls.exists() else b'') == before, 'Invalid path started SSH'
        finally: long.close()
    finally: temporary.rmdir()
    results.append({'overlong_temporary_control_path': True, 'ssh_started': False})
    session = Session(network, evidence/"transport a'b")
    try:
        assert session.ready, session.output.decode(errors='replace')
        for host, port in [('127.0.0.1', 1455), ('localhost', 0), ('::1', 0)]:
            before = session.urls()
            record = session.open(host, port)
            assert record['reply']['error'] is None, record
            selected = record['request']['callback']['port']
            wait(lambda: session.urls() == before + [[record['request']['url']]], 'Complete browser URL was not delivered exactly once')
            callback(selected, '::1' if host == '::1' else '127.0.0.1')
            if host == 'localhost': callback(selected, '::1')
            assert available(network.unrelated), 'Unrelated SSH configuration forward was created'
            session.close_login()
            wait(lambda: available(selected, '::1' if host == '::1' else '127.0.0.1'), 'Login EOF did not release the callback')
            if host == 'localhost': assert available(selected, '::1')
            results.append({'callback': host, 'port': selected, 'full_url': True, 'eof_released': True})
        before = session.urls()
        device = session.open(url='https://account.example.test/device?code=TEST-DEVICE')
        assert device['reply']['error'] is None
        wait(lambda: session.urls() == before + [[device['request']['url']]], 'Device browser URL was not delivered exactly once')
        session.close_login()
        for host, bind_host in [('127.0.0.1', '127.0.0.1'), ('localhost', '::1')]:
            with socket.socket(socket.AF_INET6 if ':' in bind_host else socket.AF_INET) as foreign:
                foreign.bind((bind_host, 0)); foreign.listen()
                port = foreign.getsockname()[1]
                before = len(session.urls())
                rejected = session.open(host, port)
                assert rejected['reply']['error'] and len(session.urls()) == before, rejected
                with socket.create_connection((bind_host, port), timeout=3):
                    accepted, _ = foreign.accept(); accepted.close()
                if host == 'localhost': assert available(port), 'Partial localhost forward was not rolled back'
                session.close_login()
            results.append({'conflict': bind_host, 'foreign_listener_preserved': True})
        record = session.open('127.0.0.1', 1455)
        assert record['reply']['error'] is None, record
        wait(lambda: session.urls()[-1] == [record['request']['url']], 'Browser did not open before normal exit')
    finally: session.close()
    assert session.process.returncode == 0, 'Normal remote exit returned failure'
    assert available(1455), 'Normal SSH exit did not release an active callback'
    results.append({'normal_exit_with_active_login': True, 'callback_released': True})
    for tcp, stream in [(False, True), (True, False)]:
        network.start(tcp=tcp, stream=stream)
        rejected = Session(network, evidence/('deny-tcp' if not tcp else 'deny-socket'))
        try:
            if stream:
                record = rejected.open('127.0.0.1', 1455)
                assert record['reply']['error'] and not rejected.urls(), record
                assert available(1455), 'Rejected TCP policy left a callback listener'
            else:
                assert rejected.ready is None and rejected.process.returncode != 0
                assert not rejected.urls()
            results.append({'denied': 'tcp' if not tcp else 'unix', 'browser_opened': False})
        finally: rejected.close()
    network.start()
    disconnected = Session(network, evidence/'disconnect')
    try:
        record = disconnected.open('127.0.0.1', 1455)
        assert record['reply']['error'] is None, record
        wait(lambda: disconnected.urls() == [[record['request']['url']]], 'Browser did not open before connection loss')
        control = next(disconnected.temporary.glob('harness-ssh-*/control'))
        status = subprocess.run(['/usr/bin/ssh', '-F', '/dev/null', '-S', str(control), '-O', 'check', 'harness-test'],
                                text=True, capture_output=True, check=True, timeout=5)
        pid = int(status.stderr.split('pid=', 1)[1].split(')', 1)[0])
        assert str(control).encode() in Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
        os.kill(pid, signal.SIGTERM)
        disconnected.receive(lambda _: False, allow_exit=True)
        assert disconnected.process.returncode != 0, 'Connection loss was reported as a normal editor exit'
        wait(lambda: available(1455), 'Connection loss left a local callback listener')
        results.append({'connection_loss': True, 'callback_released': True, 'exit_failed': True})
    finally: disconnected.close()
    forced = Session(network, evidence/'killed')
    try:
        record = forced.open('127.0.0.1', 1455)
        assert record['reply']['error'] is None, record
        wait(lambda: forced.urls() == [[record['request']['url']]], 'Browser did not open before launcher failure')
        children = Path(f'/proc/{forced.process.pid}/task/{forced.process.pid}/children').read_text().split()
        assert len(children) == 2, 'The launcher must own both actual SSH processes'
        assert all(b'ssh\0' in Path('/proc', pid, 'cmdline').read_bytes() for pid in children)
        forced.killed = True
        forced.process.kill()
        forced.receive(lambda _: False, allow_exit=True)
        def stopped(pid):
            try: return Path('/proc', pid, 'stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z'
            except (FileNotFoundError, ProcessLookupError): return True
        wait(lambda: all(stopped(pid) for pid in children), 'Killed launcher left owned SSH processes alive')
        wait(lambda: available(1455), 'Killed launcher left a callback listener')
        results.append({'launcher_sigkill': True, 'ssh_children_stopped': True, 'callback_released': True,
                        'stale_private_local_directory_possible': True})
    finally: forced.close()
    return results


def gui(network, evidence):
    sys.path.insert(0, str(REPO/'tests/nvim'))
    sys.argv = [sys.argv[0], '--evidence', str(evidence)]
    from login_gui import GuiEditor, desktop, login, click_terminal_link

    class SshEditor(GuiEditor):
        def __init__(self, name, display, plain=False):
            self.plain = plain
            super().__init__(name, display, browser=True, clipboard=None, generation=[{'kind': 'answer'}])

        def remote_environment(self):
            directory = self.root/'remote-bin'; directory.mkdir(exist_ok=True)
            opener = directory/'xdg-open'
            opener.write_text('#!/bin/sh\nprintf unexpected-remote-browser >> ' +
                              shlex.quote(str(self.root/'remote-browser.log')) + '\nexit 99\n')
            opener.chmod(0o700)
            names = ('HOME', 'TERM', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'OPENAI_API_KEY',
                     'HARNESS_REPO', 'HARNESS_EXECUTABLE', 'HARNESS_WORKSPACE', 'HARNESS_CONFIG',
                     'HARNESS_SOCKET', 'HARNESS_FAUX_RESPONSES', 'HARNESS_FAUX_TOKENS_PER_SECOND',
                     'HARNESS_TEST_OAUTH_RECORD', 'HARNESS_TEST_OAUTH_PENDING',
                     'HARNESS_TEST_GENERATION_RECORD', 'HARNESS_TEST_GENERATION_CONTROL')
            environment = {name: self.env[name] for name in names if name in self.env}
            environment.update(PATH=str(directory)+':'+os.environ['PATH'],
                               XDG_CONFIG_HOME=str(self.root/'remote-config'), XDG_DATA_HOME=str(self.root/'remote-data'),
                               XDG_STATE_HOME=str(self.root/'remote-state'), XDG_CACHE_HOME=str(self.root/'remote-cache'),
                               TMPDIR=str(evidence))
            return environment

        def cli(self, *arguments):
            self.prepare_browser()
            return network.remote(str(BINARY), '--config', str(self.config), *arguments,
                                  env=self.remote_environment())

        def launch(self, environment, command=None):
            remote_environment = self.remote_environment()
            initialization = Path(remote_environment['XDG_CONFIG_HOME'])/'nvim/init.lua'
            initialization.parent.mkdir(parents=True, exist_ok=True)
            initialization.write_text('dofile(vim.env.HARNESS_REPO .. "/tests/nvim/interactive_init.lua")\n')
            remote = self.root/"remote harness's entry"
            remote.write_text('#!/usr/bin/python3\nimport json,os,sys\nos.environ.update(' +
                              repr(remote_environment) + ')\nos.execv(' + repr(str(BINARY)) + ',[' +
                              repr(str(BINARY)) + ',"--config",' + repr(str(self.config)) + ']+sys.argv[1:])\n')
            remote.chmod(0o700)
            local = self.root/'local-bin'; local.mkdir()
            for name in ('node', 'nvim'):
                denied = local/name
                denied.write_text('#!/bin/sh\nprintf unexpected-local-runtime >> ' +
                                  shlex.quote(str(self.root/'local-runtime.log')) + '\nexit 99\n')
                denied.chmod(0o700)
            self.env.update(PATH=str(local)+':'+str(network.bin)+':'+self.env['PATH'], TMPDIR=str(evidence))
            if self.plain:
                command = ['ssh', '-o', 'ClearAllForwardings=yes', '-tt', 'harness-test',
                           'cd -- ' + shlex.quote(str(self.root)) + ' && exec ' + shlex.quote(str(remote)) + ' nvim']
            else:
                command = [str(BINARY), 'ssh', '--host', 'harness-test', '--workspace', str(self.root),
                           '--remote-command', str(remote)]
            super().launch(self.env, command)

    observations = []
    with desktop() as display:
        try:
            editor = SshEditor('gui', display)
            browser = editor.browser
            editor.keys('i\\model openai/gpt-5.6-luna\r')
            editor.wait(lambda: editor.snapshot()['session']['model'] == 'gpt-5.6-luna', 'Select the test model')
            editor.keys('Unsent SSH task.')
            editor.mark('Start ChatGPT sign-in in remote Neovim. The local Firefox window opens automatically.')
            login(editor, 'openai', 'Sign in with ChatGPT')
            editor.wait(lambda: browser.find('Harness test account 1'), 'Local Firefox opens automatically', timeout=25)
            assert len(browser.attempts) == 1
            attempt = browser.attempts[0]
            assert editor.browser_urls() == [attempt['url']]
            server_pid = struct.unpack('3i', editor.rpc.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
            children = Path(f'/proc/{server_pid}/task/{server_pid}/children').read_text().split()
            worker_pid = next(pid for pid in children if b'worker.mjs' in Path('/proc', pid, 'cmdline').read_bytes())
            pids = {'server': server_pid, 'worker': worker_pid, 'neovim': editor.observe('vim.fn.getpid()'),
                    'browser': attempt['pid'], 'local_terminal': editor.process.pid}
            namespaces = {name: os.readlink(f'/proc/{pid}/ns/net') for name, pid in pids.items()}
            assert namespaces['browser'] == namespaces['local_terminal'] == os.readlink('/proc/self/ns/net')
            assert namespaces['server'] == namespaces['worker'] == namespaces['neovim'] != namespaces['browser']
            assert editor.observe('vim.env.SSH_CONNECTION ~= nil and vim.env.HARNESS_BROWSER_SOCKET ~= nil')
            assert not available(1455), 'The local callback must be forwarded before the browser opens'
            editor.screenshot('remote-login')
            browser.screenshot('local-browser')
            editor.mark('Cancel sign-in in Neovim. The callback closes and the unsent draft remains.')
            browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
            editor.keys('\x03')
            editor.wait(lambda: not any(window['name'] == 'harness://setup' for window in editor.windows()),
                        'Cancel remote login')
            wait(lambda: available(1455), 'Cancelled remote login left a callback forward')
            assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)') == ['Unsent SSH task.']
            assert next(item for item in editor.rpc.request('configuration.get')['providers']
                        if item['id'] == 'openai')['credential_type'] == 'api_key'
            login(editor, 'openai', 'Sign in with ChatGPT')
            editor.wait(lambda: browser.find('Harness test account 2'), 'Fresh login opens automatically', timeout=25)
            cancelled_url, attempt = attempt['url'], browser.attempts[1]
            assert cancelled_url != attempt['url']
            editor.mark('Click Open browser in Neovim. The same full link opens locally and keeps its callback.')
            click_terminal_link(editor)
            editor.wait(lambda: browser.find('Harness test account 3'), 'Mouse retry opens the same complete URL', timeout=25)
            assert editor.browser_urls() == [cancelled_url, attempt['url'], attempt['url']]
            assert browser.attempts[2]['callback'] == attempt['callback']
            assert all(os.readlink(f'/proc/{entry["pid"]}/ns/net') == namespaces['browser'] for entry in browser.attempts)
            assert not available(1455), 'Browser retry released its callback'
            editor.mark('Continue in Firefox. The local callback travels through SSH to Pi. No URL is copied or pasted.')
            window = browser.find('Harness test account 3')
            browser.approve(window)
            editor.wait(lambda: 'Authentication successful' in browser.title(window), 'Actual Pi callback through SSH', timeout=15)
            editor.wait(lambda: not any(window['name'] == 'harness://setup' for window in editor.windows()),
                        'Remote Neovim finishes sign-in')
            assert next(item for item in editor.rpc.request('configuration.get')['providers']
                        if item['id'] == 'openai')['credential_type'] == 'oauth'
            assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)') == ['Unsent SSH task.']
            wait(lambda: available(1455), 'Completed login did not release the local callback')
            editor.mark('Return to the same chat and send the retained prompt with Enter.')
            browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
            editor.keys('\r')
            editor.wait(lambda: editor.snapshot()['state'] == 'idle'
                        and editor.snapshot()['assistant']['text'] == 'OpenAI streamed λ 世界 and completed the task.',
                        'Remote authenticated task completes', timeout=15)
            generations = [json.loads(line) for line in (editor.root/'generation-requests.jsonl').read_text().splitlines()]
            assert len(generations) == 1 and generations[0]['credential_kind'] == 'oauth'
            assert generations[0]['model'] == 'gpt-5.6-luna'
            assert not (editor.root/'local-runtime.log').exists(), 'The local launcher used Node or Neovim'
            assert not (editor.root/'remote-browser.log').exists(), 'Sign-in opened a browser on the remote host'
            editor.screenshot('remote-chat-complete')
            observations.append({'case': 'actual-ssh-nvim-pi-firefox', 'separate_loopbacks': True,
                                 'full_url': True, 'automatic_local_browser': True, 'pasted_callback': False,
                                 'native_mouse_retry': True, 'cancel_released_callback_and_kept_draft': True,
                                 'callback_released': True,
                                 'generation_credentials': 'synthetic OAuth', 'generation_model': 'gpt-5.6-luna',
                                 'exact_answer': editor.snapshot()['assistant']['text'],
                                 'network_namespaces': namespaces, 'steps': editor.steps})
            (editor.root/'observed.json').write_text(json.dumps(observations[-1], indent=2)+'\n')
            editor.finish()

            plain = SshEditor('plain', display, plain=True)
            plain.keys('iUnsent plain SSH task.')
            login(plain, 'openai', 'Sign in with ChatGPT')
            plain.wait(lambda: any('harness ssh' in ''.join(window['lines']) for window in plain.windows()),
                       'Plain SSH shows the local launcher command')
            assert not plain.browser.attempts and not plain.browser_urls()
            assert not (plain.root/'remote-browser.log').exists()
            assert available(1455), 'Plain SSH must not create a local callback forward'
            plain.keys('\x03')
            plain.wait(lambda: not any(window['name'] == 'harness://setup' for window in plain.windows()),
                       'Cancel plain SSH sign-in')
            assert plain.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)') == ['Unsent plain SSH task.']
            observations.append({'case': 'plain-ssh', 'local_launcher_remedy': True, 'remote_browser_opened': False})
            plain.finish()
        finally:
            for editor in GuiEditor.instances: editor.abort()
    return observations


def native_editor(evidence, environment):
    executable = shutil.which('nvim')
    assert executable, 'The SSH GUI test requires Neovim on the test remote machine'
    with open(executable, 'rb') as source:
        source.seek(8)
        appimage = source.read(3) == b'AI\x02'
    if appimage:
        directory = evidence/'native'; directory.mkdir()
        subprocess.run([executable, '--appimage-extract'], cwd=directory, check=True,
                       stdout=subprocess.DEVNULL, timeout=60)
        environment['PATH'] = str(directory/'squashfs-root/usr/bin')+':'+environment['PATH']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--component-only', action='store_true')
    arguments = parser.parse_args()
    evidence = (arguments.evidence or Path(tempfile.mkdtemp(prefix='hs-'))).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if not os.environ.get('HARNESS_SSH_TEST_NAMESPACE'):
        environment = dict(os.environ, HARNESS_SSH_TEST_NAMESPACE='1')
        if not arguments.component_only: native_editor(evidence, environment)
        command = ['unshare', '--map-root-user', '--map-auto', '--mount', '--net', sys.executable,
                   str(Path(__file__).resolve()), '--evidence', str(evidence)]
        if arguments.component_only: command.append('--component-only')
        return subprocess.call(command, env=environment)
    run('ip', 'link', 'set', 'lo', 'up')
    run('mount', '-t', 'devpts', 'devpts', '/dev/pts', '-o', 'newinstance,ptmxmode=0666,mode=0620,gid=5')
    private = evidence/'system'; private.mkdir()
    (private/'empty').mkdir()
    for destination in ('/usr/share/empty.sshd', '/var/empty', '/run/sshd'):
        if Path(destination).is_dir(): run('mount', '--bind', str(private/'empty'), destination)
    (private/'shadow').write_text('root:x:20000:0:99999:7:::\n')
    run('mount', '--bind', str(private/'shadow'), '/etc/shadow')
    (private/'home').mkdir()
    run('mount', '--bind', str(private/'home'), '/root')
    network = Network(evidence/'network')
    try:
        result = {'components': components(network, evidence)}
        if not arguments.component_only: result['gui'] = gui(network, evidence)
        (evidence/'observed.json').write_text(json.dumps(result, indent=2)+'\n')
        print('SSH integration evidence:', evidence)
    finally: network.close()
    return 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--peer']: remote_peer()
    else: sys.exit(main())
