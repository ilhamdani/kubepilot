import { useEffect, useMemo, useRef, useState } from 'react';
import type { KubeObject, ResourceQuery, ResourceRef } from '@shared/types';
import { api } from '../api';
import { statusOf, formatAge } from '../lib/format';
import { findKindById, type ColumnDef, type RowContext } from '../lib/catalog';
import { refreshList, useKubeList } from '../state/lists';
import { useApp, type ResourceTabRef } from '../state/store';
import { ContextMenu, Modal, type MenuItem } from './Overlays';
import { ResourceIcon, SearchIcon, StatusBrick } from './Icons';

interface Props {
  clusterId: string;
  resource: ResourceTabRef;
}

interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

const FALLBACK_COLUMNS: ColumnDef[] = [
  {
    id: 'name',
    title: 'Name',
    width: 320,
    cell: (o) => o.metadata?.name,
  },
  {
    id: 'namespace',
    title: 'Namespace',
    width: 160,
    cell: (o) => o.metadata?.namespace ?? '-',
  },
  {
    id: 'age',
    title: 'Age',
    width: 90,
    align: 'right',
    sortValue: (o) => -(new Date(o.metadata?.creationTimestamp ?? 0).getTime() || 0),
    cell: (o) => formatAge(o.metadata?.creationTimestamp),
  },
];

