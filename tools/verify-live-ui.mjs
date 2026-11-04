// Live verification of the five UX features against a running KubePilot build.
//
//   usage: LENS_CDP_PORT=9333 node tools/verify-live-ui.mjs
//
// A tiny in-process Kubernetes API gives the renderer real resource rows, so
// single-click details and the port-forward sidebar can be exercised without
// depending on a real cluster. Everything the check creates (one pasted
// kubeconfig, some error-state forwards) is removed again at the end.
//
// Note: the contextBridge API is frozen, so this script never stubs
// `window.kube`. It drives DOM clicks and calls real IPC methods instead.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const cdpPort = Number(process.env.LENS_CDP_PORT ?? '9222');
const mockPort = Number(process.env.MOCK_KUBE_PORT ?? '18443');
// Optional: CAPTURE_SHOTS=1 writes a few PNGs of the new UI into .tmp-verify/shots.
const shotDir = process.env.CAPTURE_SHOTS ? join(process.cwd(), '.tmp-verify', 'shots') : undefined;
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ mock API */

const NOW = new Date().toISOString();
const pod = (name, phase = 'Running') => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name,
    namespace: 'default',
    uid: `uid-${name}`,
    resourceVersion: '1',
    creationTimestamp: NOW,
    labels: { app: 'web' },
  },
  spec: {
    nodeName: 'mock-node-1',
    containers: [{ name: 'nginx', image: 'nginx:1.25', ports: [{ containerPort: 80 }] }],
  },
  status: {
    phase,
    podIP: '10.0.0.5',
    hostIP: '10.0.0.1',
    containerStatuses: [
      { name: 'nginx', ready: phase === 'Running', restartCount: 0, state: { running: { startedAt: NOW } } },
    ],
  },
});
const PODS = [pod('web-0'), pod('web-1')];
const list = (items = []) => ({ kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: '1' }, items });

const mock = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${mockPort}`);
  const path = url.pathname;
  const json = (value) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  // Watches are long-lived chunked GETs. Keep the socket open and send nothing;
  // the initial list() call is what populates the table.
  if (url.searchParams.has('watch')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    req.on('close', () => res.end());
    return;
  }

  if (path === '/version') return json({ gitVersion: 'v1.30.0-kubepilot-mock', major: '1', minor: '30' });
  if (path === '/api') return json({ kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] });
  if (path === '/apis') return json({ kind: 'APIGroupList', apiVersion: 'v1', groups: [] });
  if (path === '/api/v1') {
    return json({
      kind: 'APIResourceList',
      groupVersion: 'v1',
      resources: ['pods', 'services', 'namespaces', 'events', 'configmaps', 'secrets', 'nodes'].map((name) => ({
        name,
        singularName: '',
        namespaced: name !== 'namespaces' && name !== 'nodes',
        kind: { pods: 'Pod', services: 'Service', namespaces: 'Namespace', events: 'Event', configmaps: 'ConfigMap', secrets: 'Secret', nodes: 'Node' }[name],
        verbs: ['get', 'list', 'watch'],
      })),
    });
  }
  if (path === '/api/v1/namespaces') {
    return json(list([
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system' } },
    ]));
  }
  if (path === '/api/v1/pods' || path === '/api/v1/namespaces/default/pods') return json(list(PODS));
  const podDetail = /^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)$/.exec(path);
  if (podDetail) return json(PODS.find((p) => p.metadata.name === podDetail[1]) ?? PODS[0]);
  if (path.endsWith('/log')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('mock log line\n');
  }
  if (path === '/api/v1/services' || path === '/api/v1/namespaces/default/services') {
    return json(list([{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'default' }, spec: { ports: [{ port: 80 }] } }]));
  }
  return json(list());
});
await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: kubepilot-mock
    cluster:
      server: http://127.0.0.1:${mockPort}
contexts:
  - name: kubepilot-mock
    context:
      cluster: kubepilot-mock
      user: mock-admin
      namespace: default
current-context: kubepilot-mock
users:
  - name: mock-admin
    user: {}
`;

/* ------------------------------------------------------------------- CDP link */

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error(`no page target on port ${cdpPort}`);
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
});
await new Promise((r) => ws.on('open', r));

async function evalJs(expression) {
  const out = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails).slice(0, 500));
  }
  return out.result?.value;
}

