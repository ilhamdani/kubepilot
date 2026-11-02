import { useMemo } from 'react';
import type { ClusterState, ResourceQuery } from '@shared/types';
import { useKubeList } from '../state/lists';
import { useApp } from '../state/store';
import { formatAge, formatCpu, formatMemory, parseQuantity, statusOf } from '../lib/format';
import { ResourceIcon, StatusBrick } from './Icons';

interface Props {
  clusterId: string;
  state: ClusterState;
}

const q = (
  clusterId: string,
  apiVersion: string,
  plural: string,
  kind: string,
  namespaced: boolean,
): ResourceQuery => ({ clusterId, apiVersion, plural, kind, namespaced });

export function Overview({ clusterId, state }: Props) {
  const pods = useKubeList(q(clusterId, 'v1', 'pods', 'Pod', true));
  const nodes = useKubeList(q(clusterId, 'v1', 'nodes', 'Node', false));
  const deployments = useKubeList(q(clusterId, 'apps/v1', 'deployments', 'Deployment', true));
  const events = useKubeList(q(clusterId, 'v1', 'events', 'Event', true));
  const nodeMetrics = useApp((s) => s.metrics.nodes);
  const openResourceTab = useApp((s) => s.openResourceTab);

  const stats = useMemo(() => {
    const running = pods.items.filter((pod) => pod.status?.phase === 'Running').length;
    const pending = pods.items.filter((pod) => pod.status?.phase === 'Pending').length;
    const failing = pods.items.filter((pod) => {
      const tone = statusOf(pod).tone;
      return tone === 'error';
    }).length;
    const restarts = pods.items.reduce(
      (sum, pod) =>
        sum + (pod.status?.containerStatuses ?? []).reduce((acc: number, c: any) => acc + (c.restartCount ?? 0), 0),
      0,
    );
    const nodesReady = nodes.items.filter((node) => statusOf(node).tone === 'ok').length;
    const deploymentsReady = deployments.items.filter(
      (d) => (d.status?.readyReplicas ?? 0) >= (d.spec?.replicas ?? 0),
    ).length;

    let cpuCapacity = 0;
    let memoryCapacity = 0;
    for (const node of nodes.items) {
      cpuCapacity += parseQuantity(node.status?.allocatable?.cpu ?? node.status?.capacity?.cpu, 'cpu');
      memoryCapacity += parseQuantity(
        node.status?.allocatable?.memory ?? node.status?.capacity?.memory,
        'memory',
      );
    }
    let cpuUsed = 0;
    let memoryUsed = 0;
    for (const metric of nodeMetrics.values()) {
      cpuUsed += metric.cpu;
      memoryUsed += metric.memory;
    }

    return {
      running,
      pending,
      failing,
      restarts,
      totalPods: pods.items.length,
      nodesReady,
      totalNodes: nodes.items.length,
      deploymentsReady,
      totalDeployments: deployments.items.length,
      cpuCapacity,
      memoryCapacity,
      cpuUsed,
      memoryUsed,
      cpuPercent: cpuCapacity ? (cpuUsed / cpuCapacity) * 100 : 0,
      memoryPercent: memoryCapacity ? (memoryUsed / memoryCapacity) * 100 : 0,
    };
  }, [pods.items, nodes.items, deployments.items, nodeMetrics]);

  const issues = useMemo(() => {
    const warningEvents = events.items
      .filter((event) => event.type === 'Warning')
      .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
      .slice(0, 8);
    return warningEvents;
  }, [events.items]);

  const unhealthyWorkloads = useMemo(
    () =>
      deployments.items
        .filter((d) => (d.status?.readyReplicas ?? 0) < (d.spec?.replicas ?? 0))
        .slice(0, 6),
    [deployments.items],
  );

  const openPods = () =>
    openResourceTab(clusterId, {
      id: 'pods',
      kind: 'Pod',
      apiVersion: 'v1',
      plural: 'pods',
      namespaced: true,
      label: 'Pods',
    });

  return (
    <div className="overview">
      <div className="overview-header">
        <div>
          <h2 className="overview-title">{state.cluster.displayName}</h2>
          <div className="overview-sub">
            {state.cluster.server} · Kubernetes {state.version} · connected{' '}
            {state.connectedAt ? formatAge(new Date(state.connectedAt).toISOString()) : 'now'} ago
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={openPods}>
            Open Pods
          </button>
        </div>
      </div>

      <div className="grid grid--stats">
        <div className="card">
          <div className="card-title">Pods</div>
          <div className="stat-value">{stats.totalPods}</div>
          <div className="stat-label">{stats.running} running</div>
          <div className="stat-foot">
            <span style={{ color: stats.failing ? 'var(--colorError)' : 'var(--textColorDimmed)' }}>
              {stats.failing} failing
            </span>
            <span style={{ color: stats.pending ? 'var(--colorWarning)' : 'var(--textColorDimmed)' }}>
              {stats.pending} pending
            </span>
            <span className="muted">{stats.restarts} restarts</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Nodes</div>
          <div className="stat-value">{stats.totalNodes}</div>
          <div className="stat-label">
            {stats.nodesReady} ready
          </div>
          <div className="stat-foot">
            <span className="muted">{stats.totalNodes - stats.nodesReady} not ready</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Deployments</div>
          <div className="stat-value">{stats.totalDeployments}</div>
          <div className="stat-label">
            {stats.deploymentsReady} fully available
          </div>
          <div className="stat-foot">
            <span
              style={{
                color:
                  stats.deploymentsReady === stats.totalDeployments
                    ? 'var(--colorOk)'
                    : 'var(--colorWarning)',
              }}
            >
              {stats.totalDeployments - stats.deploymentsReady} degraded
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Namespaces</div>
          <div className="stat-value">{state.namespaces?.length ?? 0}</div>
          <div className="stat-label">visible to this context</div>
          <div className="stat-foot">
            <span className="muted">{state.resources?.length ?? 0} resource kinds</span>
          </div>
        </div>
      </div>

      <div className="grid grid--two" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-title">
            <span>CPU</span>
            <span className="muted">
              {formatCpu(stats.cpuUsed)} / {formatCpu(stats.cpuCapacity)}
            </span>
          </div>
          <div className="stat-value" style={{ fontSize: 22 }}>
            {stats.cpuPercent.toFixed(0)}%
          </div>
          <div className="bar">
            <div
              className={`bar-fill ${stats.cpuPercent > 85 ? 'bar-fill--crit' : stats.cpuPercent > 65 ? 'bar-fill--warn' : ''}`}
              style={{ width: `${Math.min(100, stats.cpuPercent)}%` }}
            />
          </div>
          <div className="stat-foot">
            <span className="muted">allocatable across {stats.totalNodes} nodes</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Memory</span>
            <span className="muted">
              {formatMemory(stats.memoryUsed)} / {formatMemory(stats.memoryCapacity)}
            </span>
          </div>
          <div className="stat-value" style={{ fontSize: 22 }}>
            {stats.memoryPercent.toFixed(0)}%
          </div>
          <div className="bar">
            <div
              className={`bar-fill ${stats.memoryPercent > 85 ? 'bar-fill--crit' : stats.memoryPercent > 65 ? 'bar-fill--warn' : ''}`}
              style={{ width: `${Math.min(100, stats.memoryPercent)}%` }}
            />
          </div>
          <div className="stat-foot">
            <span className="muted">reported by metrics-server</span>
          </div>
        </div>
      </div>

      <div className="grid grid--two">
        <div className="card">
          <div className="card-title">
            <span>Recent warnings</span>
            <span className="muted">{issues.length}</span>
          </div>
          {issues.length === 0 && <div className="hint">No warning events. Nice.</div>}
          {issues.map((event, index) => (
            <div className="issue-row" key={`${event.metadata?.name}-${index}`}>
              <StatusBrick tone="warning" />
              <span style={{ width: 130, color: 'var(--textColorAccent)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {event.involvedObject?.name}
              </span>
              <span className="issue-msg" style={{ flex: 1 }}>
                {event.message}
              </span>
              <span className="hint">{formatAge(event.lastTimestamp)}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-title">
            <span>Degraded workloads</span>
            <span className="muted">{unhealthyWorkloads.length}</span>
          </div>
          {unhealthyWorkloads.length === 0 && (
            <div className="hint">Every deployment has its desired replicas available.</div>
          )}
          {unhealthyWorkloads.map((deployment) => (
            <div className="issue-row" key={deployment.metadata?.uid}>
              <ResourceIcon kind="Deployment" size={14} />
              <span style={{ width: 160, color: 'var(--textColorAccent)' }}>
                {deployment.metadata?.name}
              </span>
              <span className="issue-msg" style={{ flex: 1 }}>
                {deployment.status?.readyReplicas ?? 0} / {deployment.spec?.replicas ?? 0} replicas ready
              </span>
              <span className="hint">{deployment.metadata?.namespace}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
