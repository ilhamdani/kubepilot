import { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state/store';
import { YamlEditor } from './YamlEditor';

const TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  labels:
    app: example
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: example
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
`;

export function CreateResource({ clusterId }: { clusterId: string }) {
  const state = useApp((s) => s.states[clusterId]);
  const namespace = useApp((s) => s.settings.namespaceByCluster[clusterId] ?? 'all');
  const toast = useApp((s) => s.toast);
  const closeTab = useApp((s) => s.closeTab);
  const activeTabId = useApp((s) => s.activeTabId);

  const initial = useMemo(() => {
    if (namespace === 'all') return TEMPLATE;
    return TEMPLATE.replace('metadata:\n  name: example', `metadata:\n  name: example\n  namespace: ${namespace}`);
  }, [namespace]);

  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  const kindMap = useMemo(() => {
    const map: Record<string, { plural: string; namespaced: boolean }> = {};
    for (const resource of state?.resources ?? []) {
      map[resource.kind] = { plural: resource.plural, namespaced: resource.namespaced };
    }
    return map;
  }, [state?.resources]);

  const apply = async () => {
    setBusy(true);
    try {
      const results = await api.resources.applyYaml({ clusterId, yaml: value, kindMap });
      if (!results.length) {
        toast('Nothing to apply — the document has no kind', 'error');
      } else {
        for (const result of results) {
          toast(`${result.kind} ${result.name} applied`, 'success');
        }
        if (activeTabId) closeTab(activeTabId);
      }
    } catch (err: any) {
      toast(err?.message ?? 'Apply failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="toolbar">
        <span className="toolbar-title">Create resource</span>
        <span className="toolbar-count">paste or edit YAML, then apply</span>
        <div className="toolbar-spacer" />
        <button className="btn btn--ghost" onClick={() => setValue(initial)}>
          Reset
        </button>
        <button className="btn btn--primary" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
      <div className="editor-shell">
        <YamlEditor value={value} onChange={setValue} />
      </div>
    </div>
  );
}