async function capture(name) {
  if (!shotDir) return;
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

const js = (value) => JSON.stringify(value);
const click = (selector) => evalJs(`(() => { const el = document.querySelector(${js(selector)}); if (!el) return false; el.click(); return true; })()`);
// textContent, not innerText: .section-title is uppercased by CSS, and
// innerText reflects that transform in Chromium.
const clickText = (text, selector = 'button') =>
  evalJs(`(() => { const needle = ${js(text)}.toLowerCase(); const el = [...document.querySelectorAll(${js(selector)})].find(e => (e.textContent || '').toLowerCase().includes(needle)); if (!el) return false; el.click(); return true; })()`);
const clickTitle = (text) =>
  evalJs(`(() => { const el = [...document.querySelectorAll('button')].find(e => (e.title || '').includes(${js(text)})); if (!el) return false; el.click(); return true; })()`);
const setInput = (selector, value) =>
  evalJs(`(() => { const el = document.querySelector(${js(selector)}); if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${js(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const text = (selector) => evalJs(`document.querySelector(${js(selector)})?.innerText ?? ''`);
const count = (selector) => evalJs(`document.querySelectorAll(${js(selector)}).length`);
const bodyHas = (value) => evalJs(`document.body.textContent.includes(${js(value)})`);
/** Close the topmost modal through its own footer/overlay, without a global Escape. */
const closeModal = () =>
  evalJs(`(() => { const overlays = [...document.querySelectorAll('.modal-overlay')]; if (!overlays.length) return false; const top = overlays[overlays.length - 1]; const done = [...top.querySelectorAll('.modal-footer button')].find(b => /^(Done|Cancel)$/.test((b.textContent || '').trim())); if (done) { done.click(); return 'footer'; } top.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'overlay'; })()`);
async function closeAllModals() {
  for (let i = 0; i < 6; i += 1) {
    if (!(await closeModal())) return;
    await sleep(120);
  }
}
const closePalette = () =>
  evalJs(`(() => { const overlay = document.querySelector('.palette-overlay'); if (!overlay) return false; overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
const escape = () => evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const modalIs = (title) => `[...document.querySelectorAll('.modal-header')].some(h => h.innerText === ${JSON.stringify(title)})`;
const modalStarts = (prefix) => `[...document.querySelectorAll('.modal-header')].some(h => h.innerText.startsWith(${JSON.stringify(prefix)}))`;

async function waitFor(expression, label, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evalJs(expression)) return;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const checks = [];
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${error?.message ?? error}`);
  }
}

console.log(`KubePilot live UI verification (CDP :${cdpPort}, mock API :${mockPort})\n`);

// The workstation may or may not have a reachable cluster, so don't depend on
// a connection failure for the notification checks. Seed one deterministic
// error through a real IPC call, then remove the tunnel that produced it.
await waitFor(`!!window.kube && !!document.querySelector('.statusbar')`, 'app shell', 15000);
await sleep(400);
await closeAllModals();
const seeded = await evalJs(`window.kube.portForward.start({ clusterId: 'live:__kubepilot_seed__', namespace: 'default', kind: 'pod', name: 'seed', localPort: 19999, remotePort: 80 })`);
assert(seeded?.status === 'error', 'could not seed an error notification');
await evalJs(`window.kube.portForward.stop(${js(seeded.id)})`);
await waitFor(`!!document.querySelector('.notice--error[role="alert"]')`, 'seeded error notice', 8000);

/* ------------------------------------------------------- 1. notifications */

await check('sticky, accessible error notification is shown', async () => {
  assert((await count('.notice--error[role="alert"]')) >= 1, 'no error notice');
  const title = await text('.notice--error .notice-title');
  assert(title.trim().length > 0, 'notice has no title');
  assert((await count('.notice--error .notice-close')) >= 1, 'no explicit dismiss button');
  assert((await count('.notice--error .notice-timer')) === 0, 'errors must not auto-dismiss');
  return `role=alert, "${title.trim()}", dismiss, no timer`;
});

await check('errors expose expandable technical details', async () => {
  // Click and read in one awaited evaluation so React has flushed its state
  // update before we look for the <pre>.
  const detail = await evalJs(`(async () => {
    const btn = document.querySelector('.notice-more');
    if (!btn) return null;
    btn.click();
    await new Promise(r => setTimeout(r, 150));
    return document.querySelector('.notice-detail')?.textContent ?? null;
  })()`);
  assert(detail && detail.trim().length > 0, 'detail did not expand or was empty');
  return `${detail.trim().length} chars of technical detail`;
});

await check('notification center keeps session history with filters', async () => {
  assert(await click('.notice-statusbar'), 'bell not found');
  await waitFor(modalIs('Notifications'), 'notification center');
  try {
    assert((await count('.notice-filters button')) === 3, 'expected All / Errors / Successes filters');
    assert((await count('.notice-history .notice')) >= 1, 'history is empty');
    assert(await clickText('Errors', '.notice-filters button'), 'Errors filter missing');
    const mixed = await evalJs(`[...document.querySelectorAll('.notice-history .notice')].some(n => !n.classList.contains('notice--error'))`);
    assert(!mixed, 'Errors filter leaked a non-error notice');
    await capture('notification-center');
    return '3 filters, history retained, error filter isolates failures';
  } finally {
    await closeAllModals();
    await waitFor(`!document.querySelector('.modal-overlay')`, 'notification center to close');
  }
});

/* -------------------------------------------------- 2. paste kubeconfig */

const pathsBefore = await evalJs(`window.kube.kubeconfig.paths()`);

await check('rail opens the paste-kubeconfig modal', async () => {
  await closeAllModals();
  assert(await clickTitle('Add cluster — paste a kubeconfig'), 'rail add button missing');
  await waitFor(`!!document.querySelector('textarea.kube-input')`, 'kubeconfig textarea');
  assert((await count('.modal-footer button')) >= 3, 'footer actions missing');
  assert(await bodyHas('Ctrl+Enter imports'), 'shortcut hint missing');
  assert(await bodyHas('Paste from clipboard'), 'clipboard button missing');
  assert(await bodyHas('Choose file'), 'file fallback missing');
  await capture('paste-kubeconfig');
  return 'textarea, clipboard + file fallback, Ctrl+Enter hint';
});

await check('invalid YAML is rejected with a clear error', async () => {
  assert(await setInput('textarea.kube-input', 'hello: world'), 'could not fill textarea');
  await sleep(120);
  assert(await clickText('Import pasted config', '.modal-footer button'), 'import button missing');
  await waitFor(`!!document.querySelector('.modal-body .warning-box')`, 'inline validation error');
  const inline = await text('.modal-body .warning-box');
  assert(inline.includes('kubeconfig'), `unhelpful message: ${inline}`);
  const paths = await evalJs(`window.kube.kubeconfig.paths()`);
  assert(paths.length === pathsBefore.length, 'invalid input was written to disk');
  const failure = await evalJs(`[...document.querySelectorAll('.notice-title')].some(n => n.innerText === 'Kubeconfig import failed')`);
  assert(failure, 'no error notification');
  return inline.slice(0, 90);
});

let importedPath;
await check('valid kubeconfig imports, persists and reports what happened', async () => {
  assert(await setInput('textarea.kube-input', KUBECONFIG), 'could not fill textarea');
  assert(await setInput('.modal-body .field-row input', 'KubePilot Mock'), 'could not set label');
  await sleep(120);
  assert(await clickText('Import pasted config', '.modal-footer button'), 'import button missing');
  await waitFor(`!document.querySelector('textarea.kube-input')`, 'modal to close');
  const paths = await evalJs(`window.kube.kubeconfig.paths()`);
  importedPath = paths.find((p) => !pathsBefore.includes(p));
  assert(importedPath, 'no managed kubeconfig file was created');
  assert(/kubeconfigs/.test(importedPath), `unexpected location: ${importedPath}`);
  assert(await bodyHas('Kubeconfig imported'), 'no success notification');
  const detail = await evalJs(`(async () => {
    const n = [...document.querySelectorAll('.notice')].find(n => n.querySelector('.notice-title')?.textContent === 'Kubeconfig imported');
    if (!n) return null;
    n.querySelector('.notice-more')?.click();
    await new Promise(r => setTimeout(r, 150));
    return n.querySelector('.notice-detail')?.textContent ?? null;
  })()`);
  assert(detail, 'success notification has no expandable detail');
  assert(detail.includes('kubepilot-mock'), 'imported context not named in the notification');
  assert(/Saved to/.test(detail), 'saved path not reported');
  return `saved to ${importedPath.split(/[\\/]/).slice(-1)[0]}`;
});

await check('cluster rail refreshes with the imported context', async () => {
  await waitFor(`[...document.querySelectorAll('.rail-item')].some(e => (e.title || '').includes('kubepilot-mock'))`, 'new cluster in rail', 8000);
  return 'new rail item present';
});

/* --------------------------- 3. single-click details + port-forward sidebar */

await check('mock cluster connects through the pasted kubeconfig', async () => {
  assert(await clickTitle('kubepilot-mock'), 'mock cluster rail item missing');
  await waitFor(`document.querySelector('.overview-sub')?.innerText.includes('connected')`, 'connected overview', 10000);
  return (await text('.overview-sub')).trim().slice(0, 80);
});

await check('resource rows render from the mock API', async () => {
  assert(await clickText('Pods', '.nav-item'), 'Pods nav item missing');
  await waitFor(`document.querySelectorAll('.tbody .tr').length >= 2`, 'pod rows', 10000);
  const titles = await evalJs(`[...document.querySelectorAll('.tbody .tr')].map(r => r.title)`);
  assert(titles.every((t) => t === 'Click to view details · right-click for actions'), 'row tooltip missing');
  return `${titles.length} rows, all marked single-click`;
});

await check('a single click opens the detail drawer', async () => {
  assert(await click('.tbody .tr'), 'row missing');
  await waitFor(`!!document.querySelector('.drawer')`, 'detail drawer', 8000);
  assert((await count('.drawer')) === 1, 'drawer did not open on one click');
  return (await text('.drawer-title')).trim();
});

await check('detail sidebar exposes port-forward status and controls', async () => {
  assert(await bodyHas('Port forwards'), 'no Port forwards section');
  assert(await bodyHas('No port forward is running'), 'no empty-state hint');
  assert(await bodyHas('New…'), 'no New… button');
  assert(await bodyHas('View every port forward →'), 'no link to the global panel');
  assert(await bodyHas('Port forward'), 'no Port forward action button');
  return 'section, empty hint, New…, global link, action button';
});

await check('port-forward dialog opens from the sidebar', async () => {
  assert(await clickText('New…', '.drawer button'), 'New… button missing');
  await waitFor(modalIs('Port forward'), 'port-forward dialog');
  assert((await count('.modal-body input')) >= 2, 'local/remote port inputs missing');
  assert(await bodyHas('kubectl'), 'missing kubectl explanation');
  await closeModal();
  await waitFor(`!document.querySelector('.modal-overlay')`, 'dialog to close');
  // Closing the dialog must leave the detail drawer in place.
  assert((await count('.drawer')) === 1, 'Escape/Cancel closed the detail drawer too');
  return 'local + remote ports, kubectl hint, drawer preserved';
});

await check('Escape closes only the dialog, keeping the detail drawer', async () => {
  assert(await clickText('New…', '.drawer button'), 'New… button missing');
  await waitFor(modalIs('Port forward'), 'port-forward dialog');
  await escape();
  await waitFor(`!document.querySelector('.modal-overlay')`, 'dialog to close');
  await sleep(120);
  assert((await count('.drawer')) === 1, 'Escape also closed the detail drawer');
  return 'dialog closed, drawer + selected resource preserved';
});

await check('global port-forward panel opens from the sidebar link', async () => {
  assert(await clickText('View every port forward →', '.drawer button'), 'sidebar link missing');
  await waitFor(modalStarts('Port forwards'), 'port-forward panel');
  assert(await bodyHas('No port forwards running'), 'empty panel state missing');
  assert(await bodyHas('Stop all'), 'Stop all button missing');
  await closeModal();
  await waitFor(`!document.querySelector('.modal-overlay')`, 'panel to close');
  return 'empty state + Stop all + Done';
});

/* ------------------------------------------- 4. port-forward state & Stop */

await check('port-forward errors are broadcast into the UI', async () => {
  const state = await evalJs(`window.kube.portForward.start({ clusterId: 'live:__kubepilot_verify_missing__', namespace: 'default', kind: 'pod', name: 'web-0', localPort: 18080, remotePort: 80 })`);
  assert(state.status === 'error', `expected an error state, got ${state.status}`);
  await waitFor(`[...document.querySelectorAll('.notice-title')].some(n => n.innerText === 'Port forward failed')`, 'port-forward error notification', 6000);
  const list = await evalJs(`window.kube.portForward.list()`);
  assert(list.some((f) => f.id === state.id), 'state was not kept in the main process');
  return state.error;
});

await check('duplicate local port is rejected before spawning kubectl', async () => {
  const state = await evalJs(`window.kube.portForward.start({ clusterId: 'live:kubepilot-mock', namespace: 'default', kind: 'pod', name: 'web-0', localPort: 18080, remotePort: 80 })`);
  assert(state.status === 'error', `expected an error state, got ${state.status}`);
  assert(/already used by/.test(state.error), `unexpected conflict message: ${state.error}`);
  await waitFor(`!!document.querySelector('.drawer .pf-badge')`, 'sidebar forward badge');
  assert((await count('.drawer .pf-list .pf-row')) === 1, 'sidebar should show exactly one forward');
  assert((await count('.drawer .pf-list .pf-row button')) >= 1, 'sidebar Stop button missing');
  assert(await bodyHas('already used by'), 'error reason not visible');
  await capture('port-forward-sidebar');
  return `sidebar badge + row + Stop for ${state.name}`;
});

await check('sidebar Stop removes the forward', async () => {
  assert(await click('.drawer .pf-list .pf-row button'), 'Stop button missing');
  await waitFor(`document.querySelectorAll('.drawer .pf-list .pf-row').length === 0`, 'sidebar row to disappear');
  assert(await bodyHas('No port forward is running'), 'empty hint did not return');
  return 'row removed, empty state restored';
});

await check('Stop all clears every remaining forward', async () => {
  assert(await clickText('View every port forward →', '.drawer button'), 'sidebar link missing');
  await waitFor(modalStarts('Port forwards'), 'port-forward panel');
  assert((await count('.pf-list .pf-row')) >= 1, 'remaining forwards not listed');
  assert(await clickText('Stop all', '.modal-footer button'), 'Stop all button missing');
  await waitFor(`!!document.querySelector('.pf-empty-title')`, 'panel empty state');
  const remaining = await evalJs(`window.kube.portForward.list()`);
  assert(remaining.length === 0, `${remaining.length} forwards left after Stop all`);
  const stopped = await evalJs(`window.kube.portForward.stopAll()`);
  assert(typeof stopped === 'number', `stopAll returned ${typeof stopped}`);
  await closeModal();
  await waitFor(`!document.querySelector('.modal-overlay')`, 'panel to close');
  return 'list empty, stopAll() returned a count';
});

/* ------------------------------------------------------ 5. close all tabs */

await check('tabs accumulate before a close-all', async () => {
  await clickText('Services', '.nav-item');
  await clickText('Deployments', '.nav-item');
  await sleep(300);
  const n = await count('.tab');
  assert(n >= 3, `only ${n} tabs open`);
  return `${n} tabs`;
});

await check('close all tabs clears tabs, drawer and dock', async () => {
  assert(await clickTitle('Close all tabs ('), 'close-all button missing');
  // The confirmation only appears when an unsaved YAML draft exists.
  const confirming = await evalJs(modalIs('Close all tabs?'));
  if (confirming) {
    assert(await clickText('Close all tabs', '.modal-footer button'), 'confirm button missing');
  }
  await waitFor(`document.querySelectorAll('.tab').length === 0`, 'tabs to close', 6000);
  assert((await count('.drawer')) === 0, 'detail drawer stayed open');
  return `cleared everything${confirming ? ' after confirmation' : ''}`;
});

await check('Ctrl+Shift+W is wired to close all tabs', async () => {
  await clickText('Pods', '.nav-item');
  await sleep(250);
  const before = await count('.tab');
  assert(before >= 1, 'could not open a tab');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 2 + 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await waitFor(`document.querySelectorAll('.tab').length === 0`, 'shortcut to close tabs', 5000);
  return 'shortcut closed the tab';
});

/* ---------------------------------------------------- 6. command palette */

await check('command palette exposes all four new actions', async () => {
  assert(await clickText('Ctrl+K', '.statusbar-item'), 'palette trigger missing');
  await waitFor(`!!document.querySelector('.palette-input input')`, 'palette input');
  const queries = [
    ['close all', 'Close all tabs'],
    ['kubeconfig', 'Paste / add kubeconfig'],
    ['port forward', 'Port forwards'],
    ['notification', 'Notifications'],
  ];
  for (const [query, expected] of queries) {
    assert(await setInput('.palette-input input', query), 'could not type into palette');
    await sleep(160);
    assert(await evalJs(`[...document.querySelectorAll('.palette-item')].some(e => e.textContent.includes(${js(expected)}))`), `missing palette action for "${query}"`);
  }
  assert(await closePalette(), 'palette did not close');
  return 'close all, paste kubeconfig, port forwards, notifications';
});

/* ------------------------------------------------------------- cleanup */

let cleanupNote = '';
try {
  if (importedPath) {
    await evalJs(`window.kube.kubeconfig.remove(${js(importedPath)})`);
    const after = await evalJs(`window.kube.kubeconfig.paths()`);
    cleanupNote = after.includes(importedPath)
      ? 'WARNING: imported kubeconfig was not removed'
      : 'imported kubeconfig removed';
  }
  await evalJs(`window.kube.portForward.stopAll()`);
} catch (error) {
  cleanupNote = `WARNING: cleanup failed — ${error.message}`;
}
console.log(`\nCleanup: ${cleanupNote || 'nothing to remove'}`);

ws.close();
mock.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
}
// The mock API holds long-lived watch sockets, so ending naturally would keep
// Node alive until the tool kills it. Exit explicitly with the real status.
process.exit(failed.length ? 1 : 0);
