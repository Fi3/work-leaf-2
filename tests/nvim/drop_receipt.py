#!/usr/bin/env python3
"""Drop one real client receipt to test an uncertain editor submission."""
import json
import os
import subprocess
import sys
from pathlib import Path

binary = os.environ['HARNESS_REAL_EXECUTABLE']
marker = Path(os.environ['HARNESS_DROPPED_RECEIPT'])
arguments = [binary, *sys.argv[1:]]
if sys.argv[-1] != 'rpc' or marker.exists():
    os.execv(binary, arguments)
process = subprocess.Popen(arguments, stdin=sys.stdin, stdout=subprocess.PIPE, stderr=sys.stderr)
for line in process.stdout:
    record = json.loads(line)
    result = record.get('result', {})
    if 'submission_id' in result and 'request_id' in result:
        marker.write_text(json.dumps(result))
        process.terminate()
        process.wait(timeout=5)
        sys.exit(3)
    os.write(1, line)
sys.exit(process.wait())
