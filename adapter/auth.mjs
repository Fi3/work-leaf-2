import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { ReadStream, WriteStream, isatty } from 'node:tty';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { appError, invalid, RpcError } from './protocol.mjs';

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

function terminal(path) {
  if (!/^\/dev\/pts\/[0-9]+$/.test(path)) throw invalid('Login requires a private terminal');
  const descriptors = [];
  try {
    for (let i = 0; i < 2; i++) {
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NOCTTY);
      descriptors.push(fd);
      const info = fstatSync(fd);
      if (!info.isCharacterDevice() || info.uid !== process.getuid() || !isatty(fd)) throw Error();
    }
    const input = new ReadStream(descriptors[0]), output = new WriteStream(descriptors[1]);
    return { input, output };
  } catch {
    for (const fd of descriptors) { try { closeSync(fd); } catch {} }
    throw invalid('Cannot open the private login terminal');
  }
}

function loginUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || /[\u0000-\u0020\u007f-\u009f]/.test(value)) throw invalid('Login link is not a valid web address');
  let url; try { url = new URL(value); } catch { throw invalid('Login link is not a valid web address'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('Login link is not a valid web address');
  return value;
}
function openBrowser(url, report, explicit = false) {
  if (!explicit && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.BROWSER) return;
  const browser = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  const failed = () => report('Cannot open a browser here. Press Ctrl-X to copy the link.');
  browser.on('error', failed);
  browser.on('exit', code => { if (code !== 0) failed(); });
  browser.unref();
}

export async function terminalLogin(models, params, controller, deviceId) {
  const provider = models.getProvider(params.provider);
  const method = params.method === 'oauth' ? provider?.auth.oauth : provider?.auth.apiKey;
  if (!method?.login) throw invalid('This provider does not support the selected login method');
  const { input, output } = terminal(params.terminal);
  let hidden = true, link, deviceCode, activeReader;
  const display = new Writable({ write(value, encoding, done) {
    if (!hidden && output.writableLength <= 65536) output.write(value, encoding);
    done();
  } });
  display.columns = output.columns;
  const cancel = () => controller.abort(new Error('Login cancelled'));
  const setRawMode = input.setRawMode.bind(input);
  input.setRawMode = value => {
    try { return setRawMode(value); }
    catch (error) {
      if (error.code !== 'EIO') throw error;
      // Node readline also changes raw mode on EOF, after a closed PTY rejects the ioctl.
      cancel(); return input;
    }
  };
  emitKeypressEvents(input);
  input.on('keypress', (_, key) => {
    if (key?.name === 'escape' || (key?.ctrl && ['c', 'z'].includes(key.name))) cancel();
    else if (key?.ctrl && key.name === 'x') {
      if (link) copy(link); else status('No browser link is available for this step.');
    } else if (key?.ctrl && key.name === 'o') {
      if (link) openBrowser(link, status, true); else status('No browser link is available for this step.');
    } else if (key?.ctrl && key.name === 'y' && deviceCode) {
      key.name = undefined; // Do not also paste readline's removed text into a hidden prompt.
      copy(deviceCode);
    }
  });
  input.on('error', cancel); output.on('error', cancel);
  input.on('end', cancel);
  input.setRawMode(true); input.resume();
  const write = value => {
    if (output.destroyed || output.writableEnded) return;
    if (output.writableLength > 65536) { cancel(); return; }
    output.write(value);
  };
  const status = text => {
    write(`\r\n${text}\r\n`);
    if (activeReader) {
      if (hidden) write(activeReader.getPrompt());
      else activeReader.prompt(true);
    }
  };
  const copy = value => {
    write(`\x1b]52;c;${Buffer.from(value).toString('base64')}\x1b\\`);
    status('Clipboard copy requested. If paste fails, select the link or code above.');
  };
  const showLink = value => {
    link = loginUrl(value);
    write(`\r\nOpen this link in your browser:\r\n\x1b]8;id=harness-login;${link}\x1b\\${link}\x1b]8;;\x1b\\\r\nCtrl-X: copy link. Ctrl-O: open browser.\r\n`);
    openBrowser(link, status);
  };
  const question = async (message, secret, signal) => {
    controller.signal.throwIfAborted();
    // Fresh native editing state prevents secret text from crossing prompts through history or Ctrl-Y.
    const reader = createInterface({ input, output: display, terminal: true, historySize: 0 });
    activeReader = reader;
    reader.on('SIGINT', cancel); reader.on('SIGTSTP', cancel); reader.on('close', cancel);
    const limit = () => { if (Buffer.byteLength(reader.line) > 65536) cancel(); };
    input.on('data', limit);
    hidden = false;
    const answer = reader.question(message, { signal });
    hidden = secret;
    try {
      const value = await answer;
      if (Buffer.byteLength(value) > 65536) throw invalid('Login input exceeds 64 KiB');
      return value;
    }
    finally {
      hidden = true;
      activeReader = null;
      reader.removeListener('close', cancel); reader.close(); input.removeListener('data', limit);
      if (!input.destroyed) { input.setRawMode(true); input.resume(); }
      if (secret) write('\r\n');
    }
  };
  write(`\r\n${provider.name}: ${method.loginLabel ?? method.name}\r\nEscape or Ctrl-C cancels. Secret input is hidden.\r\n`);
  try {
    await models.login(provider.id, params.method, {
      signal: controller.signal,
      prompt: async prompt => {
        const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
        if (prompt.type === 'select') {
          write(`\r\n${prompt.message}\r\n`);
          for (const [index, item] of prompt.options.entries()) write(`  ${index + 1}. ${item.label}${item.description ? ` — ${item.description}` : ''}\r\n`);
          while (true) {
            const value = (await question(`Choice [1-${prompt.options.length}, Enter=1]: `, false, signal)).trim();
            const index = value === '' ? 0 : Number(value) - 1;
            if (Number.isInteger(index) && prompt.options[index]) return prompt.options[index].id;
            write('Enter a listed number, or press Escape to cancel.\r\n');
          }
        }
        const secret = prompt.type === 'secret' || prompt.type === 'manual_code';
        const value = await question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `, secret, signal);
        if (prompt.type === 'secret' && value === '') { cancel(); controller.signal.throwIfAborted(); }
        if (prompt.type === 'secret' && (!value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value))) throw invalid('Credentials must contain text without control characters');
        return value;
      },
      notify: event => {
        if (event.type === 'auth_url') {
          deviceCode = undefined;
          showLink(event.url);
          write(`${event.instructions ?? ''}\r\n`);
        } else if (event.type === 'device_code') {
          if (typeof event.userCode !== 'string' || !event.userCode || Buffer.byteLength(event.userCode) > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(event.userCode)) throw invalid('Device login code is invalid');
          deviceCode = event.userCode;
          showLink(event.verificationUri);
          write(`Enter code: \x1b]8;id=harness-code-${Buffer.from(deviceCode).toString('base64')};${link}\x1b\\${deviceCode}\x1b]8;;\x1b\\\r\nCtrl-Y: copy device code.\r\n`);
        } else {
          write(`\r\n${event.message}\r\n`);
          for (const link of event.links ?? []) write(`${link.label ?? 'More information'}: ${loginUrl(link.url)}\r\n`);
        }
      },
    }, { getDeviceId: () => deviceId, agentName: 'harness' });
    write('\r\nLogin saved. No model request was made.\r\n');
    try {
      const updated = await models.refresh({ providers: [provider.id], signal: controller.signal });
      if (updated.errors.size) throw Error();
    } catch {
      write('\r\nThe account is saved, but the model list could not update. Retry login later to update the list.\r\n');
    }
    return false;
  } catch (error) {
    if (controller.signal.aborted) { write('\r\nLogin cancelled. Previous credentials are unchanged.\r\n'); return true; }
    if (error instanceof RpcError) throw error;
    // Provider errors can contain raw token responses. Do not copy them into the terminal or RPC.
    write('\r\nLogin failed. Check the account, network, and any other open login, then try again.\r\n');
    throw appError('provider_error', 'Login failed. Check the account, network, and any other open login, then try again');
  } finally {
    try { input.setRawMode(false); } catch {}
    input.destroy(); display.end();
    output.end(() => output.destroy());
  }
}
