import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KubeObject, ResourceQuery } from '@shared/types';
import { api } from '../api';

interface Entry {
  items: KubeObject[];
  loading: boolean;
  error?: string;
  watchId?: string;
  refs: number;
  version: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

export function listKey(query: Pick<ResourceQuery, 'clusterId' | 'apiVersion' | 'plural' | 'namespace'>) {
  return `${query.clusterId}|${query.apiVersion}|${query.plural}|${query.namespace || '*'}`;
}

function notify(entry: Entry) {
  entry.version += 1;
  for (const listener of entry.listeners) listener();
}

function sortItems(items: KubeObject[]): KubeObject[] {
  return [...items].sort((a, b) =>
    String(a.metadata?.name ?? '').localeCompare(String(b.metadata?.name ?? '')),
  );
}

function applyEvent(entry: Entry, type: string, object: KubeObject) {
  const name = object.metadata?.name;
  const namespace = object.metadata?.namespace;
  const index = entry.items.findIndex(
    (item) => item.metadata?.name === name && item.metadata?.namespace === namespace,
  );
  if (type === 'ADDED') {
    if (index >= 0) entry.items[index] = object;
    else entry.items.push(object);
  } else if (type === 'MODIFIED') {
    if (index >= 0) entry.items[index] = object;
    else entry.items.push(object);
  } else if (type === 'DELETED') {
    if (index >= 0) entry.items.splice(index, 1);
  }
  entry.items = sortItems(entry.items);
  notify(entry);
}

async function ensure(query: ResourceQuery): Promise<Entry> {
  const key = listKey(query);
  let entry = entries.get(key);
  if (!entry) {
    entry = { items: [], loading: true, refs: 0, version: 0, listeners: new Set() };
    entries.set(key, entry);
    const created = entry;
    try {
      const result = await api.resources.list(query);
      created.items = sortItems(result.items ?? []);
      created.loading = false;
      notify(created);
    } catch (err: any) {
      created.loading = false;
      created.error = err?.message ?? String(err);
      notify(created);
    }
    try {
      created.watchId = await api.watch.start(query);
    } catch {
      /* watching is best effort; the snapshot above is still usable */
    }
  }
  entry.refs += 1;
  return entry;
}

function release(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    if (entry.watchId) void api.watch.stop(entry.watchId);
    entries.delete(key);
  }
}

// A single IPC subscription fans watch events out to the matching list entry.
api.watch.onEvent((event) => {
  for (const entry of entries.values()) {
    if (entry.watchId === event.watchId) {
      applyEvent(entry, event.type, event.object);
      return;
    }
  }
});

api.watch.onError((payload) => {
  for (const entry of entries.values()) {
    if (entry.watchId === payload.watchId) {
      entry.error = payload.message;
      notify(entry);
      return;
    }
  }
});

export interface KubeListState {
  items: KubeObject[];
  loading: boolean;
  error?: string;
}

export function useKubeList(query: ResourceQuery | null): KubeListState {
  const key = query ? listKey(query) : '';
  const queryKey = query
    ? `${key}|${query.labelSelector ?? ''}|${query.fieldSelector ?? ''}`
    : '';
  const [, force] = useState(0);

  useEffect(() => {
    if (!query) return;
    const activeKey = listKey(query);
    let active = true;
    void ensure(query).then(() => {
      if (active) force((n) => n + 1);
    });
    return () => {
      active = false;
      release(activeKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const subscribe = useMemo(
    () => (callback: () => void) => {
      const current = entries.get(key);
      if (!current) return () => undefined;
      current.listeners.add(callback);
      return () => {
        current.listeners.delete(callback);
      };
    },
    [key],
  );

  const version = useSyncExternalStore(
    subscribe,
    () => entries.get(key)?.version ?? 0,
    () => 0,
  );

  const entry = entries.get(key);
  void version;
  return {
    items: entry?.items ?? [],
    loading: entry ? entry.loading : true,
    error: entry?.error,
  };
}

/** Forces a refetch of a list (used after delete/scale when watching is off). */
export async function refreshList(query: ResourceQuery): Promise<void> {
  const entry = entries.get(listKey(query));
  if (!entry) return;
  try {
    const result = await api.resources.list(query);
    entry.items = sortItems(result.items ?? []);
    entry.error = undefined;
    notify(entry);
  } catch (err: any) {
    entry.error = err?.message ?? String(err);
    notify(entry);
  }
}
