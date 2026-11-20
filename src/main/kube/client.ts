import { request as httpsRequest, Agent } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';
import type {
  DiscoveredResource,
  ExecRequest,
  KubeObject,
  LogRequest,
  NodeMetric,
  PodMetric,
  ResourceQuery,
  ResourceRef,
  WatchEventType,
} from '@shared/types';
import { resolveContext, runExecPlugin, type ResolvedAuth } from './config';

export class KubeApiError extends Error {
  status: number;
  reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Group/version prefix only. The resource segment is appended by buildPath so
 * the namespace always lands between the version and the plural, which is what
 * the API server expects: /api/v1/namespaces/{ns}/pods
 */
function apiBase(apiVersion: string): string {
  if (!apiVersion || apiVersion === 'v1') return '/api/v1';
  const [group, version] = apiVersion.split('/');
  return `/apis/${group}/${version}`;
}

export function buildPath(
  apiVersion: string,
  plural: string,
  namespaced: boolean,
  namespace?: string,
  name?: string,
): string {
  let path = apiBase(apiVersion);
  if (namespaced && namespace) path += `/namespaces/${encodeURIComponent(namespace)}`;
  path += `/${plural}`;
  if (name) path += `/${encodeURIComponent(name)}`;
  return path;
}

interface RequestOptions {
  method?: string;
  body?: string | Buffer | object;
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

export interface ExecHandlers {
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onError: (message: string) => void;
  onClose: (code?: number) => void;
}

/**
 * Metadata the API server owns. Sending any of it back in an apply patch is
 * rejected ("metadata.managedFields must be nil"), and `status` lives on a
 * subresource so it must not be part of the patch either.
 */
const SERVER_MANAGED_METADATA = [
  'managedFields',
  'resourceVersion',
  'uid',
  'creationTimestamp',
  'generation',
  'selfLink',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
];

/**
 * Returns a copy of `manifest` that is safe to send as an apply patch. The
 * editor dumps whole live objects, so callers cannot be trusted to strip the
 * server-managed fields themselves; the caller's object is never mutated.
 */
export function sanitizeForApply(manifest: KubeObject): KubeObject {
  const clone: KubeObject = JSON.parse(JSON.stringify(manifest ?? {}));
  if (clone.metadata && typeof clone.metadata === 'object') {
    for (const key of SERVER_MANAGED_METADATA) delete clone.metadata[key];
  }
  delete clone.status;
  return clone;
}

/** Shells to try, most common first. Distroless images have none of them. */
const SHELL_CANDIDATES = ['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh', '/usr/bin/sh', 'sh'];

/** Errors runc raises when the requested binary is not in the image. */
const MISSING_BINARY = /no such file or directory|executable file not found|not found/i;

export const NO_SHELL_MESSAGE = [
  'No shell found in this container.',
  '',
  `Tried: ${SHELL_CANDIDATES.join(', ')}`,
  '',
  'The image is most likely distroless or built FROM scratch, so there is',
  'nothing to open an interactive terminal with. Logs, YAML and Events',
  'still work for this pod.',
].join('\n');

export class KubeClient {
  readonly contextName: string;
  readonly server: string;
  readonly namespace?: string;
  private auth: ResolvedAuth;
  private kubeconfigPath: string;
  private agent?: Agent;

  constructor(contextName: string, kubeconfigPaths: string[]) {
    const resolved = resolveContext(contextName, kubeconfigPaths);
    this.contextName = resolved.name;
    this.namespace = resolved.namespace;
    this.auth = resolved.auth;
    this.server = resolved.auth.server.replace(/\/+$/, '');
    this.kubeconfigPath = resolved.kubeconfigPath;
    this.refreshAuth();
  }

