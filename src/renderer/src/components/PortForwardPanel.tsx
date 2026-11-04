import type { PortForwardState } from '@shared/types';
import { activeForwards } from '../state/rules';
import { useApp } from '../state/store';
import { Modal } from './Overlays';

const STATUS_LABEL: Record<PortForwardState['status'], string> = {
  starting: 'Starting',
  active: 'Running',
  error: 'Error',
  stopped: 'Stopped',
};

export function portForwardLabel(forward: PortForwardState): string {
  return `localhost:${forward.localPort} → ${forward.name}:${forward.remotePort}`;
}

/** One tunnel with a Stop button. Shared by the detail sidebar and the panel. */
export function PortForwardRow({ forward, showCluster = false }: { forward: PortForwardState; showCluster?: boolean }) {
  const stopPortForward = useApp((s) => s.stopPortForward);
  const clusterName = useApp((s) =>
    s.clusters.find((c) => c.id === forward.clusterId)?.displayName ?? forward.clusterId,
  );

  return (
    <div className={`pf-row ${forward.status === 'error' ? 'pf-row--error' : ''}`}>
      <span className={`pf-dot pf-dot--${forward.status}`} title={STATUS_LABEL[forward.status]} />
      <div className="pf-main">
        <div className="pf-title mono">{portForwardLabel(forward)}</div>
        <div className="pf-meta">
          <span className={`pf-status pf-status--${forward.status}`}>{STATUS_LABEL[forward.status]}</span>
          <span>
            {forward.kind}/{forward.name} · {forward.namespace}
          </span>
          {showCluster && <span>· {clusterName}</span>}
        </div>
        {forward.error && <div className="pf-error">{forward.error}</div>}
      </div>
      <button
        className="btn btn--ghost btn--small"
        title={`Stop localhost:${forward.localPort}`}
        onClick={() => void stopPortForward(forward.id)}
      >
        Stop
      </button>
    </div>
  );
}

/** All tunnels across every cluster, opened from the status bar / palette. */
export function PortForwardPanel() {
  const open = useApp((s) => s.portForwardsOpen);
  const togglePortForwards = useApp((s) => s.togglePortForwards);
  const forwards = useApp((s) => s.portForwards);
  const stopAllPortForwards = useApp((s) => s.stopAllPortForwards);

  if (!open) return null;
  const running = activeForwards(forwards).length;

  return (
    <Modal
      title={`Port forwards${forwards.length ? ` (${forwards.length})` : ''}`}
      wide
      onClose={() => togglePortForwards(false)}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {running} running · tunnels stop when the app closes
          </span>
          <button
            className="btn btn--ghost"
            disabled={!forwards.length}
            onClick={() => void stopAllPortForwards()}
          >
            Stop all
          </button>
          <button className="btn btn--primary" onClick={() => togglePortForwards(false)}>
            Done
          </button>
        </>
      }
    >
      {forwards.length === 0 ? (
        <div className="pf-empty">
          <div className="pf-empty-title">No port forwards running</div>
          <div>Right-click a Pod or Service and choose “Port forward…”, or open a resource’s detail sidebar.</div>
        </div>
      ) : (
        <div className="pf-list">
          {forwards.map((forward) => (
            <PortForwardRow key={forward.id} forward={forward} showCluster />
          ))}
        </div>
      )}
    </Modal>
  );
}
