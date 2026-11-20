// End-to-end check of every IPC surface against a real cluster.
// usage: node tools/e2e-live.mjs [port]
//
// Structure:
//   1. suite   - connect, discovery, CRUD, watch, workload, logs, exec, metrics
//                (leaves the test deployment running so port-forward has a target)
//   2. tunnel  - start a port-forward and fetch a real HTTP response through it
//   3. cleanup - delete test resources, disconnect
import WebSocket from 'ws';

const port = process.argv[2] ?? '9222';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

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
  const m = JSON.parse(raw.toString());
  const s = pending.get(m.id);
  if (!s) return;
  pending.delete(m.id);
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result);
});
await new Promise((r) => ws.on('open', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails).slice(0, 800));
  }
  return out.result.value;
}

const suite = String.raw`
(async () => {
  const k = window.kube;
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  const attempt = async (name, fn) => {
    try {
      const value = await fn();
      rec(name, true, value);
      return value;
    } catch (error) {
      rec(name, false, String(error && error.message ? error.message : error));
      return undefined;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 1. clusters ----------
  const clusters = await attempt('clusters.list', () => k.clusters.list());
  const live = (clusters || []).find((c) => c.kind !== 'demo');
  if (!live) {
    rec('clusters.list:live', false, 'no non-demo cluster found');
    return { results, liveId: null };
  }
  rec('clusters.list:live', true, { id: live.id, name: live.displayName, server: live.server });

  const state = await attempt('clusters.connect', () => k.clusters.connect(live.id));
  if (state) {
    rec('clusters.connect:status', state.status === 'connected', {
      status: state.status,
      version: state.version,
      error: state.error,
      resources: (state.resources || []).length,
      custom: (state.resources || []).filter((r) => r.custom).length,
    });
  }

  await attempt('kubeconfig.paths', () => k.kubeconfig.paths());

  // ---------- 2. discovery ----------
  const resources = (state && state.resources) || [];
  const hasCore = resources.some((r) => r.plural === 'pods' && r.apiVersion === 'v1');
  const hasApps = resources.some((r) => r.plural === 'deployments' && r.apiVersion === 'apps/v1');
  rec('discovery:core-kinds', hasCore && hasApps, {
    total: resources.length,
    sample: resources.slice(0, 6).map((r) => r.apiVersion + '/' + r.plural),
  });

  const kind = (plural) => resources.find((r) => r.plural === plural);

  // ---------- 3. list ----------
  for (const plural of ['namespaces', 'nodes', 'pods', 'deployments', 'services', 'configmaps']) {
    const def = kind(plural);
    if (!def) { rec('list:' + plural, false, 'kind not discovered'); continue; }
    await attempt('list:' + plural, async () => {
      const res = await k.resources.list({
        clusterId: live.id,
        apiVersion: def.apiVersion,
        plural: def.plural,
        namespaced: def.namespaced,
        namespace: def.namespaced ? 'default' : undefined,
      });
      return { items: res.items.length, rv: res.resourceVersion ? 'yes' : 'no' };
    });
  }

  // ---------- 4. get ----------
  const podList = await k.resources.list({
    clusterId: live.id, apiVersion: 'v1', plural: 'pods', namespaced: true, namespace: 'kube-system',
  }).catch(() => ({ items: [] }));
  const anyPod = podList.items[0];
  if (anyPod) {
    await attempt('resources.get', async () => {
      const obj = await k.resources.get({
        clusterId: live.id, apiVersion: 'v1', plural: 'pods', kind: 'Pod', namespaced: true,
        namespace: anyPod.metadata.namespace, name: anyPod.metadata.name,
      });
      return { name: obj.metadata.name, containers: (obj.spec?.containers || []).length };
    });
  } else {
    rec('resources.get', false, 'no pods in kube-system');
  }

  // ---------- 5. apply ----------
  const cmName = 'kubepilot-e2e-' + Date.now().toString(36);
  const cmYaml = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: ' + cmName,
    '  namespace: default',
    'data:',
    '  hello: world',
  ].join('\n');

  await attempt('resources.applyYaml (create cm)', async () => {
    const out = await k.resources.applyYaml({ clusterId: live.id, yaml: cmYaml });
    return out;
  });

  await attempt('resources.get (created cm)', async () => {
    const obj = await k.resources.get({
      clusterId: live.id, apiVersion: 'v1', plural: 'configmaps', kind: 'ConfigMap', namespaced: true,
      namespace: 'default', name: cmName,
    });
    return { data: obj.data };
  });

  // ---------- 6. watch ----------
  await attempt('watch:start+event', async () => {
    const all = [];
    const off = k.watch.onEvent((e) => all.push(e));
    const watchId = await k.watch.start({
      clusterId: live.id, apiVersion: 'v1', plural: 'configmaps', namespaced: true, namespace: 'default',
    });
    await sleep(1200);
    const updated = cmYaml.replace('hello: world', 'hello: changed');
    await k.resources.applyYaml({ clusterId: live.id, yaml: updated });
    await sleep(2500);
    await k.watch.stop(watchId);
    off();
    // the UI runs its own watches on the same channel; only count ours
    const events = all.filter((e) => e.watchId === watchId);
    if (!events.some((e) => e.type === 'MODIFIED')) {
      throw new Error('no MODIFIED for our watch; saw ' + JSON.stringify(events.map((e) => e.type).slice(0, 8)));
    }
    return { events: events.map((e) => e.type), count: events.length, otherWatches: all.length - events.length };
  });

  // ---------- 7. workload ----------
  const depName = 'kubepilot-e2e-' + Date.now().toString(36);
  const depYaml = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: ' + depName,
    '  namespace: default',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    '      app: ' + depName,
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: ' + depName,
    '    spec:',
    '      containers:',
    '        - name: web',
    '          image: busybox:1.36',
    // Serves HTTP on 8080 so port-forward has a real listener, and logs a
    // heartbeat so the log stream has something to deliver.
    '          command: ["sh", "-c", "echo kubepilot-http-ok > /tmp/index.html; httpd -f -p 8080 -h /tmp & while true; do echo kubepilot-heartbeat; sleep 3; done"]',
    '          ports:',
    '            - containerPort: 8080',
  ].join('\n');

  await attempt('apply deployment', async () => {
    const out = await k.resources.applyYaml({ clusterId: live.id, yaml: depYaml });
    return out.map((r) => ({ kind: r.kind, name: r.name, ok: r.ok !== false }));
  });

  await attempt('resources.scale -> 2', async () => {
    const obj = await k.resources.scale(
      { clusterId: live.id, apiVersion: 'apps/v1', plural: 'deployments', kind: 'Deployment', namespaced: true, namespace: 'default', name: depName },
      2,
    );
    return { replicas: obj.spec?.replicas };
  });

  await attempt('resources.restart', async () => {
    const obj = await k.resources.restart(
      { clusterId: live.id, apiVersion: 'apps/v1', plural: 'deployments', kind: 'Deployment', namespaced: true, namespace: 'default', name: depName },
    );
    const tpl = obj.spec?.template?.metadata?.annotations || {};
    return { restartedAt: tpl['kubectl.kubernetes.io/restartedAt'] || null };
  });

  // Wait for a pod that is actually Running with a ready container: logs and
  // exec both fail on a ContainerCreating pod.
  let target;
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    const list = await k.resources.list({
      clusterId: live.id, apiVersion: 'v1', plural: 'pods', namespaced: true, namespace: 'default',
    }).catch(() => ({ items: [] }));
    target = list.items.find((p) => (p.metadata.labels || {}).app === depName);
    const statuses = target?.status?.containerStatuses || [];
    ready = target?.status?.phase === 'Running' && statuses.length > 0 && statuses.every((c) => c.ready);
    if (ready) break;
    await sleep(1500);
  }
  rec('deployment pod scheduled+ready', !!target && ready, target ? target.metadata.name + ' phase=' + target.status?.phase : 'none within 60s');

  // ---------- 8. logs ----------
  if (target) {
    await attempt('logs:start+data', async () => {
      const chunks = [];
      let endError;
      const offData = k.logs.onData((p) => chunks.push(p.text));
      const offEnd = k.logs.onEnd((p) => { if (p.error) endError = p.error; });
      const streamId = await k.logs.start({
        clusterId: live.id, namespace: target.metadata.namespace, pod: target.metadata.name,
        container: target.spec.containers[0].name, follow: true, tailLines: 20,
      });
      await sleep(4000);
      await k.logs.stop(streamId);
      offData();
      offEnd();
      const text = chunks.join('');
      if (endError) throw new Error('stream error: ' + endError);
      if (!text.length) throw new Error('stream produced no data');
      return { bytes: text.length, sample: text.slice(0, 120).replace(/\n/g, '\\n') };
    });
  }

  // ---------- 9. exec ----------
  if (target) {
    await attempt('exec:start+write+read', async () => {
      const out = [];
      const offData = k.exec.onData((p) => out.push(p.data));
      const sessionId = await k.exec.start({
        clusterId: live.id, namespace: target.metadata.namespace, pod: target.metadata.name,
        container: target.spec.containers[0].name, cols: 100, rows: 30,
        command: ['/bin/sh', '-c', 'clear; exec /bin/sh'],
      });
      await sleep(1200);
      await k.exec.write(sessionId, 'echo kubepilot-exec-ok\n');
      await sleep(2000);
      await k.exec.resize(sessionId, 120, 40);
      await sleep(400);
      await k.exec.close(sessionId);
      offData();
      const text = out.join('');
      if (!text.includes('kubepilot-exec-ok')) {
        throw new Error('marker missing; got: ' + JSON.stringify(text.slice(0, 160)));
      }
      return { bytes: text.length, hasMarker: true, sample: text.slice(0, 160).replace(/\n/g, '\\n') };
    });
  }

  // ---------- 10. metrics ----------
  await attempt('metrics:pods', async () => {
    const m = await k.metrics.pods(live.id);
    return { count: m.length, note: m.length ? undefined : 'metrics-server not installed' };
  });
  await attempt('metrics:nodes', async () => {
    const m = await k.metrics.nodes(live.id);
    return { count: m.length, note: m.length ? undefined : 'metrics-server not installed' };
  });

  // The deployment is left running: port-forward needs a live target.
  return {
    results,
    liveId: live.id,
    dep: target ? { name: depName, pod: target.metadata.name, namespace: target.metadata.namespace } : { name: depName },
    cm: cmName,
  };
})()
`;

