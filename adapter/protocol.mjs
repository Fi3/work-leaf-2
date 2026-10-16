export const limits = Object.freeze({ record_bytes: 4194304, input_bytes: 1048576, context_items: 16, snapshot_bytes: 524288, recent_items: 50, preview_bytes: 8192, chunk_bytes: 65536, clients: 32, pending_requests: 32, watches: 8, active_sessions: 4, output_bytes: 4194304 });
export class RpcError extends Error {
  constructor(code, message, kind) { super(message); this.code = code; if (kind) this.data = { kind }; }
}
export const invalid = message => new RpcError(-32602, message);
export const appError = (kind, message) => new RpcError(-32000, message, kind);
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields = {
  'system.hello': [['api_version'], []], 'session.create': [['session_id', 'workspace'], []],
  'session.list': [[], ['cursor', 'limit']], 'session.get': [['session_id'], []], 'session.watch': [['session_id'], []],
  'session.unwatch': [['watch_id'], []], 'input.submit': [['session_id', 'request_id', 'text', 'context'], []],
  'submission.get': [['session_id', 'request_id'], []], 'submission.wait': [['session_id', 'request_id'], ['timeout_ms']],
  'run.stop': [['session_id', 'submission_id'], []], 'transcript.list': [['session_id'], ['cursor', 'limit']],
  'entry.read': [['session_id', 'entry_id'], ['offset', 'limit']], 'server.shutdown': [[], []], 'server.restart_worker': [[], []],
  'worker.close': [[], []], 'worker.shutdown': [[], []], 'worker.release': [['request_ids', 'watch_ids'], []],
};
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected an object');
  for (const key of required) if (!(key in value)) throw invalid(`Missing ${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw invalid('Unknown field');
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
export function validate(method, params) {
  if (!Object.hasOwn(fields, method)) throw new RpcError(-32601, 'Unknown method');
  object(params, ...fields[method]);
  for (const key of ['session_id', 'request_id']) if (key in params && !identifier(params[key])) throw invalid(`Invalid ${key}`);
  for (const key of ['submission_id', 'entry_id', 'watch_id', 'cursor', 'workspace']) {
    const value = params[key];
    if (key in params && (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || value.includes('\0'))) throw invalid(`Invalid ${key}`);
  }
  for (const key of ['api_version', 'timeout_ms', 'offset', 'limit']) {
    if (key in params && !integer(params[key], key === 'limit' ? 1 : 0, key === 'limit' ? (method === 'entry.read' ? limits.chunk_bytes : 100) : Number.MAX_SAFE_INTEGER)) throw invalid(`Invalid ${key}`);
  }
  if (method === 'worker.release') {
    for (const key of ['request_ids', 'watch_ids']) if (!Array.isArray(params[key]) || params[key].length > 1024 || params[key].some(id => typeof id !== 'string')) throw invalid(`Invalid ${key}`);
  }
  if (method !== 'input.submit') return;
  if (typeof params.text !== 'string' || !Array.isArray(params.context)) throw invalid('Invalid input text or context');
  if (params.context.length > limits.context_items) throw appError('resource_limit', 'At most 16 attachments are permitted');
  let bytes = Buffer.byteLength(params.text);
  for (const item of params.context) {
    object(item, ['kind', 'path', 'text', 'modified', 'changedtick'], ['start_line', 'end_line']);
    if (!['buffer', 'selection'].includes(item.kind) || typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.includes('\0') || typeof item.text !== 'string' || typeof item.modified !== 'boolean' || !integer(item.changedtick)) throw invalid('Invalid context attachment');
    if (item.kind === 'selection' ? !integer(item.start_line, 1) || !integer(item.end_line, item.start_line) : 'start_line' in item || 'end_line' in item) throw invalid('Invalid context line range');
    bytes += Buffer.byteLength(item.text);
  }
  if (bytes > limits.input_bytes) throw appError('resource_limit', 'Input text exceeds 1 MiB');
}
export function parseRequest(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RpcError(-32700, 'Invalid JSON record'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || typeof value.id !== 'string' || !value.id || Buffer.byteLength(value.id) > 128 || Object.keys(value).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k))) throw new RpcError(-32600, 'Expected one JSON-RPC request with a string id');
  if (!Object.hasOwn(value, 'params')) value.params = {};
  validate(value.method, value.params);
  return value;
}
export function publicError(error) {
  if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
  if (error?.name === 'ConversationBusy') return publicError(appError('busy', 'Session has active work'));
  if (error?.name === 'SessionFailed') return publicError(appError('storage_error', 'Pi storage is unavailable'));
  return publicError(appError('internal_error', 'Operation failed'));
}