  /** Exec plugins can rotate credentials; rebuild the TLS agent when they do. */
  private refreshAuth(): void {
    const auth = this.auth;
    if (auth.exec) {
      const cred = runExecPlugin(`${this.contextName}:${auth.exec.command}`, auth.exec);
      if (cred.token) auth.token = cred.token;
      if (cred.clientCertificateData) auth.certData = cred.clientCertificateData;
      if (cred.clientKeyData) auth.keyData = cred.clientKeyData;
    }
    this.agent = new Agent({
      keepAlive: true,
      ca: auth.caData,
      cert: auth.certData,
      key: auth.keyData,
      rejectUnauthorized: !auth.insecureSkipTlsVerify,
      servername: auth.tlsServerName,
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {    const h: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'kubepilot/0.1',
      ...extra,
    };
    if (this.auth.token) h.Authorization = `Bearer ${this.auth.token}`;
    else if (this.auth.username) {
      const raw = `${this.auth.username}:${this.auth.password ?? ''}`;
      h.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
    }
    return h;
  }

  /** TLS material for raw https / websocket clients (watch, exec, logs). */
  tlsOptions() {
    return {
      agent: this.agent,
      ca: this.auth.caData,
      cert: this.auth.certData,
      key: this.auth.keyData,
      rejectUnauthorized: !this.auth.insecureSkipTlsVerify,
      servername: this.auth.tlsServerName,
    };
  }

  authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return this.headers(extra);
  }

  private url(path: string, query?: RequestOptions['query']): URL {
    const url = new URL(this.server + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  /** Low-level JSON request used by every higher level helper. */
  request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, contentType, query, timeout = 30_000 } = options;
    const url = this.url(path, query);
    const isHttps = url.protocol === 'https:';
    let payload: Buffer | undefined;
    const headers = this.headers();

    if (body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        payload = Buffer.from(body);
      } else {
        payload = Buffer.from(JSON.stringify(body));
      }
      headers['Content-Type'] = contentType ?? 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    const send = isHttps ? httpsRequest : httpRequest;
    const reqOptions: any = {
      method,
      headers,
      timeout,
    };
    if (isHttps) {
      reqOptions.agent = this.agent;
      reqOptions.rejectUnauthorized = !this.auth.insecureSkipTlsVerify;
      if (this.auth.caData) reqOptions.ca = this.auth.caData;
    }

    return new Promise<T>((resolve, reject) => {
      const req = send(url, reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            let message = text || `HTTP ${status}`;
            let reason: string | undefined;
            try {
              const parsed = JSON.parse(text);
              message = parsed.message ?? message;
              reason = parsed.reason;
            } catch {
              /* non JSON error body */
            }
            // The path is part of the diagnosis: most 404/405s come from a
            // missing namespace segment rather than from the object itself.
            reject(new KubeApiError(status, `${method} ${path}: ${message}`, reason));
            return;
          }
          if (!text) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            resolve(text as unknown as T);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Request to ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async version(): Promise<string> {
    const v = await this.request<{ gitVersion: string }>('/version');
    return v?.gitVersion ?? 'unknown';
  }

  async namespaces(): Promise<{ items: string[]; forbidden: boolean }> {
    try {
      const res = await this.request<{ items: KubeObject[] }>('/api/v1/namespaces?limit=500');
      const items = (res.items ?? []).map((n) => n.metadata.name).sort();
      return { items, forbidden: false };
    } catch (err) {
      if (err instanceof KubeApiError && (err.status === 403 || err.status === 401)) {
        return { items: [], forbidden: true };
      }
      throw err;
    }
  }

  async list(query: ResourceQuery): Promise<{ items: KubeObject[]; resourceVersion?: string }> {
    const path = buildPath(query.apiVersion, query.plural, query.namespaced, query.namespace);
    const res = await this.request<{ items: KubeObject[]; metadata?: { resourceVersion?: string } }>(
      path,
      {
        query: {
          limit: query.limit,
          labelSelector: query.labelSelector,
          fieldSelector: query.fieldSelector,
        },
        timeout: 60_000,
      },
    );
    return { items: res?.items ?? [], resourceVersion: res?.metadata?.resourceVersion };
  }

  async get(ref: ResourceRef): Promise<KubeObject> {
    const path = buildPath(ref.apiVersion, ref.plural, ref.namespaced, ref.namespace, ref.name);
    return this.request<KubeObject>(path);
  }

  async remove(ref: ResourceRef, propagation: 'Foreground' | 'Background' | 'Orphan' = 'Background') {
    const path = buildPath(ref.apiVersion, ref.plural, ref.namespaced, ref.namespace, ref.name);
    return this.request(path, { method: 'DELETE', query: { propagationPolicy: propagation } });
  }

  /** Server-side apply. Works for both create and update. */
  async apply(manifest: KubeObject, plural: string, namespaced: boolean): Promise<KubeObject> {
    const apiVersion = manifest.apiVersion;
    const name = manifest.metadata?.name;
    // A namespaced manifest without metadata.namespace would be sent to the
    // cluster-scoped path, which the API server rejects with 405. Fall back to
    // the kubeconfig context namespace, the same way kubectl does.
    const namespace = namespaced
      ? (manifest.metadata?.namespace ?? this.namespace ?? 'default')
      : undefined;
    const path = buildPath(apiVersion, plural, namespaced, namespace, name);
    const body = JSON.stringify(sanitizeForApply(manifest));
    try {
      return await this.request(path, {
        method: 'PATCH',
        body,
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: 'kubepilot', force: 'true' },
      });
    } catch (err) {
      if (err instanceof KubeApiError && err.status === 404) {
        const createPath = buildPath(apiVersion, plural, namespaced, namespace);
        return this.request(createPath, { method: 'POST', body });
      }
      throw err;
    }
  }

  async patch(
    ref: ResourceRef,
    body: string | object,
    type: 'merge' | 'json' = 'merge',
    subresource?: string,
  ): Promise<KubeObject> {
    let path = buildPath(ref.apiVersion, ref.plural, ref.namespaced, ref.namespace, ref.name);
    if (subresource) path += `/${subresource}`;
    return this.request(path, {
      method: 'PATCH',
      body,
      contentType: type === 'merge' ? 'application/merge-patch+json' : 'application/json-patch+json',
    });
  }

  async scale(ref: ResourceRef, replicas: number): Promise<KubeObject> {
    return this.patch(ref, { spec: { replicas } }, 'merge', 'scale');
  }

  async rolloutRestart(ref: ResourceRef): Promise<KubeObject> {
    const now = new Date().toISOString();
    return this.patch(ref, {
      spec: {
        template: {
          metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now } },
        },
      },
    });
  }

  async podMetrics(): Promise<PodMetric[]> {
    const res = await this.request<{ items: any[] }>('/apis/metrics.k8s.io/v1beta1/pods');
    return (res?.items ?? []).map((item) => {
      let cpu = 0;
      let memory = 0;
      const containers = (item.containers ?? []).map((c: any) => {
        const cCpu = parseCpu(c.usage?.cpu);
        const cMem = parseMemory(c.usage?.memory);
        cpu += cCpu;
        memory += cMem;
        return { name: c.name, cpu: cCpu, memory: cMem };
      });
      return {
        namespace: item.metadata?.namespace,
        name: item.metadata?.name,
        containers,
        cpu,
        memory,
        timestamp: item.timestamp,
      };
    });
  }

  async nodeMetrics(): Promise<NodeMetric[]> {
    const res = await this.request<{ items: any[] }>('/apis/metrics.k8s.io/v1beta1/nodes');
    return (res?.items ?? []).map((item) => ({
      name: item.metadata?.name,
      cpu: parseCpu(item.usage?.cpu),
      memory: parseMemory(item.usage?.memory),
      timestamp: item.timestamp,
    }));
  }

  /**
   * Streams a pod log. Returns a stop function. `follow` uses the kube watch
   * style chunked response, so we reconnect on transient drops.
   */
  streamLogs(req: LogRequest, onChunk: (text: string) => void, onEnd: (err?: string) => void): () => void {
    let stopped = false;
    let req$: ReturnType<typeof httpsRequest> | undefined;

    const start = () => {
      const path = `/api/v1/namespaces/${encodeURIComponent(req.namespace)}/pods/${encodeURIComponent(
        req.pod,
      )}/log`;
      const url = this.url(path, {
        container: req.container,
        follow: req.follow ? 1 : undefined,
        tailLines: req.tailLines,
        previous: req.previous ? 1 : undefined,
        timestamps: req.timestamps ? 1 : undefined,
      });
      const isHttps = url.protocol === 'https:';
      const send = isHttps ? httpsRequest : httpRequest;
      // The log endpoint negotiates media types strictly: a concrete `Accept`
      // such as text/plain is rejected with 406. `*/*` is what kubectl sends.
      const opts: any = { method: 'GET', headers: this.headers({ Accept: '*/*' }) };
      if (isHttps) {
        opts.agent = this.agent;
        opts.rejectUnauthorized = !this.auth.insecureSkipTlsVerify;
        if (this.auth.caData) opts.ca = this.auth.caData;
      }
      req$ = send(url, opts, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            let msg = body;
            try {
              msg = JSON.parse(body).message ?? body;
            } catch {
              /* plain text */
            }
            onEnd(msg || `HTTP ${status}`);
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!stopped) onChunk(chunk);
        });
        res.on('end', () => {
          if (!stopped) onEnd();
        });
        res.on('error', (e) => {
          if (!stopped) onEnd(String(e));
        });
      });
      req$.on('error', (e) => {
        if (!stopped) onEnd(String(e));
      });
      req$.end();
    };

