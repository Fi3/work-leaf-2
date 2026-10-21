import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { appError, invalid, RpcError } from './protocol.mjs';
import { openLoginTerminal } from './terminal.mjs';

const AuthDoc = defineDoc({
  kind: 'app.auth', version: 1, scope: 'session',
  initial: () => ({ device_id: randomUUID(), credentials: {}, catalogs: {} }),
});
// Pi providers may include optional properties with undefined values; documents contain JSON.
const jsonValue = value => JSON.parse(JSON.stringify(value));

export class AuthStore {
  constructor() {
    this.chains = new Map();
    this.catalogs = {
      read: async id => (await this.harness.snapshot(AuthDoc, context))?.catalogs[id],
      write: (id, value) => this.harness.commit(async tx => { (await tx.doc(AuthDoc)).catalogs[id] = jsonValue(value); }, context),
      delete: id => this.harness.commit(async tx => { delete (await tx.doc(AuthDoc)).catalogs[id]; }, context),
    };
  }
  async read(id, options) {
    options?.signal?.throwIfAborted();
    return (await this.harness.snapshot(AuthDoc, context))?.credentials[id];
  }
  async list(options) {
    options?.signal?.throwIfAborted();
    return Object.entries((await this.harness.snapshot(AuthDoc, context))?.credentials ?? {})
      .map(([providerId, value]) => ({ providerId, type: value.type }));
  }
  serialized(id, operation, options) {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      options?.signal?.throwIfAborted();
      return operation();
    });
    const tail = next.catch(() => {});
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return next;
  }
  modify(id, change, options) {
    return this.serialized(id, async () => {
      const current = await this.read(id), next = await change(current);
      // A started token refresh must persist its replacement even if its caller disconnects.
      if (next !== undefined) await this.harness.commit(async tx => { (await tx.doc(AuthDoc)).credentials[id] = jsonValue(next); }, context);
      return next ?? current;
    }, options);
  }
  delete(id, options) {
    return this.serialized(id, () => this.harness.commit(async tx => { delete (await tx.doc(AuthDoc)).credentials[id]; }, context), options);
  }
  deviceId() { return this.harness.commit(async tx => (await tx.doc(AuthDoc)).device_id, context); }
  settle() { return Promise.allSettled([...this.chains.values()]); }
}

async function selectLoginOption(ui, prompt, signal, provider, remote) {
  if (remote && provider === 'radius' && prompt.options.some(item => item.id === 'device-code')) {
    ui.write('SSH uses device-code sign-in for Radius. Copy the link and code below.\r\n');
    return 'device-code';
  }
  ui.write(`\r\n${prompt.message}\r\n`);
  for (const [index, item] of prompt.options.entries()) ui.write(`  ${index + 1}. ${item.label}${item.description ? ` — ${item.description}` : ''}\r\n`);
  while (true) {
    const value = (await ui.question(`Choice [1-${prompt.options.length}, Enter=1]: `, false, signal)).trim();
    const index = value === '' ? 0 : Number(value) - 1;
    if (Number.isInteger(index) && prompt.options[index]) return prompt.options[index].id;
    ui.write('Enter a listed number, or press Ctrl-C to cancel.\r\n');
  }
}

async function readLoginValue(ui, prompt, signal, controller, { remote, browserLogin }) {
  const secret = prompt.type === 'secret' || prompt.type === 'manual_code';
  const automatic = browserLogin && prompt.type === 'manual_code';
  const manual = remote && prompt.type === 'manual_code';
  if (manual) ui.write('If the browser cannot connect to localhost or 127.0.0.1,\r\nthis is expected over SSH. Copy the FULL address from its address bar.\r\nPaste it below and press Enter. If a code is shown, paste that code.\r\n');
  const label = automatic ? 'Waiting for browser sign-in. No input is needed here. '
    : `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `;
  while (true) {
    const value = await ui.question(label, secret, signal);
    if (prompt.type === 'manual_code' && !value.trim()) {
      ui.write(automatic ? 'The browser sign-in is still open. Ctrl-C cancels.\r\n'
        : manual ? 'Paste the complete return URL or code. Ctrl-C cancels.\r\n'
          : 'Wait for your browser, or paste the complete code or redirect URL. Ctrl-C cancels.\r\n');
      continue;
    }
    if (prompt.type === 'secret' && value === '') { controller.abort(new Error('Login cancelled')); controller.signal.throwIfAborted(); }
    if (prompt.type === 'secret' && (!value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value))) throw invalid('Credentials must contain text without control characters');
    return value;
  }
}

function notifyLogin(ui, event, { remote, browserLogin }) {
  if (event.type === 'auth_url') {
    ui.showLink(event.url);
    ui.write(`${remote ? 'Sign in with your local browser. Keep this login window open.'
      : browserLogin ? 'Finish sign-in in your browser. This window updates automatically.' : event.instructions ?? ''}\r\n`);
  } else if (event.type === 'device_code') {
    ui.showDeviceCode(event.verificationUri, event.userCode);
    if (remote) ui.write('Enter this code in your local browser. This window updates automatically.\r\nDo not paste the browser address here.\r\n');
  } else ui.showInformation(event);
}

async function refreshCatalog(models, provider, signal, ui) {
  try {
    const updated = await models.refresh({ providers: [provider], signal });
    if (updated.errors.size) throw Error();
  } catch {
    ui.write('\r\nThe account is saved, but the model list could not update. Retry login later to update the list.\r\n');
  }
}

export async function terminalLogin(models, params, controller, deviceId) {
  const provider = models.getProvider(params.provider);
  const method = params.method === 'oauth' ? provider?.auth.oauth : provider?.auth.apiKey;
  if (!method?.login) throw invalid('This provider does not support the selected login method');
  const options = { remote: params.remote === true, browserLogin: params.remote !== true && provider.id === 'openai' && params.method === 'oauth' };
  const ui = openLoginTerminal(params.terminal, controller, options.remote);
  try {
    ui.write(`\r\n${provider.name}: ${method.loginLabel ?? method.name}\r\nCtrl-C cancels. Secret input is hidden.\r\n`);
    await models.login(provider.id, params.method, {
      signal: controller.signal,
      prompt: prompt => {
        const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
        return prompt.type === 'select' ? selectLoginOption(ui, prompt, signal, provider.id, options.remote)
          : readLoginValue(ui, prompt, signal, controller, options);
      },
      notify: event => notifyLogin(ui, event, options),
    }, { getDeviceId: () => deviceId, agentName: 'harness' });
    ui.write('\r\nLogin saved. No model request was made.\r\n');
    await refreshCatalog(models, provider.id, controller.signal, ui);
    return false;
  } catch (error) {
    if (controller.signal.aborted) { ui.write('\r\nLogin cancelled. Previous credentials are unchanged.\r\n'); return true; }
    if (error instanceof RpcError) throw error;
    // Provider errors can contain raw token responses. Do not copy them into the terminal or RPC.
    ui.write('\r\nLogin failed. Check the account, network, and any other open login, then try again.\r\n');
    throw appError('provider_error', 'Login failed. Check the account, network, and any other open login, then try again');
  } finally { ui.close(); }
}
