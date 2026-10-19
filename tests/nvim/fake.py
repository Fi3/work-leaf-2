#!/usr/bin/env python3
"""Protocol fixture process for editor tests. It is not an application client."""
import json
import os
import sys
import time
from pathlib import Path

state_path = Path(os.environ['HARNESS_TEST_STATE'])
fixture = json.loads((Path(__file__).parents[1] / 'fixtures/protocol.json').read_text())

def load():
    return json.loads(state_path.read_text()) if state_path.exists() else {'sessions': {}, 'calls': [], 'receipts': {}}

def save(state):
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(state_path)

def snapshot(session):
    result = json.loads(json.dumps(fixture['snapshot']))
    result['session'] = session['metadata']
    result['state'] = session.get('state', 'idle')
    result['active_submission_id'] = session.get('active')
    result['entries'] = session.get('entries', result['entries'])
    result['tools'] = session.get('tools', [])
    result['assistant'] = session.get('assistant', result['assistant'])
    result['history_cursor'] = session.get('cursor')
    return result

def configuration(state, session=None):
    selected = session['metadata'] if session else state.get('configuration', {'provider': 'faux', 'model': 'test'})
    provider, model = selected.get('provider'), selected.get('model')
    issue = 'missing_model' if not provider or not model else 'missing_key' if provider == 'anthropic' and not state.get('authenticated', False) else None
    return {'provider': provider, 'model': model, 'ready': issue is None, 'issue': issue,
            'message': 'Choose a model with \\model.' if issue == 'missing_model' else 'Use \\login to enter a key.' if issue else 'Ready.',
            'models': [{'id': 'hosted', 'name': 'Hosted model'}]}

def emit(value):
    line = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    # Vary byte boundaries, including boundaries within Unicode characters.
    for start in range(0, len(line), 13):
        os.write(1, line[start:start + 13])

state = load()
if sys.argv[-1] == 'start':
    time.sleep(float(os.environ.get('HARNESS_TEST_START_DELAY', '0')))
    state['starts'] = state.get('starts', 0) + 1
    save(state)
    sys.exit(0)
if sys.argv[-1] in ('setup', 'auth'):
    state['auth_calls'] = state.get('auth_calls', 0) + 1
    save(state)
    print('Test credential: success, failure, or q to cancel:', flush=True)
    choice = input()
    if choice == 'q': sys.exit(130)
    if choice == 'failure':
        print('Cannot update server credentials.', flush=True)
        sys.exit(2)
    state = load()
    state['authenticated'] = True
    save(state)
    sys.exit(0)

watches = {}
deferred = []
sequence = 0
for line in sys.stdin:
    request = json.loads(line)
    state = load()
    method, params = request['method'], request.get('params', {})
    state['calls'].append(request)
    result = {}
    failure = None
    session = state['sessions'].get(params.get('session_id'))
    if method == 'system.hello':
        result = {'api_version': 1}
    elif method == 'configuration.get':
        result = configuration(state, session)
    elif method == 'session.create':
        time.sleep(state.get('create_delay', 0))
        parent = state['sessions'].get(params.get('parent_session_id'))
        settings = parent['metadata'] if parent else state.get('configuration', {'provider': 'faux', 'model': 'test'})
        metadata = dict(fixture['snapshot']['session'], session_id=params['session_id'], name=params.get('name', params['session_id']), parent_session_id=params.get('parent_session_id'), workspace=os.path.realpath(params['workspace']))
        metadata.update(provider=settings.get('provider'), model=settings.get('model'), instructions=settings.get('instructions', ''))
        session = state['sessions'].setdefault(params['session_id'], {'metadata': metadata})
        result = session['metadata']
    elif method == 'session.configure':
        if session.get('active'):
            failure = {'code': -32000, 'message': 'Session has active work', 'data': {'kind': 'busy'}}
        elif 'model' in params and (params['provider'], params['model']) not in (('faux', 'test'), ('anthropic', 'hosted')):
            failure = {'code': -32602, 'message': 'Choose a model from the available catalog'}
        else:
            session['metadata'].update({key: value for key, value in params.items() if key in ('provider', 'model', 'instructions', 'name')})
            result = session['metadata']
    elif method == 'session.list':
        result = {'items': [s['metadata'] for s in state['sessions'].values() if 'workspace' not in params or s['metadata']['workspace'] == os.path.realpath(params['workspace'])], 'next_cursor': None}
    elif method in ('session.get', 'session.watch'):
        if not session:
            failure = {'code': -32000, 'message': 'Unknown session', 'data': {'kind': 'not_found'}}
        elif method == 'session.get':
            result = {'session': session['metadata'], 'snapshot': snapshot(session)}
        else:
            watch = 'watch-' + request['id']
            watches[watch] = params['session_id']
            result = {'watch_id': watch, 'snapshot': snapshot(session)}
    elif method == 'session.unwatch':
        watches.pop(params['watch_id'], None)
    elif method == 'input.submit':
        key = params['session_id'] + ':' + params['request_id']
        if key not in state['receipts']:
            state['receipts'][key] = {'session_id': params['session_id'], 'request_id': params['request_id'], 'submission_id': 'submission-' + str(len(state['receipts'])), 'status': 'accepted'}
            session['active'] = state['receipts'][key]['submission_id']
            session['state'] = 'running'
            session['entries'] = [{'entry_id': 'user-' + params['request_id'], 'kind': 'user', 'text': params['text'], 'truncated': False}]
            session['assistant'] = {'text': 'Streaming λ 世界', 'truncated': False}
            session['tools'] = [{'name': 'bash', 'status': 'running', 'text': 'tool progress', 'truncated': False}]
            if params['text'] == 'drop':
                save(state)
                sys.exit(3)
            if params['text'] == 'not-ready-after-admission':
                failure = {'code': -32000, 'message': 'Worker unavailable after admission', 'data': {'kind': 'not_ready'}}
        result = state['receipts'][key]
    elif method == 'run.stop':
        if state.get('fail_stop'):
            save(state)
            sys.exit(3)
        result = {'session_id': params['session_id'], 'request_id': 'task', 'submission_id': params['submission_id'], 'status': 'unanswered', 'reason': 'cancelled', 'message': 'Run cancelled'}
        if session.get('active') == params['submission_id']:
            session.update(state='idle', active=None, tools=[])
    elif method == 'transcript.list':
        result = state.get('history_pages', {}).get(params.get('cursor'), {'items': [{'entry_id': 'old', 'kind': 'user', 'text': 'Older entry', 'truncated': False}], 'next_cursor': None})
    save(state)
    response = {'jsonrpc': '2.0', 'id': request['id']}
    response['error' if failure else 'result'] = failure or result
    if method == 'input.submit' and params['text'].startswith('deferred-receipt'):
        deferred.append(response)
    else:
        emit(response)
    if method == 'session.watch':
        for receipt in deferred: emit(receipt)
        deferred.clear()
    if method in ('input.submit', 'run.stop', 'session.configure'):
        for watch, session_id in watches.items():
            sequence += 1
            emit({'jsonrpc': '2.0', 'method': 'session.state', 'params': {'watch_id': watch, 'sequence': sequence, 'snapshot': snapshot(state['sessions'][session_id])}})
