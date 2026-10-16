import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path));
const json = path => JSON.parse(read(path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function packageFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === 'node_modules') continue;
    const path = join(directory, name), info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), `Unreviewed package symbolic link: ${path}`);
    if (info.isDirectory()) files.push(...packageFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

function fileInventory(directory) {
  const digest = createHash('sha256'); let bytes = 0;
  for (const path of packageFiles(directory)) {
    const data = readFileSync(path); bytes += data.length;
    digest.update(relative(directory, path)).update('\0').update(data).update('\0');
  }
  return { bytes, sha256: digest.digest('hex') };
}

function installedPackages(directory = join(root, 'node_modules'), prefix = 'node_modules') {
  const packages = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const child of readdirSync(join(directory, name)).sort()) packages.push(`${prefix}/${name}/${child}`);
    } else packages.push(`${prefix}/${name}`);
  }
  const nested = [];
  for (const path of packages) {
    assert.ok(!lstatSync(join(root, path)).isSymbolicLink(), `Unreviewed linked package: ${path}`);
    if (readdirSync(join(root, path)).includes('node_modules')) nested.push(...installedPackages(join(root, path, 'node_modules'), `${path}/node_modules`));
  }
  return [...packages, ...nested].sort();
}

function npmInventory() {
  const manifest = json('package.json'), lock = json('package-lock.json');
  const direct = {
    '@earendil-works/chord': '1.3.0',
    '@earendil-works/pi-ai': '1.3.0',
    '@earendil-works/pi-durable': '1.3.0',
  };
  assert.deepEqual(manifest.dependencies, direct, 'Unreviewed JavaScript direct dependencies');
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'workspaces']) {
    assert.ok(!manifest[field] || Object.keys(manifest[field]).length === 0, `Unreviewed package.json ${field}`);
  }
  assert.deepEqual(lock.packages[''].dependencies, direct, 'Manifest and npm lock disagree');
  const paths = Object.keys(lock.packages).filter(Boolean).sort();
  assert.deepEqual(installedPackages(), paths, 'Installed npm tree differs from the lock');
  const packages = paths.map(path => {
    const entry = lock.packages[path], directory = join(root, path);
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
    assert.equal(pkg.version, entry.version, `Installed version differs: ${path}`);
    assert.ok(entry.integrity?.startsWith('sha512-'), `Missing npm integrity: ${path}`);
    const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([name]) => ['preinstall', 'install', 'postinstall'].includes(name)));
    return { path, name: pkg.name, version: pkg.version, integrity: entry.integrity, resolved: entry.resolved,
      license: pkg.license, direct: Object.hasOwn(direct, pkg.name), optional: Boolean(entry.optional), dev: Boolean(entry.dev),
      scripts, ...fileInventory(directory) };
  });
  return { direct, packages };
}

function rustInventory() {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--all-features', '--format-version', '1'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  assert.equal(metadata.workspace_members.length, 1, 'Unreviewed Rust workspace package');
  const application = metadata.packages.find(pkg => pkg.id === metadata.workspace_members[0]);
  const direct = sorted(application.dependencies.map(dependency => ({ name: dependency.name, version: dependency.req,
    features: dependency.features, default_features: dependency.uses_default_features, kind: dependency.kind, optional: dependency.optional, target: dependency.target })));
  const expected = sorted([
    { name: 'serde', version: '=1.0.229', features: ['derive'], default_features: true, kind: null, optional: false, target: null },
    { name: 'serde_json', version: '=1.0.154', features: [], default_features: true, kind: null, optional: false, target: null },
    { name: 'libc', version: '=0.2.190', features: [], default_features: true, kind: null, optional: false, target: null },
  ]);
  assert.deepEqual(direct, expected, 'Unreviewed Rust direct dependencies or features');
  const packages = sorted(metadata.packages.filter(pkg => pkg.id !== application.id).map(pkg => ({
    name: pkg.name, version: pkg.version, source: pkg.source, license: pkg.license,
    features: metadata.resolve.nodes.find(node => node.id === pkg.id).features,
    build_scripts: pkg.targets.filter(target => target.kind.includes('custom-build')).map(target => ({ file: relative(dirname(pkg.manifest_path), target.src_path), sha256: hash(readFileSync(target.src_path)) })),
  })));
  return { direct, features: application.features, packages, lock_sha256: hash(read('Cargo.lock')) };
}

function imports() {
  const external = new Set();
  for (const name of readdirSync(join(root, 'adapter')).filter(name => name.endsWith('.mjs'))) {
    const source = read(`adapter/${name}`).toString();
    assert.ok(!/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source), `Unreviewed dynamic import in ${name}`);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.') && !match[1].startsWith('node:')) external.add(match[1]);
    }
  }
  for (const folder of ['lua', 'plugin']) {
    for (const path of packageFiles(join(root, folder)).filter(path => path.endsWith('.lua'))) {
      for (const match of readFileSync(path, 'utf8').matchAll(/\brequire\s*\(?\s*['"]([^'"]+)['"]/g)) {
        assert.ok(match[1] === 'harness' || match[1].startsWith('harness.'), `External Lua dependency: ${match[1]}`);
      }
    }
  }
  return [...external].sort();
}

export function inventory() {
  assert.equal(process.version, 'v26.10.0', 'Use audited Node v26.10.0');
  return { rust: rustInventory(), npm: npmInventory(), imports: imports(), lua_external: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const actual = inventory(), baseline = json('tests/evidence/dependency-baseline.json');
    assert.deepEqual(actual, baseline, 'Dependency review required: installed packages, features, scripts, files, or imports changed');
    const rust = actual.rust.packages.length, npm = actual.npm.packages.length;
    console.log(`Dependencies verified: Rust 3 direct + ${rust - 3} transitive = ${rust}; npm 3 direct + ${npm - 3} transitive = ${npm}; Lua 0.`);
    console.log(`npm optional-only ${actual.npm.packages.filter(pkg => pkg.optional).length}; npm development ${actual.npm.packages.filter(pkg => pkg.dev).length}; Rust build/test declarations 0; reviewed Rust build scripts ${actual.rust.packages.filter(pkg => pkg.build_scripts.length).length}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
