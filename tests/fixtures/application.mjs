import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openApplication } from '../../adapter/pi.mjs';

function environment(values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = entries => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = String(value);
    }
  };
  apply(values); return () => apply(previous);
}

export async function application(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), options.prefix ?? 'harness-application-'));
  let app, restore = () => {};
  t.after(async () => {
    try { await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
    finally { restore(); }
  });
  const state = join(directory, 'state'), workspace = join(directory, 'work');
  await mkdir(state); await mkdir(workspace);
  const values = {};
  if (options.tokens !== undefined) values.HARNESS_FAUX_TOKENS_PER_SECOND = options.tokens;
  if ('messages' in options) {
    const path = join(directory, 'responses.json');
    if (options.messages) await writeFile(path, JSON.stringify(options.messages));
    values.HARNESS_FAUX_RESPONSES = options.messages ? path : undefined;
  }
  restore = environment(values);
  const config = { state_dir: state, ...options.settings };
  app = await openApplication(config);
  let sequence = 0;
  const call = (method, params = {}) => app.dispatch(method, params, `test_${++sequence}`, () => {});
  return { directory, state, workspace, config, app, call };
}
