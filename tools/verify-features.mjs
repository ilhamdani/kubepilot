// Behavioural checks for the five UI features added to KubePilot.
// usage: npm run verify:features
//
// The pure logic modules are imported directly (Node strips their TS types),
// so these tests exercise the same functions the app runs — not string
// matching against source text. The last section checks that the IPC bridge
// and UI entry points are wired up on both sides of the context bridge.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAll, dump } from 'js-yaml';
import {
  KubeconfigError,
  normalizeKubeconfigDoc,
  renameConflictingContexts,
  safeFileStem,
  validateKubeconfigDoc,
} from '../src/main/kube/paste.ts';
import {
  DEFAULT_DURATION,
  applyPortForwardState,
  activeForwards,
  makeNotice,
  unsavedDraftCount,
} from '../src/renderer/src/state/rules.ts';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const throws = (fn, expected) => {
  try {
    fn();
  } catch (err) {
    assert(err instanceof KubeconfigError, `expected KubeconfigError, got ${err.name}`);
    if (expected) assert(err.message.includes(expected), `error should mention "${expected}", got "${err.message}"`);
    return;
  }
  throw new Error('expected the call to throw');
};

const VALID = [
  'apiVersion: v1',
  'kind: Config',
  'clusters:',
  '  - name: c1',
  '    cluster:',
  '      server: https://10.0.0.1:6443',
  'contexts:',
  '  - name: prod',
  '    context:',
  '      cluster: c1',
  '      user: admin',
  'current-context: prod',
  'users:',
  '  - name: admin',
  '    user:',
  '      token: abc',
  '',
].join('\n');

// Mirrors the parse step in ipc.ts, then runs the exact validation/rename path.
function parseLikeMain(text, existingNames = []) {
  const docs = loadAll(text);
  const objects = docs.filter((d) => d && typeof d === 'object' && !Array.isArray(d));
  const chosen = objects.find((d) => Array.isArray(d.contexts) || Array.isArray(d.clusters)) ?? objects[0];
  const ignored = Math.max(0, objects.length - 1);
  const parsed = validateKubeconfigDoc(chosen, ignored);
  const normalized = normalizeKubeconfigDoc(parsed.doc);
  const renamed = renameConflictingContexts(parsed.doc, existingNames);
  const content = normalized || renamed.renames.length || ignored ? dump(parsed.doc) : text;
  return {
    ...parsed,
    normalized,
    renames: renamed.renames,
    warnings: [...parsed.warnings, ...renamed.warnings],
    content,
  };
}

