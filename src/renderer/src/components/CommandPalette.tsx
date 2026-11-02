import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG } from '../lib/catalog';
import { isCreateable } from '../lib/templates';
import { useActiveResource, useApp } from '../state/store';
import { ResourceIcon, SearchIcon } from './Icons';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  kind?: string;
  section: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const togglePalette = useApp((s) => s.togglePalette);
  const clusters = useApp((s) => s.clusters);
  const activeClusterId = useApp((s) => s.activeClusterId);
  const tabs = useApp((s) => s.tabs);
  const openResourceTab = useApp((s) => s.openResourceTab);
  const openOverviewTab = useApp((s) => s.openOverviewTab);
  const openCreateTab = useApp((s) => s.openCreateTab);
  const openSettingsTab = useApp((s) => s.openSettingsTab);
  const activateTab = useApp((s) => s.activateTab);
  const setActiveCluster = useApp((s) => s.setActiveCluster);
  const activeResource = useActiveResource();

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];

    for (const cluster of clusters) {
      list.push({
        id: `cluster:${cluster.id}`,
        label: cluster.displayName,
        hint: cluster.server,
        section: 'Clusters',
        run: () => void setActiveCluster(cluster.id),
      });
    }

    if (activeClusterId) {
      for (const kind of CATALOG) {
        list.push({
          id: `kind:${kind.id}`,
          label: kind.label,
          hint: kind.description,
          kind: kind.kind,
          section: 'Resources',
          run: () =>
            openResourceTab(activeClusterId, {
              id: kind.id,
              kind: kind.kind,
              apiVersion: kind.apiVersion,
              plural: kind.plural,
              namespaced: kind.namespaced,
              label: kind.label,
            }),
        });
      }
    }

    for (const tab of tabs) {
      list.push({
        id: `tab:${tab.id}`,
        label: tab.title,
        hint: 'switch to tab',
        section: 'Open tabs',
        run: () => activateTab(tab.id),
      });
    }

    if (activeClusterId) {
      list.push({
        id: 'action:overview',
        label: 'Cluster overview',
        section: 'Actions',
        run: () => openOverviewTab(activeClusterId),
      });
      if (activeResource && isCreateable(activeResource.kind)) {
        const source = activeResource;
        list.push({
          id: 'action:create',
          label: `Create ${source.kind} from YAML`,
          hint: 'template',
          kind: source.kind,
          section: 'Actions',
          run: () => openCreateTab(activeClusterId, source),
        });
      }
      list.push({
        id: 'action:create-blank',
        label: 'Create resource from YAML',
        section: 'Actions',
        run: () => openCreateTab(activeClusterId),
      });
    }
    list.push({
      id: 'action:settings',
      label: 'Preferences',
      section: 'Actions',
      run: () => openSettingsTab(),
    });

    return list;
  }, [clusters, activeClusterId, activeResource, tabs, openResourceTab, openOverviewTab, openCreateTab, openSettingsTab, activateTab, setActiveCluster]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.slice(0, 40);
    return entries
      .filter((entry) =>
        `${entry.label} ${entry.hint ?? ''}`.toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [entries, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const sections = Array.from(new Set(filtered.map((entry) => entry.section)));

  return (
    <div className="palette-overlay" onMouseDown={() => togglePalette(false)}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search resources, tabs and actions…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                filtered[index]?.run();
                togglePalette(false);
              } else if (event.key === 'Escape') {
                togglePalette(false);
              }
            }}
          />
        </div>

        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-hint" style={{ padding: 12 }}>No matches</div>}
          {sections.map((section) => (
            <div key={section}>
              <div className="palette-section">{section}</div>
              {filtered
                .filter((entry) => entry.section === section)
                .map((entry) => {
                  const globalIndex = filtered.indexOf(entry);
                  return (
                    <button
                      key={entry.id}
                      className={`palette-item ${globalIndex === index ? 'palette-item--active' : ''}`}
                      onMouseEnter={() => setIndex(globalIndex)}
                      onClick={() => {
                        entry.run();
                        togglePalette(false);
                      }}
                    >
                      {entry.kind ? (
                        <ResourceIcon kind={entry.kind} size={15} />
                      ) : (
                        <span style={{ width: 15 }} />
                      )}
                      <span>{entry.label}</span>
                      {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
