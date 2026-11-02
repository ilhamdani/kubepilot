// Verifies the macOS packaging configuration without a Mac. Everything here is
// a static check on files in the repo, so QA can run it on Windows or Linux:
//
//   node tools/verify-mac-config.mjs      (or: npm run verify:mac)
//
// Exits non-zero if any check fails. It cannot prove that a .dmg builds - only
// a macOS host can do that - but it does catch the mistakes that make the macOS
// build fail or ship broken: a malformed config, a missing entitlements file,
// an ICNS without the sizes Finder needs, or a workflow that quietly drops an
// architecture.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const results = [];
function check(label, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, label, detail: detail || '' });
  } catch (err) {
    results.push({ ok: false, label, detail: err.message });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------------ plist XML

// Minimal well-formedness pass: strip comments, then walk tags with a stack.
// Enough to catch an unbalanced or truncated plist, which is the failure mode
// that makes codesign reject the bundle with a cryptic error.
function xmlProblem(text) {
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*<\?xml\s/.test(body)) return 'missing <?xml ... ?> declaration';

  const stack = [];
  const tag = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  let seenRoot = 0;
  while ((match = tag.exec(body)) !== null) {
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.pop() !== name) return `unexpected </${name}>`;
    } else if (selfClosing) {
      seenRoot++;
    } else {
      if (stack.length === 0) seenRoot++;
      stack.push(name);
    }
  }
  if (stack.length > 0) return `unclosed <${stack[stack.length - 1]}>`;
  if (seenRoot === 0) return 'no elements';
  if (!/<plist\b[^>]*version\s*=\s*"1\.0"/.test(body)) return 'no <plist version="1.0"> root';
  return null;
}

// ------------------------------------------------------------------ ICNS

const ICNS_EXPECTED = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
};

function readIcns(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert(buf.toString('ascii', 0, 4) === 'icns', 'does not start with the "icns" magic');
  const declared = buf.readUInt32BE(4);
  assert(declared === buf.length, `header says ${declared} bytes, file is ${buf.length}`);

  const elements = new Map();
  for (let off = 8; off < buf.length; ) {
    assert(off + 8 <= buf.length, `truncated element header at byte ${off}`);
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    assert(len >= 8, `element ${type} has length ${len}`);
    assert(off + len <= buf.length, `element ${type} overruns the file`);
    const payload = buf.subarray(off + 8, off + len);
    const isPng = payload.toString('ascii', 1, 4) === 'PNG';
    elements.set(type, {
      length: len,
      isPng,
      width: isPng ? payload.readUInt32BE(16) : 0,
      height: isPng ? payload.readUInt32BE(20) : 0,
    });
    off += len;
  }
  return elements;
}

// ------------------------------------------------------------------ checks

let builderConfig = null;
check('electron-builder.yml parses', () => {
  builderConfig = yaml.load(read('electron-builder.yml'));
  assert(builderConfig && typeof builderConfig === 'object', 'not a YAML mapping');
  return 'top-level keys: ' + Object.keys(builderConfig).join(', ');
});

check('mac section present', () => {
  assert(builderConfig, 'config did not parse');
  assert(builderConfig.mac, 'no mac: section');
  return '';
});

const mac = () => builderConfig.mac;

check('mac.category is developer-tools', () => {
  assert(mac().category === 'public.app-category.developer-tools', `got ${mac().category}`);
  return mac().category;
});

check('mac targets: dmg + zip for arm64 and x64', () => {
  const targets = Array.isArray(mac().target) ? mac().target : [mac().target];
  const map = new Map();
  for (const entry of targets) {
    assert(entry && typeof entry === 'object', 'target entries must carry arch lists');
    map.set(entry.target, new Set(entry.arch || []));
  }
  for (const kind of ['dmg', 'zip']) {
    assert(map.has(kind), `missing ${kind} target`);
    const arches = map.get(kind);
    assert(arches.has('arm64'), `${kind} is missing arm64`);
    assert(arches.has('x64'), `${kind} is missing x64`);
  }
  return 'dmg[arm64,x64], zip[arm64,x64]';
});

check('mac artifactName is arch-specific', () => {
  assert(typeof mac().artifactName === 'string', 'no artifactName');
  assert(mac().artifactName.includes('${arch}'), 'artifactName does not include ${arch}');
  return mac().artifactName;
});

