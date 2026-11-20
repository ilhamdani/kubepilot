import { useApp } from '../state/store';
import { activeForwards } from '../state/rules';
import { CATALOG } from '../lib/catalog';
import { ResourceIcon } from './Icons';

export function StatusBar() {
  const activeClusterId = useApp((s) => s.activeClusterId);
  const state = useApp((s) => (activeClusterId ? s.states[activeClusterId] : undefined));
  const settings = useApp((s) => s.settings);
  const metrics = useApp((s) => s.metrics);
  const openResourceTab = useApp((s) => s.openResourceTab);
  const openOverviewTab = useApp((s) => s.openOverviewTab);
  const namespace = useApp((s) =>
    activeClusterId ? s.settings.namespaceByCluster[activeClusterId] ?? 'all' : 'all',
  );
  const openPalette = useApp((s) => s.togglePalette);
  const notifications = useApp((s) => s.notifications);
  const toggleNotifications = useApp((s) => s.toggleNotifications);
  const portForwards = useApp((s) => s.portForwards);
  const togglePortForwards = useApp((s) => s.togglePortForwards);

  const unread = notifications.filter((notice) => !notice.read).length;
  const forwarding = activeForwards(portForwards).length;
  const slots = Array.from({ length: 12 }, (_, index) => settings.hotbar[index]);

  return (
    <div className="statusbar">
      <div className="statusbar-item statusbar-brand" title="KubePilot — Kubernetes IDE">
        KubePilot
      </div>
      <div className="statusbar-sep" />
      <div className="statusbar-item">
        <span
          className={`conn-dot ${
            state?.status === 'error'
              ? 'conn-dot--error'
              : state?.status === 'connecting'
                ? 'conn-dot--connecting'
                : ''
          }`}
        />
        {state?.cluster.displayName ?? 'No cluster'}
      </div>
      {state?.version && <div className="statusbar-item">{state.version}</div>}
      {activeClusterId && (
        <div className="statusbar-item">
          namespace: <strong style={{ color: 'var(--textColorAccent)' }}>{namespace}</strong>
        </div>
      )}
      <div className="statusbar-item">
        {metrics.available ? 'metrics-server' : 'metrics unavailable'}
      </div>

      <div className="statusbar-spacer" />

      <div className="hotbar" title="Hotbar — pinned views">
        {slots.map((item, index) => {
          const target = item?.target;
          const def =
            target && target.type === 'resource'
              ? CATALOG.find(
                  (kind) =>
                    kind.plural === target.plural && kind.apiVersion === target.apiVersion,
                )
              : undefined;
          return (
            <button
              key={index}
              className={`hotbar-slot ${item ? 'hotbar-slot--filled' : ''}`}
              title={item ? `${index + 1}. ${item.title}` : `${index + 1}. empty`}
              onClick={() => {
                if (!item || !target) return;
                if (target.type === 'overview') {
                  openOverviewTab(item.clusterId);
                  return;
                }
                openResourceTab(item.clusterId, {
                  id: def?.id ?? `${target.apiVersion}:${target.plural}`,
                  kind: target.kind,
                  apiVersion: target.apiVersion,
                  plural: target.plural,
                  namespaced: target.namespaced,
                  label: item.title,
                });
              }}
            >
              {target?.type === 'resource' ? (
                <ResourceIcon kind={target.kind} size={13} />
              ) : item ? (
                <ResourceIcon kind="Node" size={13} />
              ) : (
                index + 1
              )}
            </button>
          );
        })}
      </div>

      {forwarding > 0 && (
        <button
          className="statusbar-item statusbar-item--clickable pf-statusbar"
          onClick={() => togglePortForwards(true)}
          title={`${forwarding} active port forward${forwarding === 1 ? '' : 's'} — click to manage`}
        >
          <span className="pf-statusbar-dot" />
          {forwarding} forwarding
        </button>
      )}

      <button
        className="statusbar-item statusbar-item--clickable notice-statusbar"
        onClick={() => toggleNotifications(true)}
        title={`Notifications${unread ? ` — ${unread} unread` : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4 1.2 4H2.8S4 9.5 4 6.5Z" />
          <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" />
        </svg>
        {unread > 0 && <span className="notice-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      <button
        className="statusbar-item statusbar-item--clickable"
        onClick={() => openPalette(true)}
        title="Command palette (Ctrl+K)"
      >
        Ctrl+K
      </button>
    </div>
  );
}
