import type { ClusterInfo, ClusterState } from '@shared/types';

interface Props {
  clusters: ClusterInfo[];
  states: Record<string, ClusterState>;
  activeClusterId?: string;
  onSelect: (clusterId: string) => void;
  onAddCluster: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

const AVATAR_COLORS = ['#14b8a6', '#c93dce', '#2aa198', '#d9a441', '#e08a3c', '#7e6bd9', '#43a047'];

function initials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || 'K8';
}

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function statusColor(status?: string): string {
  if (status === 'connected') return 'var(--colorOk)';
  if (status === 'connecting') return 'var(--colorWarning)';
  if (status === 'error') return 'var(--colorError)';
  return 'var(--textColorDimmed)';
}

export function ClusterRail({
  clusters,
  states,
  activeClusterId,
  onSelect,
  onAddCluster,
  onOpenSettings,
  onOpenPalette,
}: Props) {
  return (
    <div className="rail">
      <div className="rail-logo" title="KubePilot — Kubernetes IDE">
        <span className="rail-brand">KP</span>
      </div>

      <div className="rail-section">
        {clusters.map((cluster) => {
          const state = states[cluster.id];
          const active = cluster.id === activeClusterId;
          return (
            <button
              key={cluster.id}
              className={`rail-item ${active ? 'rail-item--active' : ''}`}
              onClick={() => onSelect(cluster.id)}
              title={`${cluster.displayName}\n${cluster.server}${
                state?.version ? `\n${state.version}` : ''
              }`}
            >
              <span
                className="rail-avatar"
                style={{ background: cluster.color ?? colorFor(cluster.displayName) }}
              >
                {initials(cluster.displayName)}
              </span>
              <span
                className="rail-dot"
                style={{ background: statusColor(state?.status) }}
                aria-hidden
              />
            </button>
          );
        })}

        <button className="rail-btn" onClick={onAddCluster} title="Add cluster from kubeconfig">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M9 4v10M4 9h10" />
          </svg>
        </button>
      </div>

      <div className="rail-footer">
        <button className="rail-btn" onClick={onOpenPalette} title="Command palette (Ctrl+K)">
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 5.5 9 9l5-3.5M4 9.5 9 13l5-3.5" />
          </svg>
        </button>
        <button className="rail-btn" onClick={onOpenSettings} title="Preferences">
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="9" cy="9" r="2.4" />
            <path d="M9 2.2v1.6M9 14.2v1.6M2.2 9h1.6M14.2 9h1.6M4.2 4.2l1.1 1.1M12.7 12.7l1.1 1.1M13.8 4.2l-1.1 1.1M5.3 12.7l-1.1 1.1" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
