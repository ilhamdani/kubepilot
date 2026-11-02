import { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { DiscoveredResource, KubeObject, ResourceRef } from '@shared/types';
import { api } from '../api';
import { CATALOG } from '../lib/catalog';
import { YAML_THEME, ensureMonaco } from '../lib/monaco';
import { dumpObject } from '../lib/yaml';
import { useApp, type Tab } from '../state/store';

/** One side of the comparison: the object plus the YAML rendered for it. */
interface PaneDoc {
  ref?: ResourceRef;
  yaml: string;
}

interface KindOption {
  key: string;
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  label: string;
}

interface ObjectEntry {
  /** `namespace/name` for namespaced kinds, plain `name` otherwise. */
  id: string;
  label: string;
}

const ALL_NAMESPACES = 'all';

const kindKey = (apiVersion: string, plural: string) => `${apiVersion}:${plural}`;

const objectId = (namespace: string | undefined, name: string) =>
  namespace ? `${namespace}/${name}` : name;

const describe = (ref: ResourceRef | undefined) =>
  ref ? objectId(ref.namespace, ref.name) : 'no object';

/**
 * Side-by-side YAML comparison. Both sides are read-only, and either side may
 * point at a different cluster — the selector row connects on demand.
 */
export function SplitView({ tab }: { tab: Tab }) {
  const clusters = useApp((s) => s.clusters);
  const setSplitSide = useApp((s) => s.setSplitSide);
  const [left, setLeft] = useState<PaneDoc>({ yaml: '' });
  const [right, setRight] = useState<PaneDoc>({ yaml: '' });

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    ensureMonaco();
    const original = monaco.editor.createModel('', 'yaml');
    const modified = monaco.editor.createModel('', 'yaml');
    original.updateOptions({ tabSize: 2 });
    modified.updateOptions({ tabSize: 2 });
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      theme: YAML_THEME,
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      fontFamily:
        "'SF Mono', 'Cascadia Mono', Consolas, 'Ubuntu Mono', 'Liberation Mono', monospace",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      smoothScrolling: true,
      wordWrap: 'on',
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    originalRef.current = original;
    modifiedRef.current = modified;
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      originalRef.current = null;
      modifiedRef.current = null;
    };
  }, []);

  useEffect(() => {
    originalRef.current?.setValue(left.yaml);
  }, [left.yaml]);

  useEffect(() => {
    modifiedRef.current?.setValue(right.yaml);
  }, [right.yaml]);

  const clusterName = (ref: ResourceRef | undefined) =>
    clusters.find((cluster) => cluster.id === ref?.clusterId)?.displayName ?? '';

  // Cluster names only earn their space when the two sides live apart; the
  // pane captions always label the cluster.
  let summary = 'Pick an object on each side';
  if (left.ref || right.ref) {
    const sameCluster = !left.ref || !right.ref || left.ref.clusterId === right.ref.clusterId;
    summary = sameCluster
      ? `${describe(left.ref)} vs ${describe(right.ref)}`
      : `${clusterName(left.ref)}/${describe(left.ref)} vs ${clusterName(right.ref)}/${describe(right.ref)}`;
  }

  return (
    <div className="content split-view">
      <div className="toolbar">
        <span className="toolbar-title">Compare YAML</span>
        <span className="toolbar-count split-summary">{summary}</span>
        <div className="toolbar-spacer" />
      </div>

      <div className="split-head">
        <SplitPane
          defaultClusterId={tab.clusterId}
          initial={tab.split?.left}
          onDocument={setLeft}
          onSelect={(ref) => setSplitSide(tab.id, 'left', ref)}
        />
        <SplitPane
          defaultClusterId={tab.clusterId}
          initial={tab.split?.right}
          onDocument={setRight}
          onSelect={(ref) => setSplitSide(tab.id, 'right', ref)}
        />
      </div>

      <div className="diff-host" ref={hostRef} />
    </div>
  );
}

interface PaneProps {
  defaultClusterId: string;
  initial?: ResourceRef;
  onDocument: (doc: PaneDoc) => void;
  onSelect: (ref?: ResourceRef) => void;
}

