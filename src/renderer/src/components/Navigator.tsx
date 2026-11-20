import { useMemo, useState } from 'react';
import type { ClusterState, DiscoveredResource } from '@shared/types';
import { CATALOG, GROUPS, type ResourceKind } from '../lib/catalog';
import { isCreateable } from '../lib/templates';
import { ChevronIcon, ResourceIcon, SearchIcon } from './Icons';
import { useActiveResource, useApp, type ResourceTabRef } from '../state/store';

interface Props {
  clusterId: string;
  state?: ClusterState;
  activeResourceId?: string;
}

/** Custom resources discovered at runtime, grouped by API group. */
function customKinds(state?: ClusterState): ResourceKind[] {
  if (!state?.resources) return [];
  return state.resources
    .filter((r: DiscoveredResource) => r.custom && r.verbs.includes('list'))
    .map((r) => ({
      id: `cr:${r.apiVersion}:${r.plural}`,
      kind: r.kind,
      apiVersion: r.apiVersion,
      plural: r.plural,
      namespaced: r.namespaced,
      group: 'custom' as const,
      label: r.kind,
      description: `${r.apiVersion} · ${r.plural}`,
      columns: [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function Navigator({ clusterId, state, activeResourceId }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const openResourceTab = useApp((s) => s.openResourceTab);
  const openCreateTab = useApp((s) => s.openCreateTab);
  const activeResource = useActiveResource();

  const canCreate = !activeResource || isCreateable(activeResource.kind);

  const custom = useMemo(() => customKinds(state), [state]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (kind: ResourceKind) =>
      !needle ||
      kind.label.toLowerCase().includes(needle) ||
      kind.kind.toLowerCase().includes(needle) ||
      kind.plural.toLowerCase().includes(needle);
    return { catalog: CATALOG.filter(matches), custom: custom.filter(matches) };
  }, [query, custom]);

  const toggle = (groupId: string) =>
    setCollapsed((prev) => ({ ...prev, [groupId]: !prev[groupId] }));

  const renderItem = (kind: ResourceKind) => {
    const ref: ResourceTabRef = {
      id: kind.id,
      kind: kind.kind,
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespaced: kind.namespaced,
      label: kind.label,
    };
    const active = activeResourceId === kind.id;
    return (
      <button
        key={kind.id}
        className={`nav-item ${active ? 'nav-item--active' : ''}`}
        onClick={() => openResourceTab(clusterId, ref)}
        title={kind.description}
      >
        <ResourceIcon kind={kind.kind} size={15} />
        <span className="nav-item-label">{kind.label}</span>
      </button>
    );
  };

  const totalVisible = filtered.catalog.length + filtered.custom.length;

  return (
    <aside className="navigator">
      <div className="nav-header">
        <div className="nav-cluster">
          <span
            className={`conn-dot ${
              state?.status === 'error' ? 'conn-dot--error' : state?.status === 'connecting' ? 'conn-dot--connecting' : ''
            }`}
          />
          <span className="nav-cluster-name">{state?.cluster.displayName ?? 'No cluster'}</span>
          <span className="nav-cluster-meta">{state?.version ?? ''}</span>
        </div>
        <div className="nav-search">
          <SearchIcon size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search resources"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="nav-scroll">
        {totalVisible === 0 && <div className="nav-empty">No resources match “{query}”.</div>}

        {GROUPS.filter((group) => group.id !== 'custom').map((group) => {
          const items = filtered.catalog.filter((kind) => kind.group === group.id);
          if (!items.length) return null;
          const isCollapsed = collapsed[group.id] && !query;
          return (
            <div className="nav-group" key={group.id}>
              <div className="nav-group-header" onClick={() => toggle(group.id)}>
                <ChevronIcon open={!isCollapsed} />
                {group.label}
              </div>
              {!isCollapsed && <div className="nav-items">{items.map(renderItem)}</div>}
            </div>
          );
        })}

        {filtered.custom.length > 0 && (
          <div className="nav-group">
            <div className="nav-group-header" onClick={() => toggle('custom')}>
              <ChevronIcon open={!collapsed.custom || Boolean(query)} />
              Custom Resources
            </div>
            {(!collapsed.custom || query) && (
              <div className="nav-items">{filtered.custom.map(renderItem)}</div>
            )}
          </div>
        )}
      </div>

      <div className="nav-footer">
        <button
          className="rail-btn"
          title={
            canCreate
              ? activeResource
                ? `Create ${activeResource.kind} from YAML`
                : 'Create resource from YAML'
              : `${activeResource?.kind} objects cannot be created from YAML`
          }
          disabled={!canCreate}
          onClick={() => openCreateTab(clusterId, activeResource)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button
          className="rail-btn"
          title="Cluster overview"
          onClick={() => useApp.getState().openOverviewTab(clusterId)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
            <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
