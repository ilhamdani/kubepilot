import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { KubeObject, ResourceQuery, ResourceRef } from '@shared/types';
import { api } from '../api';
import { findKindById } from '../lib/catalog';
import { formatAge, formatAgeLong, formatDateTime, formatMemory, statusOf } from '../lib/format';
import { dumpObject } from '../lib/yaml';
import { useKubeList } from '../state/lists';
import { useApp } from '../state/store';
import { ResourceIcon, StatusBrick } from './Icons';
import { Modal } from './Overlays';
import { YamlEditor } from './YamlEditor';

export function DetailDrawer() {
  const details = useApp((s) => s.details);
  const closeDetails = useApp((s) => s.closeDetails);
  const setDetailsTab = useApp((s) => s.setDetailsTab);
  const openLogs = useApp((s) => s.openLogs);
  const openTerminal = useApp((s) => s.openTerminal);
  const openSplitTab = useApp((s) => s.openSplitTab);
  const toast = useApp((s) => s.toast);

  const [object, setObject] = useState<KubeObject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [width, setWidth] = useState<number>(520);

  const ref = details?.ref;
  const kindDef = details ? findKindById(details.kindId) : undefined;

  useEffect(() => {
    if (!ref) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    setDirty(false);
    void api.resources
      .get(ref)
      .then((result) => {
        if (!active) return;
        setObject(result);
        setDraft(dumpObject(result));
      })
      .catch((err: any) => active && setError(err?.message ?? 'Failed to load object'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ref?.clusterId, ref?.namespace, ref?.name, ref?.plural]);

  const eventsQuery: ResourceQuery | null = useMemo(() => {
    if (!details || details.tab !== 'events') return null;
    return {
      clusterId: details.clusterId,
      apiVersion: 'v1',
      plural: 'events',
      kind: 'Event',
      namespaced: true,
      namespace: ref?.namespace,
      fieldSelector: `involvedObject.name=${ref?.name}`,
    };
  }, [details?.clusterId, details?.tab, ref?.namespace, ref?.name]);

  const events = useKubeList(eventsQuery);

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (e: MouseEvent) => {
      const next = Math.min(Math.max(360, startWidth + (startX - e.clientX)), window.innerWidth - 400);
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!details || !ref) return null;

  const status = object ? statusOf(object) : { text: 'Loading', tone: 'vague' as const };

  const save = async () => {
    try {
      await api.resources.applyYaml({
        clusterId: details.clusterId,
        yaml: draft,
        kindMap: { [object?.kind ?? ref.kind]: { plural: ref.plural, namespaced: ref.namespaced } },
      });
      toast(`${ref.kind} ${ref.name} updated`, 'success');
      setDirty(false);
      const fresh = await api.resources.get(ref);
      setObject(fresh);
      setDraft(dumpObject(fresh));
    } catch (err: any) {
      toast(err?.message ?? 'Apply failed', 'error');
    }
  };

  const remove = async () => {
    try {
      await api.resources.remove(ref);
      toast(`${ref.kind} ${ref.name} deleted`, 'success');
      setConfirmDelete(false);
      closeDetails();
    } catch (err: any) {
      toast(err?.message ?? 'Delete failed', 'error');
    }
  };

  return (
    <div className="drawer" style={{ width }}>
      <div className="drawer-resizer" onMouseDown={startResize} />
      <div className="drawer-header">
        <div className="drawer-title-row">
          <ResourceIcon kind={ref.kind} size={18} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="drawer-title">{ref.name}</div>
            <div className="drawer-subtitle">
              {ref.kind}
              {ref.namespace ? ` · ${ref.namespace}` : ''}
            </div>
          </div>
          <span
            className="status-pill"
            style={{
              background:
                status.tone === 'ok'
                  ? 'var(--successTint)'
                  : status.tone === 'warning'
                    ? 'var(--warningTint)'
                    : status.tone === 'error'
                      ? 'var(--criticalTint)'
                      : 'var(--grey60)',
              color:
                status.tone === 'ok'
                  ? 'var(--colorOk)'
                  : status.tone === 'warning'
                    ? 'var(--colorWarning)'
                    : status.tone === 'error'
                      ? 'var(--colorError)'
                      : 'var(--textColorSecondary)',
            }}
          >
            {status.text}
          </span>
          <button className="icon-btn" onClick={closeDetails} title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="m3 3 6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>

        <div className="drawer-tabs">
          {(['overview', 'yaml', 'events'] as const).map((tab) => (
            <button
              key={tab}
              className={`drawer-tab ${details.tab === tab ? 'drawer-tab--active' : ''}`}
              onClick={() => setDetailsTab(tab)}
            >
              {tab === 'overview' ? 'Overview' : tab === 'yaml' ? 'YAML' : 'Events'}
            </button>
          ))}
        </div>
      </div>

      {details.tab === 'overview' && (
        <div className="drawer-body">
          {loading && <div className="hint">Loading…</div>}
          {error && <div className="warning-box">{error}</div>}
          {object && <Overview object={object} ref_={ref} kindId={details.kindId} />}

          <div className="section" style={{ marginTop: 18 }}>
            <div className="section-title">Actions</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ref.kind === 'Pod' && (
                <>
                  <button
                    className="btn"
                    onClick={() =>
                      openLogs({
                        clusterId: details.clusterId,
                        namespace: ref.namespace!,
                        pod: ref.name,
                        container: object?.spec?.containers?.[0]?.name,
                      })
                    }
                  >
                    Logs
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      openTerminal({
                        clusterId: details.clusterId,
                        namespace: ref.namespace!,
                        pod: ref.name,
                        container: object?.spec?.containers?.[0]?.name,
                      })
                    }
                  >
                    Terminal
                  </button>
                </>
              )}
              {kindDef?.restartable && (
                <button
                  className="btn"
                  onClick={async () => {
                    await api.resources.restart(ref);
                    toast('Rollout restart requested', 'success');
                  }}
                >
                  Restart
                </button>
              )}
              <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {details.tab === 'yaml' && (
        <div className="editor-shell">
          <YamlEditor
            value={draft}
            readOnly={false}
            onChange={(next) => {
              setDraft(next);
              setDirty(true);
            }}
          />
          <div className="editor-actions">
            {dirty && <span className="dirty-dot" />}
            <span className="hint">{dirty ? 'Unsaved changes' : 'Synced with cluster'}</span>
            <div style={{ flex: 1 }} />
            <button
              className="btn btn--ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(dumpObject(object));
                setDirty(false);
              }}
            >
              Revert
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => openSplitTab(details.clusterId, ref)}
              title="Compare this object's YAML with another object"
            >
              Compare
            </button>
            <button className="btn btn--primary" disabled={!dirty} onClick={() => void save()}>
              Apply
            </button>
          </div>
        </div>
      )}

      {details.tab === 'events' && (
        <div className="drawer-body">
          {events.loading && <div className="hint">Loading events…</div>}
          {!events.loading && events.items.length === 0 && (
            <div className="hint">No events recorded for this object.</div>
          )}
          <div className="detail-list">
            {events.items
              .slice()
              .sort(
                (a, b) =>
                  new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime(),
              )
              .map((event, index) => (
                <div className="detail-row" key={`${event.metadata?.name}-${index}`} style={{ alignItems: 'flex-start' }}>
                  <StatusBrick
                    tone={event.type === 'Warning' ? 'warning' : 'ok'}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--textColorAccent)' }}>
                      {event.reason}
                      <span className="hint" style={{ marginLeft: 8 }}>
                        {formatAge(event.lastTimestamp ?? event.eventTime)}
                      </span>
                    </div>
                    <div className="hint" style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>
                      {event.message}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {confirmDelete && (
        <Modal
          title={`Delete ${ref.kind}`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void remove()}>
                Delete
              </button>
            </>
          }
        >
          <div>
            Delete <strong>{ref.name}</strong>? This cannot be undone.
          </div>
        </Modal>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <div className="kv-key">{label}</div>
      <div className="kv-value">{value}</div>
    </>
  );
}

function Overview({ object, ref_, kindId }: { object: KubeObject; ref_: ResourceRef; kindId: string }) {
  const labels = object.metadata?.labels ?? {};
  const annotations = object.metadata?.annotations ?? {};
  const annotationKeys = Object.keys(annotations).filter(
    (key) => key !== 'kubectl.kubernetes.io/last-applied-configuration',
  );

  return (
    <>
      <div className="section">
        <div className="section-title">Metadata</div>
        <div className="kv">
          <KV label="Namespace" value={object.metadata?.namespace ?? '-'} />
          <KV label="Created" value={formatDateTime(object.metadata?.creationTimestamp)} />
          <KV label="Age" value={formatAgeLong(object.metadata?.creationTimestamp)} />
          <KV label="UID" value={<span className="mono">{object.metadata?.uid}</span>} />
          <KV label="Resource version" value={<span className="mono">{object.metadata?.resourceVersion}</span>} />
          {object.metadata?.ownerReferences?.map((owner: any) => (
            <KV key={owner.uid} label="Controlled by" value={`${owner.kind}/${owner.name}`} />
          ))}
        </div>
      </div>

      {Object.keys(labels).length > 0 && (
        <div className="section">
          <div className="section-title">Labels</div>
          <div className="chips">
            {Object.entries(labels).map(([key, value]) => (
              <span className="chip" key={key}>
                <span className="chip--key">{key}</span>
                {value ? `=${value}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {annotationKeys.length > 0 && (
        <div className="section">
          <div className="section-title">Annotations</div>
          <div className="kv">
            {annotationKeys.slice(0, 12).map((key) => (
              <KV
                key={key}
                label={key}
                value={<span style={{ wordBreak: 'break-word' }}>{String(annotations[key])}</span>}
              />
            ))}
          </div>
        </div>
      )}

      {object.kind === 'Pod' && <PodDetails object={object} />}
      {object.kind === 'Deployment' && <DeploymentDetails object={object} />}
      {object.kind === 'Service' && <ServiceDetails object={object} />}
      {object.kind === 'Node' && <NodeDetails object={object} />}
      {object.kind === 'Secret' && <SecretDetails object={object} />}
      {object.kind === 'ConfigMap' && <ConfigMapDetails object={object} />}

      {object.status?.conditions?.length > 0 && (
        <div className="section">
          <div className="section-title">Conditions</div>
          <div className="detail-list">
            {object.status.conditions.map((condition: any, index: number) => (
              <div className="detail-row" key={`${condition.type}-${index}`}>
                <StatusBrick tone={condition.status === 'True' ? 'ok' : 'warning'} />
                <span style={{ width: 150, color: 'var(--textColorAccent)' }}>{condition.type}</span>
                <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {condition.message ?? condition.reason ?? ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {object.metadata?.managedFields && (
        <div className="section">
          <div className="section-title">Managed by</div>
          <div className="chips">
            {Array.from(
              new Set(
                object.metadata.managedFields.map(
                  (field: any) => `${field.manager ?? 'unknown'} (${field.operation ?? '?'})`,
                ),
              ),
            ).map((label: any) => (
              <span className="chip" key={String(label)}>
                {String(label)}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function PodDetails({ object }: { object: KubeObject }) {
  const containers = object.spec?.containers ?? [];
  const statuses = object.status?.containerStatuses ?? [];
  return (
    <>
      <div className="section">
        <div className="section-title">Pod</div>
        <div className="kv">
          <KV label="Node" value={object.spec?.nodeName ?? '-'} />
          <KV label="Pod IP" value={<span className="mono">{object.status?.podIP ?? '-'}</span>} />
          <KV label="Host IP" value={<span className="mono">{object.status?.hostIP ?? '-'}</span>} />
          <KV label="Service account" value={object.spec?.serviceAccountName ?? 'default'} />
          <KV label="QoS class" value={object.status?.qosClass ?? '-'} />
        </div>
      </div>

      <div className="section">
        <div className="section-title">Containers</div>
        <div className="detail-list">
          {containers.map((container: any) => {
            const status = statuses.find((s: any) => s.name === container.name);
            const state = status?.state?.running
              ? 'Running'
              : status?.state?.waiting?.reason
                ? status.state.waiting.reason
                : status?.state?.terminated?.reason
                  ? status.state.terminated.reason
                  : 'Waiting';
            const tone = status?.ready ? 'ok' : state === 'Running' ? 'warning' : 'error';
            return (
              <div className="detail-row" key={container.name} style={{ alignItems: 'flex-start' }}>
                <StatusBrick tone={tone} style={{ marginTop: 3 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ color: 'var(--textColorAccent)' }}>{container.name}</div>
                  <div className="mono hint">{container.image}</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    {state} · restarts {status?.restartCount ?? 0}
                    {container.ports?.length
                      ? ` · port ${container.ports.map((p: any) => p.containerPort).join(', ')}`
                      : ''}
                    {container.resources?.limits?.memory
                      ? ` · limit ${formatMemory(Number.parseInt(container.resources.limits.memory, 10) * 1024 * 1024)}`
                      : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {object.spec?.volumes?.length > 0 && (
        <div className="section">
          <div className="section-title">Volumes</div>
          <div className="chips">
            {object.spec.volumes.map((volume: any) => (
              <span className="chip" key={volume.name}>
                {volume.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function DeploymentDetails({ object }: { object: KubeObject }) {
  return (
    <div className="section">
      <div className="section-title">Deployment</div>
      <div className="kv">
        <KV label="Replicas" value={`${object.status?.readyReplicas ?? 0} ready / ${object.spec?.replicas ?? 0} desired`} />
        <KV label="Strategy" value={object.spec?.strategy?.type ?? '-'} />
        <KV
          label="Selector"
          value={
            <span className="mono">
              {Object.entries(object.spec?.selector?.matchLabels ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '-'}
            </span>
          }
        />
        <KV label="Image" value={<span className="mono">{object.spec?.template?.spec?.containers?.[0]?.image}</span>} />
      </div>
    </div>
  );
}

function ServiceDetails({ object }: { object: KubeObject }) {
  return (
    <div className="section">
      <div className="section-title">Service</div>
      <div className="kv">
        <KV label="Type" value={object.spec?.type ?? '-'} />
        <KV label="Cluster IP" value={<span className="mono">{object.spec?.clusterIP ?? '-'}</span>} />
        <KV
          label="External IP"
          value={
            (object.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(', ') ||
            (object.spec?.externalIPs ?? []).join(', ') ||
            '-'
          }
        />
        <KV
          label="Ports"
          value={(object.spec?.ports ?? [])
            .map((p: any) => `${p.port} → ${p.targetPort}/${p.protocol ?? 'TCP'}`)
            .join(', ')}
        />
        <KV
          label="Selector"
          value={
            <span className="mono">
              {Object.entries(object.spec?.selector ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '-'}
            </span>
          }
        />
      </div>
    </div>
  );
}

function NodeDetails({ object }: { object: KubeObject }) {
  return (
    <div className="section">
      <div className="section-title">Node</div>
      <div className="kv">
        <KV label="Kubelet" value={object.status?.nodeInfo?.kubeletVersion ?? '-'} />
        <KV label="OS image" value={object.status?.nodeInfo?.osImage ?? '-'} />
        <KV label="Kernel" value={object.status?.nodeInfo?.kernelVersion ?? '-'} />
        <KV label="Runtime" value={object.status?.nodeInfo?.containerRuntimeVersion ?? '-'} />
        <KV label="CPU" value={object.status?.capacity?.cpu ?? '-'} />
        <KV label="Memory" value={object.status?.capacity?.memory ?? '-'} />
        <KV label="Pods" value={object.status?.capacity?.pods ?? '-'} />
        <KV
          label="Addresses"
          value={(object.status?.addresses ?? []).map((a: any) => a.address).join(', ') || '-'}
        />
      </div>
    </div>
  );
}

function SecretDetails({ object }: { object: KubeObject }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const data = object.data ?? {};
  return (
    <div className="section">
      <div className="section-title">
        Data
        <button
          className="btn btn--ghost"
          style={{ height: 20, fontSize: 11 }}
          onClick={() =>
            setRevealed(
              Object.keys(revealed).length === Object.keys(data).length
                ? {}
                : Object.fromEntries(Object.keys(data).map((key) => [key, true])),
            )
          }
        >
          {Object.keys(revealed).length === Object.keys(data).length ? 'Hide all' : 'Reveal all'}
        </button>
      </div>
      <div className="kv">
        {Object.entries(data).map(([key, value]) => (
          <KV
            key={key}
            label={key}
            value={
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {revealed[key] ? decodeSecret(String(value)) : `${String(value).slice(0, 24)}…`}
              </span>
            }
          />
        ))}
      </div>
    </div>
  );
}

function decodeSecret(value: string): string {
  try {
    return atob(value).slice(0, 400);
  } catch {
    return '<binary data>';
  }
}

function ConfigMapDetails({ object }: { object: KubeObject }) {
  const data = object.data ?? {};
  return (
    <div className="section">
      <div className="section-title">Data</div>
      <div className="kv">
        {Object.entries(data).map(([key, value]) => (
          <KV
            key={key}
            label={key}
            value={<span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>}
          />
        ))}
      </div>
    </div>
  );
}