check('mac hardened runtime + gatekeeperAssess', () => {
  assert(mac().hardenedRuntime === true, 'hardenedRuntime is not true');
  assert(mac().gatekeeperAssess === false, 'gatekeeperAssess is not false');
  return 'hardenedRuntime: true, gatekeeperAssess: false';
});

check('mac notarize is left to environment variables', () => {
  // electron-builder 26's `notarize` is a boolean that *disables* the step.
  // Setting it to false would silently break signed releases.
  assert(
    mac().notarize === undefined || mac().notarize === true,
    'mac.notarize is false, which disables notarization for signed builds',
  );
  return mac().notarize === undefined ? 'unset (auto)' : 'true';
});

check('mac entitlements paths resolve', () => {
  for (const key of ['entitlements', 'entitlementsInherit']) {
    const value = mac()[key];
    assert(typeof value === 'string', `${key} is not set`);
    assert(exists(value), `${key} points at a missing file: ${value}`);
  }
  assert(mac().entitlements === mac().entitlementsInherit, 'the two entitlement paths differ');
  return mac().entitlements;
});

check('build/entitlements.mac.plist is well-formed', () => {
  const text = read('build/entitlements.mac.plist');
  const problem = xmlProblem(text);
  assert(problem === null, problem);
  return 'balanced XML, plist 1.0 root';
});

check('entitlements carry the three hardened-runtime keys', () => {
  const text = read('build/entitlements.mac.plist');
  const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  const required = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.allow-dyld-environment-variables',
  ];
  for (const key of required) {
    assert(keys.includes(key), `missing ${key}`);
  }
  const extras = keys.filter((k) => !required.includes(k));
  return extras.length ? `keys: ${keys.length} (extra: ${extras.join(', ')})` : `keys: ${keys.length}`;
});

check('mac.icon points at build/icon.icns', () => {
  assert(mac().icon === 'build/icon.icns', `got ${mac().icon}`);
  assert(exists('build/icon.icns'), 'build/icon.icns does not exist');
  return mac().icon;
});

check('build/icon.icns is a valid container', () => {
  const elements = readIcns('build/icon.icns');
  return `${elements.size} elements, ${fs.statSync(path.join(root, 'build/icon.icns')).size} bytes`;
});

check('icon.icns embeds the required sizes', () => {
  const elements = readIcns('build/icon.icns');
  const missing = [];
  for (const [type, size] of Object.entries(ICNS_EXPECTED)) {
    const entry = elements.get(type);
    if (!entry) missing.push(`${type} (${size}px) absent`);
    else if (!entry.isPng) missing.push(`${type} is not PNG data`);
    else if (entry.width !== size || entry.height !== size) {
      missing.push(`${type} is ${entry.width}x${entry.height}, expected ${size}x${size}`);
    }
  }
  assert(missing.length === 0, missing.join('; '));
  const retina = ['ic11', 'ic12', 'ic13', 'ic14'].filter((t) => elements.has(t));
  return `16/32/64/128/256/512/1024 present, retina: ${retina.join(',') || 'none'}`;
});

check('build/icon.png still exists for Windows', () => {
  assert(exists('build/icon.png'), 'build/icon.png is missing');
  const size = fs.statSync(path.join(root, 'build/icon.png')).size;
  return `${size} bytes`;
});

check('win packaging untouched', () => {
  const win = builderConfig.win;
  assert(win, 'win: section disappeared');
  assert(win.icon === 'build/icon.png', `win.icon is ${win.icon}`);
  const kinds = (Array.isArray(win.target) ? win.target : [win.target]).map((t) =>
    typeof t === 'string' ? t : t.target,
  );
  assert(kinds.includes('nsis'), 'win no longer targets nsis');
  assert(builderConfig.nsis, 'nsis: section disappeared');
  return `nsis, ${kinds.join(', ')}`;
});

check('package.json has the macOS scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  const scripts = pkg.scripts || {};
  const expected = {
    'dist:mac': 'electron-builder --mac',
    'dist:mac:arm64': 'electron-builder --mac --arm64',
    'dist:mac:x64': 'electron-builder --mac --x64',
  };
  for (const [name, fragment] of Object.entries(expected)) {
    assert(scripts[name], `missing script "${name}"`);
    assert(scripts[name].includes(fragment), `script "${name}" does not run ${fragment}`);
    assert(scripts[name].includes('npm run build'), `script "${name}" does not build first`);
  }
  assert(scripts['icon:icns'] === 'node tools/make-icns.mjs', 'missing or wrong "icon:icns" script');
  return [...Object.keys(expected), 'icon:icns'].join(', ');
});

