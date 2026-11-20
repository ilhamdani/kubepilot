/**
 * Validation and conflict handling for kubeconfigs pasted into the app.
 *
 * This module is deliberately dependency-free: it works on an already parsed
 * YAML document, so it can be exercised by a plain Node test without Electron
 * or a YAML parser. `ipc.ts` owns the parsing and file I/O.
 */

export interface KubeconfigContext {
  name: string;
  context?: { cluster?: string; user?: string; namespace?: string };
}

export interface KubeconfigCluster {
  name: string;
  cluster?: { server?: string };
}

export interface KubeconfigDoc {
  apiVersion?: string;
  kind?: string;
  clusters?: KubeconfigCluster[];
  contexts?: KubeconfigContext[];
  users?: unknown[];
  'current-context'?: string;
  [key: string]: unknown;
}

export interface ParsedKubeconfig {
  doc: KubeconfigDoc;
  /** Context names that point at a cluster with a server. */
  contexts: string[];
  /** Non-fatal problems worth showing to the user. */
  warnings: string[];
}

/** Thrown for input that cannot be used as a kubeconfig at all. */
export class KubeconfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeconfigError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates one parsed YAML document. `ignoredDocuments` is the number of
 * extra YAML documents that were present in the pasted text; they are dropped
 * and reported as a warning rather than silently merged.
 */
export function validateKubeconfigDoc(doc: unknown, ignoredDocuments = 0): ParsedKubeconfig {
  if (!isRecord(doc)) {
    throw new KubeconfigError('The pasted text is empty or is not a YAML mapping.');
  }
  if (!Array.isArray(doc.contexts) && !Array.isArray(doc.clusters)) {
    throw new KubeconfigError(
      "This doesn't look like a kubeconfig — no 'clusters' or 'contexts' section was found.",
    );
  }

  const warnings: string[] = [];
  if (doc.apiVersion !== undefined && doc.apiVersion !== 'v1') {
    warnings.push(`apiVersion is "${String(doc.apiVersion)}"; kubeconfigs normally use "v1".`);
  }
  if (doc.kind !== undefined && doc.kind !== 'Config') {
    warnings.push(`kind is "${String(doc.kind)}"; kubeconfigs normally use "Config".`);
  }
  if (ignoredDocuments > 0) {
    warnings.push(
      `${ignoredDocuments} extra YAML document${ignoredDocuments === 1 ? ' was' : 's were'} ignored — only the first kubeconfig was imported.`,
    );
  }

  const contexts = Array.isArray(doc.contexts) ? (doc.contexts as KubeconfigContext[]) : [];
  const clusters = Array.isArray(doc.clusters) ? (doc.clusters as KubeconfigCluster[]) : [];
  if (!contexts.length) {
    throw new KubeconfigError('The kubeconfig has no contexts to connect to.');
  }

  const servers = new Map<string, string>();
  for (const entry of clusters) {
    if (!entry || typeof entry.name !== 'string') continue;
    const server = entry.cluster?.server;
    if (typeof server === 'string' && server.trim()) servers.set(entry.name, server);
  }

  const usable: string[] = [];
  const seen = new Map<string, number>();
  for (const entry of contexts) {
    const name = entry?.name;
    if (typeof name !== 'string' || !name.trim()) {
      warnings.push('A context without a name was skipped.');
      continue;
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (!servers.has(entry.context?.cluster ?? '')) {
      warnings.push(`Context "${name}" has no cluster with a server and will be skipped.`);
      continue;
    }
    usable.push(name);
  }
  for (const [name, count] of seen) {
    if (count > 1) warnings.push(`Context "${name}" appears ${count} times in this file.`);
  }
  if (!usable.length) {
    throw new KubeconfigError(
      'None of the contexts points at a cluster with a "server" value — there is nothing to connect to.',
    );
  }

  return { doc: doc as KubeconfigDoc, contexts: usable, warnings };
}

/**
 * Two kubeconfigs frequently use the same context name ("default",
 * "kubernetes-admin@kubernetes"). Cluster ids are `live:<contextName>`, so a
 * collision would make the new cluster unreachable: `resolveContext` always
 * picks the first match. Rename the *imported copy* instead, keeping the
 * cluster/user references intact, and report what changed.
 */
export function renameConflictingContexts(
  doc: KubeconfigDoc,
  existingNames: Iterable<string>,
): { renames: Array<{ from: string; to: string }>; warnings: string[] } {
  const taken = new Set(existingNames);
  const renames: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];

  for (const entry of doc.contexts ?? []) {
    if (typeof entry?.name !== 'string' || !taken.has(entry.name)) continue;
    let suffix = 2;
    let candidate = `${entry.name}-${suffix}`;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${entry.name}-${suffix}`;
    }
    const from = entry.name;
    entry.name = candidate;
    taken.add(candidate);
    renames.push({ from, to: candidate });
    warnings.push(
      `Context "${from}" already exists, so this copy was imported as "${candidate}".`,
    );
  }

  if (doc['current-context'] && renames.length) {
    const renamed = renames.find((r) => r.from === doc['current-context']);
    if (renamed) doc['current-context'] = renamed.to;
  }
  return { renames, warnings };
}

/**
 * Adds the two fields kubectl insists on but some hand-written configs omit.
 * Returns true when the document was changed (and therefore must be written
 * back out instead of keeping the user's original text verbatim).
 */
export function normalizeKubeconfigDoc(doc: KubeconfigDoc): boolean {
  let changed = false;
  if (!doc.apiVersion) {
    doc.apiVersion = 'v1';
    changed = true;
  }
  if (!doc.kind) {
    doc.kind = 'Config';
    changed = true;
  }
  return changed;
}

/** Turns a user-supplied label into a safe, readable filename stem. */
export function safeFileStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 48);
  return cleaned || 'pasted';
}
