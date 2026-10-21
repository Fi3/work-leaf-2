"""Synchronous public protocol client for isolated tests and benchmarks."""
import json
import socket


class Rpc:
    def __init__(self, path, timeout=15):
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(timeout)
        self.socket.connect(str(path))
        self.input = self.socket.makefile('rb')
        self.serial = 0
        self.request('system.hello', {'api_version': 1})

    def request(self, method, params=None):
        self.serial += 1
        identifier = str(self.serial)
        self.socket.sendall((json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params or {}}) + '\n').encode())
        while True:
            line = self.input.readline()
            if not line:
                raise ConnectionError('Server disconnected')
            record = json.loads(line)
            if 'method' in record:
                continue
            assert record['id'] == identifier, record
            assert 'error' not in record, record
            return record['result']

    def close(self):
        self.input.close()
        self.socket.close()