const { results: rows, liveId, dep, cm } = await evaluate(suite);
if (!liveId) {
  console.error('no live cluster found');
  ws.close();
  process.exit(1);
}

// ---------- port forward: fetch a real HTTP response through the tunnel ----------
const PF_LOCAL = 18080;
const PF_REMOTE = 8080;
try {
  const req = {
    clusterId: liveId,
    namespace: dep?.namespace ?? 'default',
    kind: 'pod',
    name: dep?.pod,
    localPort: PF_LOCAL,
    remotePort: PF_REMOTE,
  };
  const started = await evaluate(`window.kube.portForward.start(${JSON.stringify(req)})`);
  await sleep(4000);

  const list = await evaluate('window.kube.portForward.list()');
  const entry = list.find((p) => p.id === started.id);
  rows.push({
    name: 'portForward:status active',
    ok: entry?.status === 'active',
    detail: { status: entry?.status, error: entry?.error, id: started.id },
  });

  // A real HTTP request proves bytes actually traverse the tunnel.
  let http;
  try {
    const res = await fetch(`http://127.0.0.1:${PF_LOCAL}/`, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    http = { status: res.status, body: body.trim().slice(0, 40) };
    rows.push({ name: 'portForward:http-through-tunnel', ok: res.status === 200 && body.includes('kubepilot-http-ok'), detail: http });
  } catch (error) {
    rows.push({ name: 'portForward:http-through-tunnel', ok: false, detail: String(error.message ?? error) });
  }

  await evaluate(`window.kube.portForward.stop(${JSON.stringify(started.id)})`);
  await sleep(800);
  const after = await evaluate('window.kube.portForward.list()');
  rows.push({
    name: 'portForward:stop',
    ok: !after.some((p) => p.id === started.id),
    detail: { remaining: after.length },
  });
} catch (error) {
  rows.push({ name: 'portForward', ok: false, detail: String(error.message ?? error) });
}

// ---------- cleanup ----------
const cleanup = String.raw`
(async () => {
  const k = window.kube;
  const out = [];
  const go = async (label, fn) => {
    try { await fn(); out.push({ name: label, ok: true, detail: true }); }
    catch (e) { out.push({ name: label, ok: false, detail: String(e && e.message ? e.message : e) }); }
  };
  await go('delete deployment', () => k.resources.remove({
    clusterId: __LIVE__, apiVersion: 'apps/v1', plural: 'deployments', kind: 'Deployment',
    namespaced: true, namespace: 'default', name: __DEP__, propagation: 'Background',
  }));
  await go('delete configmap', () => k.resources.remove({
    clusterId: __LIVE__, apiVersion: 'v1', plural: 'configmaps', kind: 'ConfigMap',
    namespaced: true, namespace: 'default', name: __CM__, propagation: 'Background',
  }));
  await go('clusters.disconnect', () => k.clusters.disconnect(__LIVE__));
  return out;
})()
`
  .replaceAll('__LIVE__', JSON.stringify(liveId))
  .replaceAll('__DEP__', JSON.stringify(dep?.name ?? ''))
  .replaceAll('__CM__', JSON.stringify(cm ?? ''));

try {
  rows.push(...(await evaluate(cleanup)));
} catch (error) {
  rows.push({ name: 'cleanup', ok: false, detail: String(error.message ?? error) });
}

let failures = 0;
for (const row of rows) {
  const mark = row.ok ? 'PASS' : 'FAIL';
  if (!row.ok) failures += 1;
  const detail = typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail);
  console.log(`${mark}  ${row.name.padEnd(34)} ${detail ?? ''}`);
}
console.log(`\n${rows.length - failures}/${rows.length} passed`);
ws.close();
