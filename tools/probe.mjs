// Standalone wire-level probe: replicates exactly what KubeClient does for
// logs and exec, so we can see the status codes the app was swallowing.
// usage: node tools/probe.mjs <namespace> <pod> <container>
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { load } from 'js-yaml';

const [, , ns = 'default', pod, container = 'web'] = process.argv;
if (!pod) {
  console.error('usage: node tools/probe.mjs <namespace> <pod> [container]');
  process.exit(1);
}

const cfg = load(readFileSync(join(homedir(), '.kube', 'config'), 'utf8'));
const ctxName = cfg['current-context'];
const ctx = cfg.contexts.find((c) => c.name === ctxName).context;
const cluster = cfg.clusters.find((c) => c.name === ctx.cluster).cluster;
const user = cfg.users.find((u) => u.name === ctx.user).user;

const b64 = (s) => (s ? Buffer.from(s, 'base64') : undefined);
const server = cluster.server.replace(/\/+$/, '');
const tls = {
  ca: b64(cluster['certificate-authority-data']),
  cert: b64(user['client-certificate-data']),
  key: b64(user['client-key-data']),
};

function get(path, accept) {
  return new Promise((resolve) => {
    const url = new URL(server + path);
    const req = httpsRequest(
      url,
      { method: 'GET', headers: { Accept: accept, 'User-Agent': 'probe/1' }, ...tls },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            bytes: body.length,
            head: body.slice(0, 160).replace(/\n/g, '\\n'),
          });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

function execWs(accept) {
  return new Promise((resolve) => {
    const params = new URLSearchParams();
    for (const c of ['/bin/sh', '-c', 'echo PROBE_OK']) params.append('command', c);
    params.set('stdin', '1');
    params.set('stdout', '1');
    params.set('stderr', '1');
    params.set('tty', '1');
    params.set('container', container);
    const url = `${server.replace(/^http/, 'ws')}/api/v1/namespaces/${ns}/pods/${pod}/exec?${params}`;
    const out = [];
    const ws = new WebSocket(url, ['v5.channel.k8s.io', 'v4.channel.k8s.io'], {
      headers: { Accept: accept, 'User-Agent': 'probe/1' },
      ...tls,
      handshakeTimeout: 15000,
    });
    const done = (r) => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    ws.on('open', () => {
      setTimeout(() => {
        const text = out.map((b) => b.subarray(1).toString('utf8')).join('');
        done({ status: 101, protocol: ws.protocol, bytes: text.length, head: text.slice(0, 160).replace(/\n/g, '\\n') });
      }, 1500);
    });
    ws.on('message', (raw) => out.push(raw));
    ws.on('error', (e) => done({ status: 'ERR', error: e.message }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => done({ status: res.statusCode, error: body.slice(0, 200).replace(/\n/g, '\\n') }));
    });
  });
}

const logPath = `/api/v1/namespaces/${ns}/pods/${pod}/log?container=${container}&tailLines=5`;

console.log('server:', server);
console.log('\n== logs: Accept: text/plain  (what the app sends) ==');
console.log(await get(logPath, 'text/plain'));
console.log('\n== logs: Accept: */* ==');
console.log(await get(logPath, '*/*'));
console.log('\n== logs: Accept: application/json ==');
console.log(await get(logPath, 'application/json'));

console.log('\n== exec ws: Accept: application/json  (what the app sends) ==');
console.log(await execWs('application/json'));
console.log('\n== exec ws: Accept: */* ==');
console.log(await execWs('*/*'));
console.log('\n== exec ws: no Accept header ==');
console.log(await execWs(undefined));
