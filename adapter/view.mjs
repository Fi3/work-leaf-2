import { invalid, limits } from './protocol.mjs';
export function preview(text, maximum = limits.preview_bytes) {
  const bytes = Buffer.from(text.slice(0, maximum + 1)); let end = Math.min(bytes.length, maximum);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString(), truncated: end < bytes.length };
}
export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content ?? []).map(item => item.type === 'text' ? item.text : item.type === 'thinking' ? item.thinking : item.type === 'toolCall' ? `${item.name} ${JSON.stringify(item.arguments)}` : '[image]').join('\n');
}
export function providerError(detail) {
  const text = typeof detail === 'string' ? detail : '';
  const status = Number(text.match(/(?:^|error\s*\(|\bHTTP\s+|\bstatus(?: code)?[\s:=]+)([45]\d\d)\b/i)?.[1]);
  if (/subscription_sharing_usage_limit_exceeded/i.test(text)) return 'The ChatGPT shared usage limit was reached. Check ChatGPT Settings > Usage, or use another account with \\login.';
  if (/context_length_exceeded|maximum context length|input is too long/i.test(text)) return 'The model input is too large. Start a new chat or send less context.';
  if (status === 401 || /invalid_api_key|authentication_error|invalid_grant|token[_ ]expired/i.test(text)) return 'The provider rejected the login. Use \\login to connect again.';
  if (status === 404 || /model_not_found|model_not_supported|unsupported_model/i.test(text)) return 'The selected model is not available to this account. Use \\model to choose another model, or \\login to use another account.';
  if (status === 402 || /insufficient_quota|\bbilling(?:\b|_)|\bcredits?\b|quota exceeded|out of budget/i.test(text)) return 'The provider account has no available quota or credit. Check its usage and billing, or use \\login to connect another account.';
  if (status === 403 || /permission_denied|access_denied/i.test(text)) return 'The provider denied access. Check this account and its model permissions, or use \\login to connect another account.';
  if (status === 429 || /rate_limit_exceeded|rate limit|too many requests/i.test(text)) return 'The provider rate limit was reached. Wait, then send the task again.';
  if (status >= 500 || /overloaded_error|server_busy|subscription_sharing_(?:usage|user)_unavailable/i.test(text)) return 'The provider is temporarily unavailable. Wait, then send the task again.';
  if (/connection error|connection refused|fetch failed|network error|ENOTFOUND|ECONNRESET|EAI_AGAIN|timed? out|timeout|stream ended before|ended without/i.test(text)) return 'The provider connection failed. Check the network, then send the task again.';
  if (status === 400 || status === 422 || /invalid_request_error|invalid_request|unsupported_parameter/i.test(text)) return 'The provider rejected the request format. Use \\model to try another model and update Harness.';
  return 'The provider could not complete the run. Try again or use \\model to choose another model.';
}
function emptyFailure(entry) {
  return entry.kind === 'pi.assistant' && !(entry.model ?? []).some(message => messageText(message).trim()) && entry.model?.find(message => message.stopReason === 'error');
}
export function entryText(entry) {
  const failure = emptyFailure(entry);
  return failure ? providerError(failure.errorMessage) : (entry.model ?? []).map(messageText).join('\n');
}
export function entryPreview(entry) {
  const names = { 'pi.user': 'user', 'pi.assistant': 'assistant', 'pi.tool-result': 'tool', 'pi.system': 'system', 'pi.compaction': 'compaction' };
  const text = entry.kind === 'pi.tool-result' ? `${entry.model?.[0]?.toolName ?? 'tool'}: ${entryText(entry)}` : entryText(entry);
  return { entry_id: String(entry.id), kind: emptyFailure(entry) ? 'error' : names[entry.kind] ?? entry.kind, ...preview(text) };
}
export function cursor(session, query, value) { return Buffer.from(JSON.stringify({ session, query, value })).toString('base64url'); }
export function parseCursor(value, session, query) {
  if (value === undefined) return undefined;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url')); } catch { throw invalid('Invalid cursor'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.session !== session || parsed.query !== query) throw invalid('Cursor belongs to another query');
  return parsed.value;
}
export function outcome(metadata, record) {
  const result = { session_id: metadata.session_id, request_id: record.requestId, submission_id: String(record.id), status: ['done', 'unanswered'].includes(record.status) ? record.status : 'accepted' };
  if (record.status === 'done') result.answer_entry_id = String(record.answer);
  if (record.status === 'unanswered') {
    const reasons = { aborted: ['cancelled', 'Run cancelled'], model_error: ['provider_error', providerError(record.detail)], no_model: ['provider_error', 'The stored model is unavailable'] };
    [result.reason, result.message] = reasons[record.reason] ?? ['internal_error', 'The run ended without an answer'];
  }
  return result;
}
export function snapshot(metadata, view, { blocked, stopping, recovering } = {}) {
  const live = view.docs['pi.live'] ?? {};
  const active = live.run?.inputs[0];
  const visible = view.entries.filter(e => e.kind !== 'pi.system');
  const entries = visible.slice(-limits.recent_items).map(entryPreview);
  const current = live.generation?.message ?? [...visible].reverse().find(e => e.kind === 'pi.assistant')?.model?.[0];
  const result = {
    session: metadata, state: blocked ? 'blocked' : active === undefined ? 'idle' : stopping ? 'stopping' : recovering ? 'recovering' : 'running',
    active_submission_id: active === undefined ? null : String(active), assistant: preview(messageText(current)),
    tools: (live.tools ?? []).map(tool => ({ name: tool.name, status: tool.status, ...preview(tool.output ?? ''), ...(tool.droppedBytes ? { truncated: true } : {}) })),
    entries, history_cursor: null, truncated: false,
    activity: live.compactions?.length ? { compaction: live.compactions.map(c => ({ reason: c.reason, attempt: c.attempt })) } : live.generation?.retry ? { retry: { at: live.generation.retry.at } } : null,
    usage: view.docs['pi.usage'] ?? null, error: blocked ? { kind: 'not_ready', message: blocked } : active === undefined && current?.stopReason === 'error' ? { kind: 'provider_error', message: providerError(current.errorMessage) } : null,
  };
  const omitted = () => visible.length > result.entries.length || view.entries.some(e => e.head !== undefined);
  const update = () => {
    result.history_cursor = omitted() && visible.length ? cursor(metadata.session_id, 'transcript', result.entries.length ? Number(result.entries[0].entry_id) - 1 : visible.at(-1).id) : null;
    result.truncated = omitted() || result.assistant.truncated || result.entries.some(e => e.truncated) || result.tools.some(t => t.truncated);
  };
  update();
  while (Buffer.byteLength(JSON.stringify(result)) > limits.snapshot_bytes) {
    if (result.entries.length) { result.entries.shift(); update(); }
    else if (result.tools.length) { result.tools.pop(); result.truncated = true; }
    else if (result.assistant.text.length) { result.assistant = { ...preview(result.assistant.text, Math.floor(Buffer.byteLength(result.assistant.text) / 2)), truncated: true }; result.truncated = true; }
    else throw invalid('Session metadata exceeds snapshot limit');
  }
  return result;
}
export function chunk(text, offset = 0, limit = limits.chunk_bytes) {
  const bytes = Buffer.from(text);
  if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw invalid('Invalid UTF-8 byte offset');
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === offset && offset < bytes.length) throw invalid('Chunk limit cannot hold the next character');
  return { text: bytes.subarray(offset, end).toString(), next_offset: end, end: end === bytes.length };
}

export function fitPage(items) {
  let bytes = 4096; const result = [];
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > limits.record_bytes) break;
    result.push(item);
  }
  return result;
}
