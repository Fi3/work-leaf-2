import { realpath, stat, readFile, lstat, chmod } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineDoc, configure, LiveDoc } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { apiRevision, appError, invalid, limits, validate, RpcError } from './protocol.mjs';
import { chunk, cursor, entryPreview, entryText, fitPage, outcome, parseCursor, snapshot } from './view.mjs';

export const SessionDoc = defineDoc({ kind: 'app.session', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({}) });
const toolNames = CodingTools.tools.map(tool => tool.name);
const admission = Symbol('admission');
const terminal = record => record.status === 'done' || record.status === 'unanswered';
const notReady = () => appError('not_ready', 'Pending recovery is blocked; correct configuration and restart the worker');
const metadata = value => ({ parent_session_id: null, name: value.session_id, ...value });
function checkMetadata(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > limits.snapshot_bytes - 16384) throw appError('resource_limit', 'Agent configuration cannot fit in a public snapshot');
}
function instructions(value) {
  return `${value}\n\nTo delegate work, use the existing command client through bash. Create a child with a unique identifier: "$HARNESS_EXECUTABLE" --socket "$HARNESS_SOCKET" session create --id CHILD --workspace "$PWD" --parent "$HARNESS_SESSION_ID". Send its task through standard input with send --session CHILD --request-id TASK --stdin, then use wait --session CHILD --request-id TASK --text with the same executable and socket. Replace CHILD and TASK with your chosen identifiers. Children have separate histories and runs; stopping this run does not stop them. At most four sessions can run at once.`;
}
function piId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== value) throw appError('not_found', 'Unknown stored identifier');
  return id;
}
async function workspace(path) {
  if (!isAbsolute(path)) throw invalid('Workspace must be an absolute directory');
  try { const canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw Error(); return canonical; }
  catch { throw invalid('Workspace must be an existing directory'); }
}
function cancelAfter(milliseconds, cancel) {
  if (milliseconds === undefined) return () => {};
  const started = performance.now(); let timer;
  const arm = () => {
    const remaining = Math.max(0, milliseconds - (performance.now() - started));
    timer = setTimeout(remaining > 2147483647 ? arm : cancel, Math.min(remaining, 2147483647));
  };
  arm(); return () => clearTimeout(timer);
}
async function configuredModels() {
  const models = createModels(); models.setProvider(anthropicProvider());
  const tokens = Number(process.env.HARNESS_FAUX_TOKENS_PER_SECOND ?? 100000);
  const faux = fauxProvider({ models: [{ id: 'test' }], tokensPerSecond: tokens, tokenSize: { min: 1, max: 1 } });
  if (process.env.HARNESS_FAUX_RESPONSES) {
    const messages = JSON.parse(await readFile(process.env.HARNESS_FAUX_RESPONSES, 'utf8'));
    if (!Array.isArray(messages)) throw invalid('Faux response fixture must be an array');
    faux.setResponses(messages);
  } else {
    const respond = () => {
      faux.appendResponses([respond]);
      return fauxAssistantMessage('Demo mode uses fixed replies. It does not use an AI model or change project files.\n\nYou can test prompt input, saved history, and the agent panels. Use \\model to choose an AI model and \\login to load its key. Run `harness setup` to change the startup defaults.');
    };
    faux.setResponses([respond]);
  }
  models.setProvider(faux.provider);
  return models;
}
async function checkDatabase(directory) {
  for (const name of ['agent.sqlite', 'agent.sqlite-wal', 'agent.sqlite-shm']) {
    const path = join(directory, name);
    let info; try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw appError('storage_error', 'Unsafe database owner or symbolic link');
    await chmod(path, 0o600);
  }
}
export async function openApplication(config, storage) {
  await checkDatabase(config.state_dir);
  const app = new Application(config, await configuredModels());
  const registry = createRegistry(); registry.install(CodingTools);
  app.harness = await Harness.open(storage ?? await openNodeSqliteStorage(join(config.state_dir, 'agent.sqlite')), {
    models: app.models, registry, env: target => app.environment(target),
    settings: { compaction: { backgroundTokens: 0 }, progress: { partialIntervalMs: 100, outputIntervalMs: 100 } },
    onReport: () => process.stderr.write('Pi reported an internal failure\n'),
  }, context);
  await checkDatabase(config.state_dir);
  app.harness.subscribeCommits(publication => app.publish(publication));
  await app.restore();
  return app;
}
class Application {
  constructor(config, models) {
    this.config = config; this.models = models; this.sessions = new Map(); this.environments = new Map();
    this.watches = new Map(); this.waits = new Map(); this.stops = new Map(); this.locks = new Map();
    this.pending = new Set(); this.blocked = null; this.closing = false;
  }
  environment({ conversationId, cwd }) {
    if (!this.environments.has(conversationId)) {
      const session = [...this.sessions.values()].find(item => item.conversation.id === conversationId);
      if (!session) throw appError('not_found', 'Unknown session environment');
      this.environments.set(conversationId, new NodeExecutionEnv({ cwd, shellEnv: {
        HARNESS_SESSION_ID: session.metadata.session_id, HARNESS_SOCKET: this.config.socket_path ?? '',
        HARNESS_EXECUTABLE: process.env.HARNESS_EXECUTABLE ?? 'harness',
      } }));
    }
    return this.environments.get(conversationId);
  }
  async restore() {
    let next;
    do {
      const page = await this.harness.commit(tx => tx.scanConversations({}, 100, next), context); next = page.next;
      for (const record of page.items) {
        const stored = await this.harness.snapshot(SessionDoc, record.id, context);
        if (stored?.session_id) this.sessions.set(stored.session_id, { metadata: metadata(stored), conversation: await this.harness.conversation(record.id, context) });
      }
    } while (next);
    const inspection = await this.harness.inspect(context);
    this.recovering = new Set(inspection.submissions.map(record => record.id));
    for (const record of inspection.submissions) {
      const session = [...this.sessions.values()].find(s => s.conversation.id === record.conversationId);
      try { if (!session) throw notReady(); await this.checkConfiguration(session.metadata); }
      catch { this.blocked = 'A pending session cannot restore its fixed configuration'; }
    }
    if (!this.blocked) this.harness.resume();
  }
  async checkConfiguration(metadata) {
    if (metadata.schema_version !== 1 || JSON.stringify(metadata.tools) !== JSON.stringify(toolNames)) throw appError('not_ready', 'Stored agent configuration is unavailable');
    if (await workspace(metadata.workspace) !== metadata.workspace) throw appError('not_ready', 'Stored workspace changed');
    if (!metadata.provider || !metadata.model) throw appError('not_ready', 'Choose a model with \\model before sending a task');
    const model = this.models.getModel(metadata.provider, metadata.model);
    if (!model || !(await this.models.getAuth(model))) throw appError('not_ready', 'The provider or model is not configured');
  }
  hello() {
    return { api_version: 1, api_revision: apiRevision, node_version: process.version, artifacts: { durable: '1.3.0', ai: '1.3.0', chord: '1.3.0' }, ready: !this.blocked && !this.closing, scheduling_enabled: !this.blocked && !this.closing };
  }
  async configuration(params) {
    const current = params.session_id ? this.session(params.session_id).metadata : this.config;
    const provider = current.provider ?? null, model = current.model ?? null;
    const models = this.models.getModels('anthropic').map(({ id, name }) => ({ id, name }));
    const issue = !provider || !model ? 'missing_model' : !this.models.getModel(provider, model) ? 'invalid_model'
      : !(await this.models.checkAuth(provider)) ? 'missing_key' : null;
    const messages = {
      missing_model: 'Choose a model with \\model before sending a task.',
      invalid_model: 'The selected provider or model is unavailable. Use \\model to choose a supported model.',
      missing_key: 'Anthropic credentials are missing from the server environment. Use \\login to set ANTHROPIC_API_KEY.',
    };
    const message = issue ? messages[issue] : provider === 'faux'
      ? 'Demo mode uses fixed replies. It does not use an AI model or change project files.'
      : 'Anthropic credentials are present. The provider has not checked them.';
    return { provider, model, ready: issue === null, issue, message, models };
  }
  session(id) {
    const session = this.sessions.get(id); if (!session) throw appError('not_found', 'Unknown session'); return session;
  }
  publish(publication) {
    const changed = new Set();
    for (const change of publication.changes) {
      changed.add(change.conversationId ?? change.value?.conversationId);
      if (change.type === 'document' && change.record.kind === 'app.session' && change.value) {
        const session = this.sessions.get(change.value.session_id);
        if (session) session.metadata = metadata(change.value);
      }
    }
    // Pi queues viewState delivery before public commit listeners. Read after that delivery.
    for (const state of this.watches.values()) if (changed.has(state.session.conversation.id)) queueMicrotask(state.update);
  }
  async serialized(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const tail = task.catch(() => {});
    this.locks.set(key, tail);
    this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); if (this.locks.get(key) === tail) this.locks.delete(key); }
  }
  assertAdmission() { if (this.closing) throw appError('not_ready', 'Worker is closing'); }
  async create(params) {
    return this.serialized(admission, async () => {
      this.assertAdmission(); const canonical = await workspace(params.workspace);
      const existing = this.sessions.get(params.session_id);
      if (existing) {
        if (existing.metadata.workspace !== canonical) throw appError('conflict', 'Session has a different workspace');
        if ('parent_session_id' in params && existing.metadata.parent_session_id !== params.parent_session_id) throw appError('conflict', 'Session has a different parent');
        return existing.metadata;
      }
      const parent = params.parent_session_id ? this.session(params.parent_session_id) : null;
      if (parent && parent.metadata.workspace !== canonical) throw appError('conflict', 'Parent has a different workspace');
      const latest = [...this.sessions.values()].filter(item => item.metadata.workspace === canonical && item.metadata.provider && item.metadata.model).sort((a, b) => b.conversation.id - a.conversation.id)[0];
      const settings = parent?.metadata ?? latest?.metadata ?? this.config;
      const bound = settings.provider && settings.model;
      const metadata = { session_id: params.session_id, parent_session_id: params.parent_session_id ?? null, name: params.name ?? params.session_id, workspace: canonical, provider: bound ? settings.provider : null, model: bound ? settings.model : null, instructions: settings.instructions ?? '', schema_version: 1, tools: toolNames };
      checkMetadata(metadata);
      const conversation = await this.harness.createConversation({ ownership: { kind: 'ownerless' },
        agent: { ...(bound ? { model: { provider: metadata.provider, modelId: metadata.model } } : {}), instructions: instructions(metadata.instructions), cwd: canonical, extensions: [CodingTools], tools: CodingTools.tools },
        init: async (tx, id) => Object.assign(await tx.doc(SessionDoc, id), metadata),
      }, context);
      this.sessions.set(metadata.session_id, { metadata, conversation }); return metadata;
    });
  }
  async configure(session, params) {
    const id = session.metadata.session_id;
    if (this.stops.has(id)) throw appError('busy', 'Session is stopping');
    return this.serialized(id, () => this.serialized(admission, async () => {
      this.assertAdmission();
      if ((await this.harness.snapshot(LiveDoc, session.conversation.id, context))?.run || this.stops.has(id)) throw appError('busy', 'Session has active work');
      const next = { ...session.metadata };
      for (const key of ['provider', 'model', 'instructions', 'name']) if (key in params) next[key] = params[key];
      if ('model' in params && !this.models.getModel(next.provider, next.model)) throw invalid('Choose a model from the available catalog');
      checkMetadata(next);
      await this.harness.commit(async tx => {
        await configure(tx, session.conversation.id, {
          ...('model' in params ? { model: { provider: next.provider, modelId: next.model } } : {}),
          ...('instructions' in params ? { instructions: instructions(next.instructions) } : {}),
        });
        Object.assign(await tx.doc(SessionDoc, session.conversation.id), next);
      }, context);
      return next;
    }));
  }
  async list(params) {
    const directory = params.workspace ? await workspace(params.workspace) : null;
    const query = directory ? `sessions:${createHash('sha256').update(directory).digest('hex')}` : 'sessions';
    const after = parseCursor(params.cursor, '', query);
    if (after !== undefined && typeof after !== 'string') throw invalid('Invalid session cursor');
    const values = [...this.sessions.values()].map(s => s.metadata).sort((a, b) => a.session_id.localeCompare(b.session_id));
    const remaining = values.filter(item => (!directory || item.workspace === directory) && (after === undefined || item.session_id.localeCompare(after) > 0));
    const items = fitPage(remaining.slice(0, params.limit ?? 50));
    return { items, next_cursor: remaining.length > items.length ? cursor('', query, items.at(-1).session_id) : null };
  }
  render(session, view) { return snapshot(session.metadata, view, { blocked: this.blocked, stopping: this.stops.has(session.metadata.session_id), recovering: this.recovering.has(view.docs['pi.live']?.run?.inputs[0]) }); }
  async get(session) {
    const view = await session.conversation.viewState(context);
    try { const snapshot = this.render(session, view.value); return { session: snapshot.session, snapshot }; } finally { view.dispose(); }
  }
  async watch(session, send) {
    if (this.watches.size >= limits.clients * limits.watches) throw appError('resource_limit', 'Worker watch limit reached');
    const view = await session.conversation.viewState(context), id = randomUUID();
    const state = { view, timer: null, latest: null, sequence: 0, last: 0, session, started: false };
    this.watches.set(id, state);
    const emit = () => {
      state.timer = null;
      if (!this.watches.has(id) || !state.latest) return;
      state.last = Date.now(); const value = state.latest; state.latest = null;
      send({ jsonrpc: '2.0', method: 'session.state', params: { watch_id: id, sequence: ++state.sequence, snapshot: value } });
    };
    state.update = () => {
      if (!this.watches.has(id)) return;
      state.latest = this.render(session, view.value);
      if (!state.started) return;
      if (!state.latest.active_submission_id) { clearTimeout(state.timer); emit(); }
      else if (!state.timer) state.timer = setTimeout(emit, Math.max(0, 100 - (Date.now() - state.last)));
    };
    const initial = this.render(session, view.value);
    // The caller queues the watch response before enabling callback delivery.
    return { result: { watch_id: id, snapshot: initial }, start: () => { state.started = true; state.update(); } };
  }
  async unwatch(id) {
    const state = this.watches.get(id); if (!state) return {};
    this.watches.delete(id); clearTimeout(state.timer); state.view.dispose(); return {};
  }
  lookup(session, requestId) { return this.harness.commit(tx => tx.submissionByRequest(session.conversation.id, requestId), context); }
  async submission(session, requestId) {
    const record = await this.lookup(session, requestId); if (!record) throw appError('not_found', 'Unknown submission'); return record;
  }
  async inputContent(session, params) {
    const blocks = [params.text];
    for (const item of params.context) {
      const path = resolve(session.metadata.workspace, item.path);
      let canonical;
      try { canonical = await realpath(path); }
      catch {
        try {
          const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (info?.isSymbolicLink()) throw Error();
          canonical = join(await realpath(resolve(path, '..')), path.split('/').at(-1));
        } catch { throw invalid('Context path cannot be resolved'); }
      }
      const local = relative(session.metadata.workspace, canonical);
      if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw invalid('Context path is outside the session workspace');
      blocks.push(`Explicit ${item.kind} snapshot: ${item.path}${item.kind === 'selection' ? ` lines ${item.start_line}-${item.end_line}` : ''}. Modified: ${item.modified}. Change counter: ${item.changedtick}. This text can differ from disk. Tools use server files.\n${item.text}`);
    }
    return blocks.join('\n\n');
  }
  async submit(session, params) {
    const known = await this.lookup(session, params.request_id); if (known) return outcome(session.metadata, known);
    if (this.stops.has(params.session_id)) throw appError('busy', 'Session is stopping');
    return this.serialized(params.session_id, () => this.serialized(admission, async () => {
      const duplicate = await this.lookup(session, params.request_id); if (duplicate) return outcome(session.metadata, duplicate);
      this.assertAdmission(); if (this.blocked) throw notReady();
      const live = await this.harness.snapshot(LiveDoc, session.conversation.id, context);
      if (live?.run || this.stops.has(params.session_id)) throw appError('busy', 'Session has active work');
      if ((await this.harness.inspect(context)).submissions.length >= limits.active_sessions) throw appError('resource_limit', 'Four sessions already have active work');
      await this.checkConfiguration(session.metadata);
      const content = await this.inputContent(session, params);
      const submission = await session.conversation.submit({ type: 'input', content, requestId: params.request_id, whenBusy: 'reject' }, context);
      return outcome(session.metadata, await submission.status(context));
    }));
  }
  async wait(session, params, requestId) {
    const record = await this.submission(session, params.request_id);
    if (terminal(record)) return outcome(session.metadata, record);
    if (this.blocked) throw notReady();
    const cancellation = this.waits.get(requestId);
    const clearDeadline = cancelAfter(params.timeout_ms, () => cancellation.cancel(appError('timeout', 'Wait timed out; work may still be active')));
    try { return outcome(session.metadata, await (await this.harness.submission(record.id, context)).wait(cancellation.context)); }
    finally { clearDeadline(); }
  }
  async stop(session, target) {
    const submission = await this.harness.submission(piId(target), context);
    if (!submission) throw appError('not_found', 'Unknown submission');
    const first = await submission.status(context);
    if (first.conversationId !== session.conversation.id) throw appError('not_found', 'Unknown submission');
    if (terminal(first)) return outcome(session.metadata, first);
    if (this.blocked) throw notReady();
    const id = session.metadata.session_id;
    if (this.stops.has(id)) return this.stops.get(id);
    const operation = this.serialized(id, async () => {
      this.assertAdmission(); const record = await submission.status(context);
      if (!terminal(record)) {
        const live = await this.harness.snapshot(LiveDoc, session.conversation.id, context);
        if (!live?.run?.inputs.includes(record.id)) throw appError('conflict', 'Target is not the active submission');
        await session.conversation.abort(context);
      }
      const stored = await submission.status(context);
      if (!terminal(stored)) throw appError('internal_error', 'Stop did not store a terminal outcome');
      return outcome(session.metadata, stored);
    });
    this.stops.set(id, operation);
    try { return await operation; } finally { this.stops.delete(id); }
  }
  async transcript(session, params) {
    const before = parseCursor(params.cursor, session.metadata.session_id, 'transcript');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw invalid('Invalid transcript cursor');
    const page = await session.conversation.entries({ ...(before === undefined ? {} : { maxEntryId: before }) }, params.limit ?? 50, undefined, context);
    const selected = fitPage(page.items.map(entryPreview));
    return { items: [...selected].reverse(), next_cursor: (page.next || selected.length < page.items.length) && selected.length ? cursor(session.metadata.session_id, 'transcript', Number(selected.at(-1).entry_id) - 1) : null };
  }
  async read(session, params) {
    const entry = await this.harness.commit(tx => tx.entry(piId(params.entry_id)), context);
    if (!entry || entry.conversationId !== session.conversation.id) throw appError('not_found', 'Unknown entry');
    const text = entry.kind === 'pi.tool-result' ? `${entry.model?.[0]?.toolName ?? 'tool'}: ${entryText(entry)}` : entryText(entry);
    return chunk(text, params.offset, params.limit);
  }
  async release(params) {
    for (const id of params.request_ids) this.waits.get(id)?.cancel(appError('not_ready', 'Client disconnected'));
    await Promise.all(params.watch_ids.map(id => this.unwatch(id))); return {};
  }
  async close(idleOnly = false) {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    if (idleOnly && (await this.harness.inspect(context)).submissions.length) { this.closing = false; throw appError('busy', 'Active work prevents shutdown'); }
    await Promise.all([...this.watches.keys()].map(id => this.unwatch(id)));
    for (const cancellation of this.waits.values()) cancellation.cancel(appError('not_ready', 'Worker is closing'));
    await this.harness.close(context);
    await Promise.all([...this.environments.values()].map(env => env.cleanup(context)));
    return {};
  }
  async dispatch(method, params, requestId, send) {
    if (method === 'submission.wait') this.waits.set(requestId, withCancel(context));
    try { return await this.operation(method, params, requestId, send); }
    catch (error) {
      if (error instanceof RpcError || error?.name === 'ConversationBusy') throw error;
      try { await this.harness.inspect(context); } catch { throw appError('storage_error', 'Pi storage is unavailable'); }
      throw error;
    } finally { if (method === 'submission.wait') this.waits.delete(requestId); }
  }
  async operation(method, params, requestId, send) {
    validate(method, params);
    if (method === 'system.hello') { if (params.api_version !== 1) throw appError('incompatible_version', 'Use API version 1'); return this.hello(); }
    if (method === 'configuration.get') return this.configuration(params);
    if (method === 'session.create') return this.create(params);
    if (method === 'session.list') return this.list(params);
    if (method === 'session.unwatch') return this.unwatch(params.watch_id);
    if (method === 'worker.release') return this.release(params);
    if (method === 'worker.close' || method === 'worker.shutdown') return this.close(method === 'worker.shutdown');
    const session = this.session(params.session_id);
    switch (method) {
      case 'session.configure': return this.configure(session, params);
      case 'session.get': return this.get(session);
      case 'session.watch': return this.watch(session, send);
      case 'input.submit': return this.submit(session, params);
      case 'submission.get': return outcome(session.metadata, await this.submission(session, params.request_id));
      case 'submission.wait': return this.wait(session, params, requestId);
      case 'run.stop': return this.stop(session, params.submission_id);
      case 'transcript.list': return this.transcript(session, params);
      case 'entry.read': return this.read(session, params);
      default: throw invalid('Operation belongs to the server');
    }
  }
}