console.log('\nKubeconfig paste: validation');
check('accepts a normal kubeconfig and lists its context', () => {
  const r = parseLikeMain(VALID);
  assert(r.contexts.length === 1 && r.contexts[0] === 'prod', 'wrong contexts');
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings}`);
  assert(r.normalized === false, 'a complete config must not be rewritten');
  assert(r.content === VALID, 'the user text should be kept verbatim');
  return 'prod, text preserved byte-for-byte';
});
check('rejects input with no clusters/contexts sections', () => {
  throws(() => validateKubeconfigDoc({ foo: 'bar' }), "doesn't look like a kubeconfig");
});
check('rejects a config with no contexts', () => {
  throws(() => validateKubeconfigDoc({ clusters: [], contexts: [] }), 'no contexts');
});
check('rejects contexts that point at a cluster with no server', () => {
  const doc = { contexts: [{ name: 'x', context: { cluster: 'c' } }], clusters: [{ name: 'c', cluster: {} }] };
  throws(() => validateKubeconfigDoc(doc), 'nothing to connect to');
});
check('warns about extra YAML documents and drops them from the written file', () => {
  const r = parseLikeMain(`${VALID}---\nfoo: bar\n`);
  assert(r.warnings.some((w) => w.includes('1 extra YAML document')), 'missing warning');
  assert(loadAll(r.content).length === 1, 'the persisted file must contain one document');
  return 'single document persisted';
});
check('warns about a non-v1 apiVersion', () => {
  const doc = loadAll(VALID.replace('apiVersion: v1', 'apiVersion: v2'))[0];
  const r = validateKubeconfigDoc(doc);
  assert(r.warnings.some((w) => w.includes('v2')), 'missing warning');
});
check('adds apiVersion/kind to hand-written configs and rewrites the file', () => {
  const r = parseLikeMain(VALID.replace('apiVersion: v1\n', '').replace('kind: Config\n', ''));
  assert(r.normalized === true, 'normalization should be reported');
  const doc = loadAll(r.content)[0];
  assert(doc.apiVersion === 'v1' && doc.kind === 'Config', 'defaults not written');
  return 'v1 / Config written back';
});
check('renames colliding context names and fixes current-context', () => {
  const r = parseLikeMain(VALID, ['prod']);
  assert(r.renames.length === 1, 'expected one rename');
  assert(r.renames[0].to === 'prod-2', `expected prod-2, got ${r.renames[0].to}`);
  const doc = loadAll(r.content)[0];
  assert(doc.contexts[0].name === 'prod-2', 'rename not persisted');
  assert(doc['current-context'] === 'prod-2', 'current-context not updated');
  assert(r.warnings.some((w) => w.includes('already exists')), 'missing warning');
  return 'prod → prod-2, current-context fixed';
});
check('picks prod-3 when prod and prod-2 are both taken', () => {
  const r = parseLikeMain(VALID, ['prod', 'prod-2']);
  assert(r.renames[0].to === 'prod-3', `expected prod-3, got ${r.renames[0].to}`);
  return 'prod-3';
});
check('sanitizes a pasted label into a safe filename', () => {
  assert(safeFileStem('../../etc/passwd') === 'etc-passwd', `got ${safeFileStem('../../etc/passwd')}`);
  assert(safeFileStem('   ') === 'pasted', 'blank label should fall back');
  assert(!safeFileStem('a b\\c').includes('\\'), 'backslashes must be removed');
});

console.log('\nNotifications and port-forward state rules');
check('errors are sticky, successes expire, and titles are filled in', () => {
  const error = makeNotice('e', 'It broke', 'error', { detail: 'stack' }, 1000);
  assert(error.duration === 0 && DEFAULT_DURATION.error === 0, 'errors must not auto-dismiss');
  assert(error.title === 'Something went wrong', 'missing default title');
  assert(error.detail === 'stack', 'detail lost');
  assert(error.read === false, 'new notices must be unread');
  const success = makeNotice('s', 'Done', 'success', {}, 1000);
  assert(success.duration > 0 && success.title === 'Success', 'success defaults wrong');
  return 'error sticky / success 6.5s';
});
check('honours an explicit title and duration', () => {
  const n = makeNotice('x', 'hi', 'info', { title: 'Imported', duration: 42 }, 1000);
  assert(n.title === 'Imported' && n.duration === 42 && n.at === 1000, 'options ignored');
});
check('port-forward updates upsert by id and remove on stopped', () => {
  const base = { id: 'a', localPort: 8080, status: 'starting' };
  const list = applyPortForwardState([], base);
  const updated = applyPortForwardState(list, { id: 'a', localPort: 8080, status: 'active' });
  assert(updated.length === 1 && updated[0].status === 'active', 'update failed');
  assert(updated[0].localPort === 8080, 'earlier fields were lost');
  const added = applyPortForwardState(updated, { id: 'b', localPort: 9090, status: 'active' });
  assert(added.length === 2, 'second tunnel missing');
  const stopped = applyPortForwardState(added, { id: 'a', status: 'stopped' });
  assert(stopped.length === 1 && stopped[0].id === 'b', 'stopped tunnel not removed');
  return 'upsert / append / remove';
});
check('activeForwards ignores errored and stopped entries', () => {
  const list = [
    { id: '1', status: 'active' },
    { id: '2', status: 'starting' },
    { id: '3', status: 'error' },
    { id: '4', status: 'stopped' },
  ];
  assert(activeForwards(list).length === 2, 'wrong running count');
});
check('only genuinely edited create drafts count as unsaved', () => {
  const tabs = [
    { kind: 'create', create: { yaml: 'original' }, createDraft: 'original' },
    { kind: 'create', create: { yaml: 'original' }, createDraft: 'changed' },
    { kind: 'create', create: { yaml: 'original' }, createDraft: '' },
    { kind: 'resource' },
  ];
  assert(unsavedDraftCount(tabs) === 2, `expected 2, got ${unsavedDraftCount(tabs)}`);
  return 'empty document counts as a draft';
});

console.log('\nBridge and UI wiring');
const preload = read('src/preload/index.ts');
const api = read('src/renderer/src/api.ts');
const ipc = read('src/main/ipc.ts');
const app = read('src/renderer/src/App.tsx');
const itemList = read('src/renderer/src/components/ItemList.tsx');
const tabBar = read('src/renderer/src/components/TabBar.tsx');
const drawer = read('src/renderer/src/components/DetailDrawer.tsx');
const statusBar = read('src/renderer/src/components/StatusBar.tsx');
const store = read('src/renderer/src/state/store.ts');

check('paste channel exists on all three layers', () => {
  assert(preload.includes("'kubeconfig:paste'"), 'preload missing channel');
  assert(api.includes('paste: (payload'), 'api type missing paste');
  assert(ipc.includes("'kubeconfig:paste'"), 'main handler missing');
});
check('stopAll channel exists on all three layers', () => {
  assert(preload.includes("'portforward:stopAll'"), 'preload missing channel');
  assert(api.includes('stopAll: ()'), 'api type missing stopAll');
  assert(ipc.includes("'portforward:stopAll'"), 'main handler missing');
});
check('port-forward state is broadcast to every window', () => {
  assert(ipc.includes("send('kubepilot:portforward-state', next)"), 'main only notifies the sender');
  assert(ipc.includes('portForwardStates'), 'no shared state map');
});
check('single click opens details; double-click handler is gone', () => {
  assert(/onClick=\{\(\) => \{\s*setSelected\(id\);\s*openDetails\(/.test(itemList), 'row click does not open details');
  assert(!itemList.includes('onDoubleClick'), 'onDoubleClick still present');
});
check('close-all is reachable from store, shortcut, tab bar and palette', () => {
  assert(store.includes('closeAllTabs()') && store.includes('requestCloseAllTabs()'), 'store actions missing');
  assert(tabBar.includes('requestCloseAllTabs'), 'tab bar button missing');
  assert(app.includes("event.key.toLowerCase() === 'w'") && app.includes('requestCloseAllTabs()'), 'shortcut missing');
  assert(read('src/renderer/src/components/CommandPalette.tsx').includes('action:close-all'), 'palette entry missing');
});
check('detail sidebar shows port forwards with a stop control', () => {
  assert(drawer.includes('<PortForwardRow'), 'drawer does not render forward rows');
  assert(drawer.includes('stopPortForwards('), 'no stop-all for this resource');
  assert(drawer.includes('pf-badge'), 'header badge missing');
});
check('notification centre and rich toasts are mounted', () => {
  assert(app.includes('<Toasts />') && app.includes('<NotificationCenter />'), 'notifications not mounted');
  assert(statusBar.includes('notice-badge') && statusBar.includes('toggleNotifications'), 'status bar bell missing');
  assert(read('src/renderer/src/components/Notifications.tsx').includes('Show details'), 'no expandable detail');
});
check('paste modal is reachable from rail, settings, welcome and palette', () => {
  assert(app.includes('toggleKubeconfigModal(true)'), 'rail/welcome not wired');
  assert(read('src/renderer/src/components/Settings.tsx').includes('toggleKubeconfigModal(true)'), 'settings not wired');
  assert(read('src/renderer/src/components/CommandPalette.tsx').includes('action:kubeconfig'), 'palette not wired');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failing: ${failures.join(', ')}`);
  process.exit(1);
}