export function ItemList({ clusterId, resource }: Props) {
  const state = useApp((s) => s.states[clusterId]);
  const namespace = useApp((s) => s.settings.namespaceByCluster[clusterId] ?? 'all');
  const setNamespace = useApp((s) => s.setNamespace);
  const metrics = useApp((s) => s.metrics);
  const openDetails = useApp((s) => s.openDetails);
  const openLogs = useApp((s) => s.openLogs);
  const openTerminal = useApp((s) => s.openTerminal);
  const toast = useApp((s) => s.toast);
  const hotbar = useApp((s) => s.settings.hotbar);
  const toggleHotbar = useApp((s) => s.toggleHotbar);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ columnId: 'name', direction: 'asc' });
  const [selected, setSelected] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; object: KubeObject } | null>(null);
  const [deleting, setDeleting] = useState<KubeObject | null>(null);
  const [scaling, setScaling] = useState<KubeObject | null>(null);
  const [forwarding, setForwarding] = useState<KubeObject | null>(null);

  const kindDef = findKindById(resource.id);
  const columns = kindDef?.columns.length ? kindDef.columns : FALLBACK_COLUMNS;

  const effectiveNamespace = resource.namespaced && namespace !== 'all' ? namespace : undefined;

  const listQuery: ResourceQuery = useMemo(
    () => ({
      clusterId,
      apiVersion: resource.apiVersion,
      plural: resource.plural,
      kind: resource.kind,
      namespaced: resource.namespaced,
      namespace: effectiveNamespace,
    }),
    [clusterId, resource.apiVersion, resource.plural, resource.kind, resource.namespaced, effectiveNamespace],
  );

  const { items, loading, error } = useKubeList(listQuery);

  const rowContext: RowContext = useMemo(() => {
    // Pod metrics are keyed `ns/name`, node metrics `/<name>`; one map serves both.
    const merged = new Map(metrics.pods);
    for (const [key, value] of metrics.nodes) merged.set(key, value);
    return { metrics: merged, namespace: effectiveNamespace };
  }, [metrics, effectiveNamespace]);

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let result = items;
    if (needle) {
      result = result.filter((item) => {
        const haystack = [
          item.metadata?.name,
          item.metadata?.namespace,
          item.kind,
          ...Object.entries(item.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    const column = columns.find((c) => c.id === sort.columnId) ?? columns[0];
    const sorted = [...result].sort((a, b) => {
      const av = column.sortValue ? column.sortValue(a, rowContext) : (a.metadata?.name ?? '');
      const bv = column.sortValue ? column.sortValue(b, rowContext) : (b.metadata?.name ?? '');
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true });
    });
    if (sort.direction === 'desc') sorted.reverse();
    return sorted;
  }, [items, query, columns, sort, rowContext]);

  const refOf = (object: KubeObject): ResourceRef => ({
    clusterId,
    apiVersion: resource.apiVersion,
    plural: resource.plural,
    kind: resource.kind,
    namespaced: resource.namespaced,
    namespace: object.metadata?.namespace,
    name: object.metadata?.name,
  });

  const namespaces = state?.namespaces ?? [];
  const pinned = hotbar.some((item) => item.id === `${clusterId}:${resource.id}`);

  const columnStyle = (column: ColumnDef) =>
    column.id === 'name'
      ? { flex: '1 1 240px', minWidth: 190, maxWidth: 520 }
      : { flex: `0 0 ${column.width}px`, width: column.width };

  const menuItems = (object: KubeObject): MenuItem[] => {
    const kind = object.kind;
    const isPod = kind === 'Pod';
    const scalable = Boolean(kindDef?.scalable);
    const restartable = Boolean(kindDef?.restartable);
    return [
      {
        id: 'details',
        label: 'View details',
        onSelect: () => openDetails(clusterId, refOf(object), resource.id),
      },
      {
        id: 'yaml',
        label: 'Edit YAML',
        onSelect: () => {
          openDetails(clusterId, refOf(object), resource.id);
          useApp.getState().setDetailsTab('yaml');
        },
      },
      { id: 'sep1', label: '', separator: true },
      ...(isPod
        ? [
            {
              id: 'logs',
              label: 'Logs',
              onSelect: () =>
                openLogs({
                  clusterId,
                  namespace: object.metadata.namespace,
                  pod: object.metadata.name,
                  container: object.spec?.containers?.[0]?.name,
                }),
            },
            {
              id: 'terminal',
              label: 'Terminal',
              onSelect: () =>
                openTerminal({
                  clusterId,
                  namespace: object.metadata.namespace,
                  pod: object.metadata.name,
                  container: object.spec?.containers?.[0]?.name,
                }),
            },
          ]
        : []),
      ...(scalable ? [{ id: 'scale', label: 'Scale…', onSelect: () => setScaling(object) }] : []),
      ...(restartable
        ? [{ id: 'restart', label: 'Restart rollout', onSelect: () => void restart(object) }]
        : []),
      ...(isPod || kind === 'Service'
        ? [{ id: 'forward', label: 'Port forward…', onSelect: () => setForwarding(object) }]
        : []),
      { id: 'sep2', label: '', separator: true },
      {
        id: 'copy',
        label: 'Copy name',
        onSelect: () => void navigator.clipboard.writeText(object.metadata.name),
      },
      {
        id: 'delete',
        label: 'Delete',
        danger: true,
        onSelect: () => setDeleting(object),
      },
    ];
  };

  const restart = async (object: KubeObject) => {
    try {
      await api.resources.restart(refOf(object));
      toast(`Rollout restart requested for ${object.metadata.name}`, 'success');
    } catch (err: any) {
      toast(err?.message ?? 'Restart failed', 'error');
    }
  };

  const remove = async (object: KubeObject) => {
    try {
      await api.resources.remove(refOf(object));
      toast(`${object.kind} ${object.metadata.name} deleted`, 'success');
      setDeleting(null);
      void refreshList(listQuery);
    } catch (err: any) {
      toast(err?.message ?? 'Delete failed', 'error');
    }
  };

  const doScale = async (object: KubeObject, replicas: number) => {
    try {
      await api.resources.scale(refOf(object), replicas);
      toast(`Scaled ${object.metadata.name} to ${replicas}`, 'success');
      setScaling(null);
    } catch (err: any) {
      toast(err?.message ?? 'Scale failed', 'error');
    }
  };

  const toggleSort = (column: ColumnDef) => {
    setSort((prev) =>
      prev.columnId === column.id
        ? { columnId: column.id, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId: column.id, direction: 'asc' },
    );
  };

  return (
    <div className="content">
      <div className="toolbar">
        <ResourceIcon kind={resource.kind} size={16} />
        <span className="toolbar-title">{resource.label}</span>
        <span className="toolbar-count">{loading ? '…' : `${visibleItems.length} items`}</span>

        <div className="toolbar-spacer" />

        {resource.namespaced && (
          <select
            className="ns-select"
            value={namespace}
            onChange={(event) => setNamespace(clusterId, event.target.value)}
            title="Namespace filter"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        )}

        <div className="search-input">
          <SearchIcon size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or label"
            spellCheck={false}
          />
        </div>

        <button
          className="icon-btn"
          title={pinned ? 'Unpin from hotbar' : 'Pin to hotbar'}
          style={pinned ? { color: 'var(--blue)' } : undefined}
          onClick={() =>
            void toggleHotbar({
              id: `${clusterId}:${resource.id}`,
              clusterId,
              title: resource.label,
              target: {
                type: 'resource',
                apiVersion: resource.apiVersion,
                plural: resource.plural,
                kind: resource.kind,
                namespaced: resource.namespaced,
              },
            })
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
            <path d="M6 1.8h4l-.6 3.4 2.2 2.2H4.4l2.2-2.2z" />
            <path d="M8 7.4V14" strokeLinecap="round" />
          </svg>
        </button>

        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => void refreshList(listQuery)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.6v3.2h-3.2" />
          </svg>
        </button>
      </div>

      <div className="table-wrap">
        {error && (
          <div className="table-empty">
            <div className="table-empty-title">Could not load {resource.label}</div>
            <div style={{ maxWidth: 520 }}>{error}</div>
            <button className="btn" onClick={() => void refreshList(listQuery)}>
              Retry
            </button>
          </div>
        )}

        {!error && loading && (
          <div className="table-empty">
            <div className="spinner" />
            <div>Loading {resource.label.toLowerCase()}…</div>
          </div>
        )}

        {!error && !loading && visibleItems.length === 0 && (
          <div className="table-empty">
            <ResourceIcon kind={resource.kind} size={34} />
            <div className="table-empty-title">No {resource.label.toLowerCase()} found</div>
            <div style={{ maxWidth: 420 }}>
              {query
                ? 'No objects match the current filter.'
                : effectiveNamespace
                  ? `Nothing in namespace “${effectiveNamespace}”. Try switching to all namespaces.`
                  : 'This cluster has no objects of this kind yet.'}
            </div>
          </div>
        )}

        {!error && visibleItems.length > 0 && (
          <div className="table" style={{ minWidth: '100%' }}>
            <div className="thead">
              {columns.map((column) => (
                <div
                  key={column.id}
                  className={`th ${column.align === 'right' ? 'th--right' : ''}`}
                  style={columnStyle(column)}
                  onClick={() => toggleSort(column)}
                  title={`Sort by ${column.title}`}
                >
                  {column.title}
                  {sort.columnId === column.id && (
                    <span className="th-sort">{sort.direction === 'asc' ? '▲' : '▼'}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="tbody">
              {visibleItems.map((object) => {
                const id = `${object.metadata?.namespace ?? ''}/${object.metadata?.name}`;
                const status = statusOf(object);
                return (
                  <div
                    key={id}
                    className={`tr ${selected === id ? 'tr--selected' : ''}`}
                    onClick={() => setSelected(id)}
                    onDoubleClick={() => openDetails(clusterId, refOf(object), resource.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelected(id);
                      setMenu({ x: event.clientX, y: event.clientY, object });
                    }}
                  >
                    {columns.map((column, index) => {
                      const isName = column.id === 'name';
                      return (
                        <div
                          key={column.id}
                          className={`td ${column.align === 'right' ? 'td--right' : ''} ${
                            isName ? 'td--name' : ''
                          }`}
                          style={columnStyle(column)}
                        >
                          {isName && <StatusBrick tone={status.tone} />}
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {column.cell(object, rowContext)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.object)} onClose={() => setMenu(null)} />
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.kind}`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void remove(deleting)}>
                Delete
              </button>
            </>
          }
        >
          <div>
            Are you sure you want to delete{' '}
            <strong style={{ color: 'var(--textColorAccent)' }}>{deleting.metadata.name}</strong>
            {deleting.metadata.namespace ? ` in namespace ${deleting.metadata.namespace}` : ''}?
          </div>
          <div className="warning-box">
            Dependent objects may be removed by the garbage collector. This cannot be undone.
          </div>
        </Modal>
      )}

      {scaling && (
        <ScaleDialog
          object={scaling}
          onClose={() => setScaling(null)}
          onApply={(replicas) => void doScale(scaling, replicas)}
        />
      )}

      {forwarding && (
        <PortForwardDialog
          object={forwarding}
          clusterId={clusterId}
          onClose={() => setForwarding(null)}
          onStarted={(message) => {
            toast(message, 'success');
            setForwarding(null);
          }}
        />
      )}
    </div>
  );
}

function ScaleDialog({
  object,
  onClose,
  onApply,
}: {
  object: KubeObject;
  onClose: () => void;
  onApply: (replicas: number) => void;
}) {
  const [replicas, setReplicas] = useState<number>(object.spec?.replicas ?? 1);
  return (
    <Modal
      title={`Scale ${object.kind}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => onApply(replicas)}>
            Scale
          </button>
        </>
      }
    >
      <div>
        Set the number of replicas for{' '}
        <strong style={{ color: 'var(--textColorAccent)' }}>{object.metadata.name}</strong>.
      </div>
      <div className="field">
        <label>Replicas</label>
        <input
          type="number"
          min={0}
          max={1000}
          value={replicas}
          onChange={(event) => setReplicas(Number(event.target.value))}
        />
      </div>
    </Modal>
  );
}

function PortForwardDialog({
  object,
  clusterId,
  onClose,
  onStarted,
}: {
  object: KubeObject;
  clusterId: string;
  onClose: () => void;
  onStarted: (message: string) => void;
}) {
  const remoteDefault =
    object.kind === 'Pod'
      ? (object.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 8080)
      : (object.spec?.ports?.[0]?.port ?? 80);
  const [localPort, setLocalPort] = useState<number>(remoteDefault);
  const [remotePort, setRemotePort] = useState<number>(remoteDefault);
  const [error, setError] = useState<string>();

  const start = async () => {
    try {
      const result = await api.portForward.start({
        clusterId,
        namespace: object.metadata.namespace,
        kind: object.kind === 'Pod' ? 'pod' : 'service',
        name: object.metadata.name,
        localPort,
        remotePort,
      });
      if (result.status === 'error') {
        setError(result.error ?? 'Port forward failed');
        return;
      }
      onStarted(`Forwarding localhost:${localPort} → ${object.metadata.name}:${remotePort}`);
    } catch (err: any) {
      setError(err?.message ?? 'Port forward failed');
    }
  };

  return (
    <Modal
      title="Port forward"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => void start()}>
            Start
          </button>
        </>
      }
    >
      <div>
        Forward a local port to{' '}
        <strong style={{ color: 'var(--textColorAccent)' }}>
          {object.kind.toLowerCase()}/{object.metadata.name}
        </strong>
        . Uses the local <span className="mono">kubectl</span> binary.
      </div>
      <div className="field">
        <label>Local port</label>
        <input
          type="number"
          value={localPort}
          onChange={(event) => setLocalPort(Number(event.target.value))}
        />
      </div>
      <div className="field">
        <label>Remote port</label>
        <input
          type="number"
          value={remotePort}
          onChange={(event) => setRemotePort(Number(event.target.value))}
        />
      </div>
      {error && <div className="warning-box">{error}</div>}
    </Modal>
  );
}
