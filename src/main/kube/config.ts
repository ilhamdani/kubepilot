import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';
import type { ClusterInfo } from '@shared/types';

export interface ExecAuthConfig {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  apiVersion?: string;
  installHint?: string;
}

export interface ResolvedAuth {
  server: string;
  caData?: string;
  certData?: string;
  keyData?: string;
  token?: string;
  username?: string;
  password?: string;
  insecureSkipTlsVerify?: boolean;
  exec?: ExecAuthConfig;
  proxyUrl?: string;
  tlsServerName?: string;
}

export interface ResolvedContext {
  name: string;
  namespace?: string;
  auth: ResolvedAuth;
  kubeconfigPath: string;
}

interface KubeconfigFile {
  clusters?: Array<{ name: string; cluster: Record<string, any> }>;
  contexts?: Array<{ name: string; context: Record<string, any> }>;
  users?: Array<{ name: string; user: Record<string, any> }>;
  'current-context'?: string;
}

/** `~/.kube/config` plus anything in `KUBECONFIG`, de-duplicated. */
export function defaultKubeconfigPaths(extra: string[] = []): string[] {
  const candidates: string[] = [];
  const env = process.env.KUBECONFIG;
  if (env) candidates.push(...env.split(delimiter).filter(Boolean));
  candidates.push(join(homedir(), '.kube', 'config'));
  candidates.push(...extra);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const abs = resolve(expandHome(c));
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (existsSync(abs)) out.push(abs);
  }
  return out;
}

export function expandHome(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  return p;
}

function readData(value: string | undefined, file: string | undefined): string | undefined {
  if (value) return Buffer.from(value, 'base64').toString('utf8');
  if (file) {
    const p = expandHome(file);
    if (!existsSync(p)) return undefined;
    return readFileSync(p, 'utf8');
  }
  return undefined;
}

function readRaw(value: string | undefined, file: string | undefined): string | undefined {
  if (value) return value;
  if (file) {
    const p = expandHome(file);
    if (!existsSync(p)) return undefined;
    return readFileSync(p, 'utf8');
  }
  return undefined;
}

export interface LoadedKubeconfig {
  path: string;
  data: KubeconfigFile;
}

export function readKubeconfigs(paths: string[]): LoadedKubeconfig[] {
  const out: LoadedKubeconfig[] = [];
  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf8');
      const data = load(raw) as KubeconfigFile;
      if (data && typeof data === 'object') out.push({ path: p, data });
    } catch {
      // A malformed kubeconfig should not take the whole app down.
    }
  }
  return out;
}

/** Flatten every kubeconfig into a list of connectable clusters. */
export function listClusters(paths: string[]): ClusterInfo[] {
  const clusters: ClusterInfo[] = [];
  for (const { path, data } of readKubeconfigs(paths)) {
    const clusterByName = new Map((data.clusters ?? []).map((c) => [c.name, c.cluster]));
    for (const ctx of data.contexts ?? []) {
      const ctxCluster = clusterByName.get(ctx.context?.cluster);
      if (!ctxCluster?.server) continue;
      clusters.push({
        id: `live:${ctx.name}`,
        name: ctx.name,
        displayName: ctx.name,
        server: ctxCluster.server,
        userName: ctx.context?.user,
        namespace: ctx.context?.namespace ?? 'default',
        kubeconfigPath: path,
      });
    }
  }
  return clusters;
}

export function resolveContext(clusterId: string, paths: string[]): ResolvedContext {
  const contextName = clusterId.startsWith('live:') ? clusterId.slice(5) : clusterId;
  for (const { path, data } of readKubeconfigs(paths)) {
    const ctx = (data.contexts ?? []).find((c) => c.name === contextName);
    if (!ctx) continue;
    const cluster = (data.clusters ?? []).find((c) => c.name === ctx.context?.cluster)?.cluster;
    const user = (data.users ?? []).find((u) => u.name === ctx.context?.user)?.user;
    if (!cluster) continue;

    const auth: ResolvedAuth = {
      server: cluster.server,
      insecureSkipTlsVerify: Boolean(cluster['insecure-skip-tls-verify']),
      caData: readData(cluster['certificate-authority-data'], cluster['certificate-authority']),
      tlsServerName: cluster['tls-server-name'],
      proxyUrl: cluster.proxy,
    };

    if (user) {
      auth.token = readRaw(user.token, user.tokenFile);
      auth.certData = readData(user['client-certificate-data'], user['client-certificate']);
      auth.keyData = readData(user['client-key-data'], user['client-key']);
      if (user.username) {
        auth.username = user.username;
        auth.password = user.password;
      }
      if (user.exec?.command) {
        auth.exec = {
          command: user.exec.command,
          args: user.exec.args,
          env: user.exec.env,
          apiVersion: user.exec.apiVersion,
          installHint: user.exec.installHint,
        };
      }
    }

    return { name: contextName, namespace: ctx.context?.namespace, auth, kubeconfigPath: path };
  }
  throw new Error(`Context "${contextName}" was not found in any kubeconfig`);
}

export interface ExecCredential {
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
  expirationTimestamp?: string;
}

const execCache = new Map<string, { cred: ExecCredential; expires: number }>();

/**
 * Runs a kubeconfig `exec` credential plugin (EKS, GKE, AKS, OIDC, ...) and
 * caches the result until shortly before it expires.
 */
export function runExecPlugin(key: string, cfg: ExecAuthConfig): ExecCredential {
  const cached = execCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.cred;

  const env = { ...process.env };
  for (const e of cfg.env ?? []) env[e.name] = e.value;

  let stdout: string;
  try {
    stdout = execFileSync(cfg.command, cfg.args ?? [], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err: any) {
    const hint = cfg.installHint ? `\n${cfg.installHint}` : '';
    throw new Error(
      `Credential plugin "${cfg.command}" failed: ${err?.stderr || err?.message || err}${hint}`,
    );
  }

  const parsed = JSON.parse(stdout);
  const status = parsed?.status ?? {};
  const cred: ExecCredential = {
    token: status.token,
    clientCertificateData: status.clientCertificateData,
    clientKeyData: status.clientKeyData,
    expirationTimestamp: status.expirationTimestamp,
  };
  const expires = cred.expirationTimestamp
    ? new Date(cred.expirationTimestamp).getTime() - 30_000
    : Date.now() + 5 * 60_000;
  execCache.set(key, { cred, expires: Math.max(expires, Date.now() + 10_000) });
  return cred;
}

export function invalidateExecCache(): void {
  execCache.clear();
}