    start();
    return () => {
      stopped = true;
      req$?.destroy();
    };
  }

  /**
   * Runs a short, non-interactive exec and reports whether the binary exists.
   * The container runtime answers "no such file or directory" when it does not.
   */
  private probeBinary(req: ExecRequest, argv: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const base = this.server.replace(/^http/, 'ws');
      const params = new URLSearchParams();
      for (const arg of argv) params.append('command', arg);
      params.set('stdout', '1');
      params.set('stderr', '1');
      if (req.container) params.set('container', req.container);
      const url = `${base}/api/v1/namespaces/${encodeURIComponent(req.namespace)}/pods/${encodeURIComponent(
        req.pod,
      )}/exec?${params.toString()}`;

      let settled = false;
      const ws = new WebSocket(url, ['v5.channel.k8s.io', 'v4.channel.k8s.io'], {
        headers: this.headers({ Accept: '*/*' }),
        ca: this.auth.caData,
        cert: this.auth.certData,
        key: this.auth.keyData,
        rejectUnauthorized: !this.auth.insecureSkipTlsVerify,
        servername: this.auth.tlsServerName,
        handshakeTimeout: 10_000,
      } as any);

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 6_000);

      ws.on('message', (raw: Buffer) => {
        if (!raw?.length || raw[0] !== 3) return; // channel 3 carries the status frame
        const text = raw.subarray(1).toString('utf8').trim();
        if (!text) return;
        try {
          const status = JSON.parse(text);
          if (status.status === 'Success') return finish(true);
          finish(!MISSING_BINARY.test(String(status.message ?? status.reason ?? text)));
        } catch {
          finish(!MISSING_BINARY.test(text));
        }
      });
      ws.on('close', () => finish(true));
      ws.on('error', () => finish(false));
    });
  }

  /** First shell that actually exists in the container, or null. */
  async resolveShell(req: ExecRequest): Promise<string | null> {
    for (const shell of SHELL_CANDIDATES) {
      if (await this.probeBinary(req, [shell, '-c', 'exit 0'])) return shell;
    }
    return null;
  }

  /** Opens an interactive exec session using the WebSocket channel protocol. */
  async exec(req: ExecRequest, handlers: ExecHandlers): Promise<{
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    close: () => void;
  }> {
    // An explicit command wins; otherwise find a shell the image actually has.
    let command = req.command?.length ? req.command : undefined;
    if (!command) {
      const shell = await this.resolveShell(req);
      if (!shell) throw new KubeApiError(0, NO_SHELL_MESSAGE);
      // `clear` is optional; `exec` replaces the wrapper so signals reach the shell.
      command = [shell, '-c', `command -v clear >/dev/null 2>&1 && clear; exec ${shell}`];
    }

    const base = this.server.replace(/^http/, 'ws');
    const params = new URLSearchParams();
    for (const c of command) params.append('command', c);
    params.set('stdin', '1');
    params.set('stdout', '1');
    params.set('stderr', '1');
    if (req.tty !== false) params.set('tty', '1');
    if (req.container) params.set('container', req.container);
    const url = `${base}/api/v1/namespaces/${encodeURIComponent(req.namespace)}/pods/${encodeURIComponent(
      req.pod,
    )}/exec?${params.toString()}`;

    const ws = new WebSocket(url, ['v5.channel.k8s.io', 'v4.channel.k8s.io'], {
      // Same negotiation trap as logs: the exec route only accepts `*/*`.
      headers: this.headers({ Accept: '*/*' }),
      ca: this.auth.caData,
      cert: this.auth.certData,
      key: this.auth.keyData,
      rejectUnauthorized: !this.auth.insecureSkipTlsVerify,
      servername: this.auth.tlsServerName,
      handshakeTimeout: 20_000,
    } as any);

    const decoder = new TextDecoder();
    ws.on('message', (raw: Buffer) => {
      if (!raw?.length) return;
      const channel = raw[0];
      const payload = raw.subarray(1);
      if (channel === 1) handlers.onData('stdout', decoder.decode(payload));
      else if (channel === 2) handlers.onData('stderr', decoder.decode(payload));
      else if (channel === 3) {
        // Channel 3 carries a metav1.Status frame. A command that simply ends
        // sends {"status":"Success"}, which must not be painted as an error.
        const text = decoder.decode(payload).trim();
        if (!text) return;
        try {
          const status = JSON.parse(text);
          if (status.status === 'Success') return;
          handlers.onError(String(status.message || status.reason || text));
        } catch {
          handlers.onError(text);
        }
      }
    });
    ws.on('error', (err) => handlers.onError(err.message));
    ws.on('close', (code) => handlers.onClose(code));

    const send = (channel: number, data: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(Buffer.concat([Buffer.from([channel]), data]));
    };

    return {
      write: (d: string) => send(0, Buffer.from(d, 'utf8')),
      resize: (cols: number, rows: number) =>
        send(4, Buffer.from(JSON.stringify({ Width: cols, Height: rows }))),
      close: () => ws.close(),
    };
  }

  /** Walks `/api` + `/apis` to learn every kind the server exposes. */
  async discovery(): Promise<DiscoveredResource[]> {
    const out: DiscoveredResource[] = [];
    const seen = new Set<string>();
    const add = (list: any, apiVersion: string) => {
      for (const r of list?.resources ?? []) {
        if (r.name.includes('/')) continue; // subresources
        const key = `${apiVersion}:${r.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: r.kind,
          apiVersion,
          plural: r.name,
          namespaced: Boolean(r.namespaced),
          verbs: r.verbs ?? [],
          group: apiVersion.includes('/') ? apiVersion.split('/')[0] : '',
          custom: apiVersion.includes('/') && !BUILTIN_GROUPS.has(apiVersion.split('/')[0]),
        });
      }
    };

    const core = await this.request<any>('/api/v1');
    add(core, 'v1');

    const groups = await this.request<any>('/apis');
    const groupList: any[] = groups?.groups ?? [];
    await Promise.all(
      groupList.map(async (g) => {
        const preferred = g.preferredVersion?.groupVersion;
        if (!preferred) return;
        try {
          const list = await this.request<any>(`/apis/${preferred}`);
          add(list, preferred);
        } catch {
          /* skip groups we cannot read */
        }
      }),
    );
    return out;
  }
}

const BUILTIN_GROUPS = new Set([
  'apps',
  'batch',
  'autoscaling',
  'policy',
  'networking.k8s.io',
  'storage.k8s.io',
  'rbac.authorization.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'admissionregistration.k8s.io',
  'coordination.k8s.io',
  'discovery.k8s.io',
  'events.k8s.io',
  'node.k8s.io',
  'scheduling.k8s.io',
  'certificates.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'metrics.k8s.io',
]);

/** `"250m"` -> 250 (millicores). `"2"` -> 2000. */
export function parseCpu(value: string | undefined): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number.parseFloat(value) / 1_000_000;
  if (value.endsWith('u')) return Number.parseFloat(value) / 1000;
  if (value.endsWith('m')) return Number.parseFloat(value);
  return Number.parseFloat(value) * 1000;
}

/** `"128Mi"` -> bytes. */
export function parseMemory(value: string | undefined): number {
  if (!value) return 0;
  const units: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  const match = value.match(/^([\d.]+)([A-Za-z]*)$/);
  if (!match) return 0;
  const n = Number.parseFloat(match[1]);
  const unit = match[2] || '';
  return n * (units[unit] ?? 1);
}

export interface WatchHandle {
  stop: () => void;
}

/**
 * Watch helper with automatic reconnection. Kubernetes closes watches after a
 * while (and on API server restarts); KubePilot keeps them alive transparently.
 */
export function watchResource(
  client: KubeClient,
  query: ResourceQuery,
  onEvent: (type: WatchEventType, object: KubeObject) => void,
  onError?: (message: string) => void,
): WatchHandle {
  let stopped = false;
  let current: ReturnType<typeof httpsRequest> | undefined;
  let resourceVersion: string | undefined;
  let retries = 0;

  const connect = async () => {
    if (stopped) return;
    const path = buildPath(query.apiVersion, query.plural, query.namespaced, query.namespace);
    const url = new URL(client.server + path);
    url.searchParams.set('watch', '1');
    url.searchParams.set('allowWatchBookmarks', 'true');
    if (resourceVersion) url.searchParams.set('resourceVersion', resourceVersion);
    if (query.labelSelector) url.searchParams.set('labelSelector', query.labelSelector);
    if (query.fieldSelector) url.searchParams.set('fieldSelector', query.fieldSelector);

    const isHttps = url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;
    const opts: any = {
      method: 'GET',
      headers: client.authHeaders({ Accept: 'application/json' }),
      timeout: 0,
    };
    if (isHttps) {
      const tls = client.tlsOptions();
      opts.agent = tls.agent;
      opts.rejectUnauthorized = tls.rejectUnauthorized;
      if (tls.ca) opts.ca = tls.ca;
    }

    current = send(url, opts, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          onError?.(body || `Watch failed with HTTP ${res.statusCode}`);
          scheduleRetry();
        });
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'ERROR') {
              onError?.(parsed.object?.message ?? 'watch error');
              continue;
            }
            resourceVersion = parsed.object?.metadata?.resourceVersion ?? resourceVersion;
            retries = 0;
            onEvent(parsed.type, parsed.object);
          } catch {
            /* ignore partial frames */
          }
        }
      });
      res.on('end', () => scheduleRetry());
      res.on('error', () => scheduleRetry());
    });
    current.on('error', () => scheduleRetry());
    current.end();
  };

  const scheduleRetry = () => {
    if (stopped) return;
    retries += 1;
    if (retries > 6) {
      onError?.('Watch stopped after repeated failures');
      return;
    }
    const delay = Math.min(500 * 2 ** (retries - 1), 8000);
    setTimeout(connect, delay);
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      current?.destroy();
    },
  };
}
