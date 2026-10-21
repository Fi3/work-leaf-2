import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { ReadStream, WriteStream, isatty } from 'node:tty';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { invalid } from './protocol.mjs';

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
    return { input: new ReadStream(descriptors[0]), output: new WriteStream(descriptors[1]) };
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

function openBrowser(url, report) {
  const browser = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  const failed = () => report('Cannot open a browser here. Press Ctrl-X to copy the link.');
  browser.on('error', failed);
  browser.on('exit', code => { if (code !== 0) failed(); });
  browser.unref();
}

class LoginTerminal {
  constructor(path, controller, remote) {
    Object.assign(this, terminal(path), { controller, remote, hidden: true });
    this.cancel = () => controller.abort(new Error('Login cancelled'));
    this.display = new Writable({ write: (value, encoding, done) => {
      if (!this.hidden && this.output.writableLength <= 65536) this.output.write(value, encoding);
      done();
    } });
    this.display.columns = this.output.columns;
    const setRawMode = this.input.setRawMode.bind(this.input);
    this.input.setRawMode = value => {
      try { return setRawMode(value); }
      catch (error) {
        if (error.code !== 'EIO') throw error;
        // Readline changes raw mode on EOF, after a closed PTY rejects the ioctl.
        this.cancel(); return this.input;
      }
    };
    emitKeypressEvents(this.input);
    this.input.on('keypress', (_, key) => this.keypress(key));
    this.input.on('error', this.cancel); this.output.on('error', this.cancel);
    this.input.on('end', this.cancel);
    this.input.setRawMode(true); this.input.resume();
  }
  keypress(key) {
    if (key?.name === 'escape' || (key?.ctrl && ['c', 'z'].includes(key.name))) this.cancel();
    else if (key?.ctrl && ['x', 'o'].includes(key.name)) {
      if (!this.link) this.status('No browser link is available for this step.');
      else if (key.name === 'x' || this.remote) this.copy(this.link);
      else openBrowser(this.link, text => this.status(text));
    } else if (key?.ctrl && key.name === 'l') {
      key.name = undefined; // Keep readline from clearing the link and the private prompt.
      this.status(this.link ? `Complete login link:\r\n${this.link}` : 'No browser link is available for this step.');
    } else if (key?.ctrl && key.name === 'y' && this.deviceCode) {
      key.name = undefined; // Do not paste readline's removed text into a hidden prompt.
      this.copy(this.deviceCode);
    }
  }
  write(value) {
    if (this.output.destroyed || this.output.writableEnded) return;
    if (this.output.writableLength > 65536) { this.cancel(); return; }
    this.output.write(value);
  }
  status(text) {
    this.write(`\r\n${text}\r\n`);
    if (this.activeReader) {
      if (this.hidden) this.write(this.activeReader.getPrompt());
      else this.activeReader.prompt(true);
    }
  }
  copy(value) {
    this.write(`\x1b]52;c;${Buffer.from(value).toString('base64')}\x1b\\`);
    this.status('Clipboard copy requested. Ctrl-L shows the complete link.');
  }
  showLink(value) {
    this.link = loginUrl(value); this.deviceCode = undefined;
    this.write(`\r\n${this.remote ? 'SSH: copy this link to your local browser.' : 'Continue in your browser:'}\r\n\x1b]8;id=harness-login;${this.link}\x1b\\[ ${this.remote ? 'Copy link' : 'Open browser'} ]\x1b]8;;\x1b\\\r\n${this.remote ? 'Ctrl-X or Ctrl-O: copy link. Ctrl-L: show link.' : 'Ctrl-O: open browser. Ctrl-X: copy link. Ctrl-L: show link.'}\r\n`);
  }
  showDeviceCode(url, code) {
    if (typeof code !== 'string' || !code || Buffer.byteLength(code) > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(code)) throw invalid('Device login code is invalid');
    this.showLink(url); this.deviceCode = code;
    this.write(`Enter code: \x1b]8;id=harness-code-${Buffer.from(code).toString('base64')};${this.link}\x1b\\${code}\x1b]8;;\x1b\\\r\nCtrl-Y: copy device code.\r\n`);
  }
  showInformation(event) {
    this.write(`\r\n${event.message}\r\n`);
    for (const link of event.links ?? []) this.write(`${link.label ?? 'More information'}: ${loginUrl(link.url)}\r\n`);
  }
  async question(message, secret, signal) {
    this.controller.signal.throwIfAborted();
    // Fresh editing state prevents secret text from crossing prompts through history or Ctrl-Y.
    const reader = createInterface({ input: this.input, output: this.display, terminal: true, historySize: 0 });
    this.activeReader = reader;
    reader.on('SIGINT', this.cancel); reader.on('SIGTSTP', this.cancel); reader.on('close', this.cancel);
    const limit = () => { if (Buffer.byteLength(reader.line) > 65536) this.cancel(); };
    this.input.on('data', limit);
    this.hidden = false;
    const answer = reader.question(message, { signal });
    this.hidden = secret;
    try {
      const value = await answer;
      if (Buffer.byteLength(value) > 65536) throw invalid('Login input exceeds 64 KiB');
      return value;
    } finally {
      this.hidden = true; this.activeReader = null;
      reader.removeListener('close', this.cancel); reader.close(); this.input.removeListener('data', limit);
      if (!this.input.destroyed) { this.input.setRawMode(true); this.input.resume(); }
      if (secret) this.write('\r\n');
    }
  }
  close() {
    try { this.input.setRawMode(false); } catch {}
    this.input.destroy(); this.display.end();
    this.output.end(() => this.output.destroy());
  }
}

export const openLoginTerminal = (path, controller, remote) => new LoginTerminal(path, controller, remote);