function SplitPane({ defaultClusterId, initial, onDocument, onSelect }: PaneProps) {
  const clusters = useApp((s) => s.clusters);
  const states = useApp((s) => s.states);

  const [clusterId, setClusterId] = useState(initial?.clusterId ?? defaultClusterId);
  const [selectedKind, setSelectedKind] = useState(() =>
    initial ? kindKey(initial.apiVersion, initial.plural) : kindKey('v1', 'pods'),
  );
  const [namespace, setNamespace] = useState(initial?.namespace ?? ALL_NAMESPACES);
  const [selected, setSelected] = useState(() =>
    initial ? objectId(initial.namespace, initial.name) : '',
  );

  const [objects, setObjects] = useState<ObjectEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const [error, setError] = useState<string>();

  const state = states[clusterId];
  const status = state?.status;
  const connected = status === 'connected';

  // The second side may name a cluster the app has never connected to. Only a
  // never-seen or deliberately disconnected cluster is auto-connected: a
  // failed connect must not retry itself, or an unreachable server would be
  // hammered in a loop. `error` is surfaced below with an explicit Retry.
  useEffect(() => {
    if (!clusterId) return;
    const current = useApp.getState().states[clusterId]?.status;
    if (current !== undefined && current !== 'disconnected') return;
    void useApp.getState().connect(clusterId).catch(() => undefined);
  }, [clusterId, status]);

  const kinds = useMemo<KindOption[]>(() => {
    const built: KindOption[] = CATALOG.map((entry) => ({
      key: kindKey(entry.apiVersion, entry.plural),
      kind: entry.kind,
      apiVersion: entry.apiVersion,
      plural: entry.plural,
      namespaced: entry.namespaced,
      label: entry.label,
    }));
    const custom: KindOption[] = (state?.resources ?? [])
      .filter((resource: DiscoveredResource) => resource.custom)
      .map((resource: DiscoveredResource) => ({
        key: kindKey(resource.apiVersion, resource.plural),
        kind: resource.kind,
        apiVersion: resource.apiVersion,
        plural: resource.plural,
        namespaced: resource.namespaced,
        label: resource.kind,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const list = [...built, ...custom];
    // A ref handed over by "Compare with…" can name a kind discovery has not
    // reported yet (cluster still connecting, CRD added since).
    if (initial && !list.some((entry) => entry.key === kindKey(initial.apiVersion, initial.plural))) {
      list.push({
        key: kindKey(initial.apiVersion, initial.plural),
        kind: initial.kind,
        apiVersion: initial.apiVersion,
        plural: initial.plural,
        namespaced: initial.namespaced,
        label: initial.kind,
      });
    }
    return list;
  }, [state?.resources, initial]);

  const kind = kinds.find((entry) => entry.key === selectedKind) ?? kinds[0];

  useEffect(() => {
    if (!connected || !kind) {
      setObjects([]);
      return;
    }
    let active = true;
    setListLoading(true);
    setError(undefined);
    void api.resources
      .list({
        clusterId,
        apiVersion: kind.apiVersion,
        plural: kind.plural,
        kind: kind.kind,
        namespaced: kind.namespaced,
        namespace: kind.namespaced && namespace !== ALL_NAMESPACES ? namespace : undefined,
      })
      .then((result) => {
        if (!active) return;
        const entries = (result.items ?? [])
          .map((item: KubeObject) => {
            const name = item.metadata?.name as string | undefined;
            const ns = item.metadata?.namespace as string | undefined;
            return name ? { id: objectId(ns, name), label: objectId(ns, name) } : undefined;
          })
          .filter((entry): entry is ObjectEntry => Boolean(entry))
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        setObjects(entries);
      })
      .catch((err: any) => {
        if (!active) return;
        setObjects([]);
        setError(err?.message ?? 'Could not list objects');
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clusterId, connected, kind?.key, kind?.apiVersion, kind?.plural, kind?.kind, kind?.namespaced, namespace]);

  const ref = useMemo<ResourceRef | undefined>(() => {
    if (!kind || !selected) return undefined;
    const slash = selected.indexOf('/');
    const ns = slash >= 0 ? selected.slice(0, slash) : undefined;
    return {
      clusterId,
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      kind: kind.kind,
      namespaced: kind.namespaced,
      namespace: kind.namespaced ? ns : undefined,
      name: slash >= 0 ? selected.slice(slash + 1) : selected,
    };
  }, [clusterId, kind, selected]);

  useEffect(() => {
    // Remember the pair on the tab: this component unmounts whenever the user
    // looks at another tab, and a comparison must survive that.
    onSelect(ref);
    setError(undefined);
    if (!ref) {
      setDocLoading(false);
      onDocument({ yaml: '' });
      return;
    }
    let active = true;
    setDocLoading(true);
    setError(undefined);
    void api.resources
      .get(ref)
      .then((object) => {
        if (active) onDocument({ ref, yaml: dumpObject(object) });
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message ?? 'Could not load object');
        // Keep the ref so the header still names what failed to load.
        onDocument({ ref, yaml: '' });
      })
      .finally(() => {
        if (active) setDocLoading(false);
      });
    return () => {
      active = false;
    };
    // The ref is rebuilt on every render; key off its contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.clusterId, ref?.apiVersion, ref?.plural, ref?.namespace, ref?.name]);

  const clusterLabel = clusters.find((cluster) => cluster.id === clusterId)?.displayName ?? clusterId;

  return (
    <div className="split-pane">
      <div className="split-pane-controls">
        <select
          className="ns-select"
          value={clusterId}
          title="Cluster"
          onChange={(event) => {
            setClusterId(event.target.value);
            setSelected('');
            setNamespace(ALL_NAMESPACES);
          }}
        >
          {clusters.map((cluster) => (
            <option key={cluster.id} value={cluster.id}>
              {cluster.displayName}
            </option>
          ))}
        </select>

        <select
          className="ns-select"
          value={kind?.key ?? ''}
          title="Kind"
          onChange={(event) => {
            setSelectedKind(event.target.value);
            setSelected('');
          }}
        >
          {kinds.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>

        {kind?.namespaced && (
          <select
            className="ns-select"
            value={namespace}
            title="Namespace"
            onChange={(event) => {
              setNamespace(event.target.value);
              setSelected('');
            }}
          >
            <option value={ALL_NAMESPACES}>All namespaces</option>
            {(state?.namespaces ?? []).map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        )}

        <select
          className="ns-select"
          value={selected}
          title="Object"
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">
            {!connected ? 'Not connected' : listLoading ? 'Loading…' : 'Pick an object to compare'}
          </option>
          {objects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="split-pane-caption">
        <span className="split-pane-cluster">{clusterLabel}</span>
        <span className="split-pane-target">
          {ref ? objectId(ref.namespace, ref.name) : 'Pick an object to compare'}
        </span>
        {status === 'connecting' && <span className="hint">connecting…</span>}
        {docLoading && <span className="hint">loading…</span>}
      </div>

      {status === 'error' && (
        <div className="split-pane-error">
          <span className="split-pane-error-text">
            {state?.error ?? 'Could not connect to this cluster'}
          </span>
          <button
            className="btn btn--ghost split-pane-retry"
            onClick={() => void useApp.getState().connect(clusterId).catch(() => undefined)}
          >
            Retry
          </button>
        </div>
      )}

      {error && <div className="split-pane-error">{error}</div>}
    </div>
  );
}