let workflow = null;
check('build-mac.yml parses', () => {
  workflow = yaml.load(read('.github/workflows/build-mac.yml'));
  assert(workflow && typeof workflow === 'object', 'not a YAML mapping');
  return '';
});

// YAML 1.1 reads a bare `on:` key as the boolean true.
const workflowTriggers = () => workflow.on || workflow[true] || workflow['true'];

check('workflow triggers on push and dispatch', () => {
  const on = workflowTriggers();
  assert(on, 'no on: block');
  const keys = Object.keys(on);
  assert(keys.includes('push'), 'does not run on push');
  assert(keys.includes('workflow_dispatch'), 'not manually dispatchable');
  return keys.join(', ');
});

check('workflow runs on macos-14', () => {
  const jobs = workflow.jobs || {};
  const job = jobs.mac;
  assert(job, 'no jobs.mac');
  assert(job['runs-on'] === 'macos-14', `runs-on is ${job['runs-on']}`);
  return job['runs-on'];
});

check('workflow matrix builds arm64 and x64', () => {
  const matrix = workflow.jobs.mac.strategy && workflow.jobs.mac.strategy.matrix;
  assert(matrix, 'no strategy.matrix');
  const arches = matrix.arch || [];
  for (const arch of ['arm64', 'x64']) {
    assert(arches.includes(arch), `matrix is missing ${arch}`);
  }
  return arches.join(', ');
});

check('workflow installs with node 22 and npm ci', () => {
  const steps = workflow.jobs.mac.steps || [];
  const setup = steps.find((s) => String(s.uses || '').startsWith('actions/setup-node@v4'));
  assert(setup, 'no actions/setup-node@v4 step');
  assert(String(setup.with['node-version']) === '22', `node-version is ${setup.with['node-version']}`);
  assert(setup.with.cache === 'npm', 'npm cache is not enabled');
  assert(
    steps.some((s) => s.run === 'npm ci'),
    'no npm ci step',
  );
  return 'node 22, npm cache, npm ci';
});

check('workflow packages both arches', () => {
  const steps = workflow.jobs.mac.steps || [];
  const pkg = steps.find((s) => String(s.run || '').includes('electron-builder --mac'));
  assert(pkg, 'no electron-builder --mac step');
  assert(pkg.run.includes('matrix.arch'), 'package step does not use the matrix arch');
  assert(pkg.run.includes('npm run build') || steps.some((s) => s.run === 'npm run build'), 'does not compile first');
  return pkg.run;
});

check('workflow keeps signing optional', () => {
  const steps = workflow.jobs.mac.steps || [];
  const pkg = steps.find((s) => String(s.run || '').includes('electron-builder --mac'));
  const env = pkg.env || {};
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    assert(env[key], `env ${key} is not wired from secrets`);
    assert(String(env[key]).includes('secrets.'), `env ${key} does not come from secrets`);
  }
  // Nothing may make the job fail when the secrets are empty.
  assert(!String(pkg.run).includes('CSC_LINK') || !String(pkg.run).includes('test -n'), 'build step gates on secrets');
  return Object.keys(env).join(', ');
});

check('workflow uploads the installers', () => {
  const steps = workflow.jobs.mac.steps || [];
  const upload = steps.find((s) => String(s.uses || '').startsWith('actions/upload-artifact@v4'));
  assert(upload, 'no actions/upload-artifact@v4 step');
  const paths = String(upload.with.path || '');
  assert(paths.includes('dist/*.dmg'), 'does not upload *.dmg');
  assert(paths.includes('dist/*.zip'), 'does not upload *.zip');
  return upload.with.name;
});

// ------------------------------------------------------------------ report

const width = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${r.label.padEnd(width)}  ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''}`,
);
if (failed.length) {
  console.log('\nWhat still has to happen on a Mac: a real `npm run dist:mac` (electron-builder');
  console.log('refuses to build macOS targets anywhere else), then launching the .app.');
}
process.exit(failed.length ? 1 : 0);
