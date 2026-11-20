import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CATALOG } from '../lib/catalog';
import { defaultTemplate, isCreateable, templateFor, type CreateTemplate, type TemplateSource } from '../lib/templates';
import { useApp, type Tab } from '../state/store';
import { ResourceIcon } from './Icons';
import { YamlEditor } from './YamlEditor';

interface Option {
  id: string;
  label: string;
  source: TemplateSource;
}

/**
 * Create-from-YAML view. The initial document comes from the tab, which the
 * `+` button builds from whatever resource list was on screen — so clicking
 * `+` on Deployments opens a Deployment, on Services a Service, and so on.
 */
export function CreateResource({ tab }: { tab: Tab }) {
  const clusterId = tab.clusterId;
  const state = useApp((s) => s.states[clusterId]);
  const namespace = useApp((s) => s.settings.namespaceByCluster[clusterId] ?? 'all');
  const toast = useApp((s) => s.toast);
  const closeTab = useApp((s) => s.closeTab);
  const setCreateTemplate = useApp((s) => s.setCreateTemplate);
  const setCreateDraft = useApp((s) => s.setCreateDraft);

  const [template, setTemplate] = useState<CreateTemplate>(
    () => tab.create ?? defaultTemplate(namespace === 'all' ? undefined : namespace),
  );
  // The view is keyed by tab id, so a tab switch unmounts it; the draft lives
  // on the tab itself or it would be lost on the way back. An empty string is
  // a real draft — only `undefined` means "no draft, use the template".
  const [value, setValue] = useState(tab.createDraft !== undefined ? tab.createDraft : template.yaml);
  const [busy, setBusy] = useState(false);

  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => () => setCreateDraft(tab.id, valueRef.current), [tab.id, setCreateDraft]);

  /** Namespace to scaffold into: the filter, or the context default. */
  const targetNamespace = namespace === 'all' ? state?.cluster.namespace : namespace;

  const kindMap = useMemo(() => {
    const map: Record<string, { plural: string; namespaced: boolean }> = {};
    for (const resource of state?.resources ?? []) {
      map[resource.kind] = { plural: resource.plural, namespaced: resource.namespaced };
    }
    return map;
  }, [state?.resources]);

  // Built-in kinds that can be created, plus any CRDs this cluster exposes.
  const options = useMemo<Option[]>(() => {
    const built: Option[] = CATALOG.filter((kind) => isCreateable(kind.kind)).map((kind) => ({
      id: kind.id,
      label: kind.label,
      source: {
        kind: kind.kind,
        apiVersion: kind.apiVersion,
        plural: kind.plural,
        namespaced: kind.namespaced,
        label: kind.label,
      },
    }));
    const custom: Option[] = (state?.resources ?? [])
      .filter((resource) => resource.custom)
      .map((resource) => ({
        id: `cr:${resource.apiVersion}:${resource.plural}`,
        label: resource.kind,
        source: {
          kind: resource.kind,
          apiVersion: resource.apiVersion,
          plural: resource.plural,
          namespaced: resource.namespaced,
          label: resource.kind,
        },
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...built, ...custom];
  }, [state?.resources]);

  const currentOption =
    options.find(
      (option) => option.source.kind === template.kind && option.source.apiVersion === template.apiVersion,
    )?.id ?? '';

  const pickKind = (id: string) => {
    const option = options.find((entry) => entry.id === id);
    if (!option) return;
    const next = templateFor(option.source, targetNamespace);
    if (!next) return;
    setTemplate(next);
    setValue(next.yaml);
    setCreateTemplate(tab.id, next);
    // Drop the old draft, otherwise coming back to this tab would restore the
    // previous document instead of the newly picked template.
    setCreateDraft(tab.id, undefined);
  };

  const apply = async () => {
    setBusy(true);
    try {
      const results = await api.resources.applyYaml({ clusterId, yaml: value, kindMap });
      if (!results.length) {
        toast('Nothing to apply — the document has no kind.', 'error', {
          title: 'Nothing applied',
          detail: 'Add a "kind" and "metadata.name" to the YAML document.',
        });
      } else {
        toast(
          results.map((result) => `${result.kind} ${result.name}`).join(', ') + ' applied.',
          'success',
          { title: 'YAML applied', detail: results.map((r) => `${r.action}: ${r.kind} ${r.namespace ?? ''}/${r.name}`).join('\n') },
        );
        closeTab(tab.id);
      }
    } catch (err: any) {
      toast(err?.message ?? 'Apply failed', 'error', {
        title: 'Could not apply YAML',
        detail: err?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="toolbar">
        <ResourceIcon kind={template.kind} size={16} />
        <span className="toolbar-title">Create {template.kind}</span>
        <span className="toolbar-count">{template.apiVersion}</span>

        <div className="toolbar-spacer" />

        <select
          className="ns-select"
          value={currentOption}
          onChange={(event) => pickKind(event.target.value)}
          title="Template kind"
        >
          {currentOption === '' && <option value="">Custom YAML</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <button className="btn btn--ghost" onClick={() => setValue(template.yaml)}>
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
