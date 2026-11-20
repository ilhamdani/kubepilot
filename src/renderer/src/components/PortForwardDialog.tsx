import { useState } from 'react';
import type { KubeObject } from '@shared/types';
import { activeForwards } from '../state/rules';
import { useApp } from '../state/store';
import { Modal } from './Overlays';

interface Props {
  object: KubeObject;
  clusterId: string;
  onClose: () => void;
}

const isPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** Shared by the resource list's context menu and the detail drawer. */
export function PortForwardDialog({ object, clusterId, onClose }: Props) {
  const startPortForward = useApp((s) => s.startPortForward);
  const portForwards = useApp((s) => s.portForwards);
  const toast = useApp((s) => s.toast);

  const remoteDefault =
    object.kind === 'Pod'
      ? (object.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 8080)
      : (object.spec?.ports?.[0]?.port ?? 80);
  const [localPort, setLocalPort] = useState<number>(remoteDefault);
  const [remotePort, setRemotePort] = useState<number>(remoteDefault);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const busyLocalPorts = activeForwards(portForwards).map((entry) => entry.localPort);

  const start = async () => {
    setError(undefined);
    if (!isPort(localPort) || !isPort(remotePort)) {
      setError('Ports must be whole numbers between 1 and 65535.');
      return;
    }
    if (busyLocalPorts.includes(localPort)) {
      setError(`Local port ${localPort} is already in use by another port forward.`);
      return;
    }
    setBusy(true);
    try {
      const result = await startPortForward({
        clusterId,
        namespace: object.metadata?.namespace ?? '',
        kind: object.kind === 'Pod' ? 'pod' : 'service',
        name: object.metadata?.name ?? '',
        localPort,
        remotePort,
      });
      if (result.status === 'error') {
        setError(result.error ?? 'Port forward failed');
        return;
      }
      toast(`localhost:${localPort} → ${object.metadata?.name}:${remotePort} is starting.`, 'success', {
        title: 'Port forward started',
        detail: 'Find it in the detail sidebar or the port-forward panel, where you can stop it.',
      });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Port forward failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Port forward"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </>
      }
    >
      <div>
        Forward a local port to{' '}
        <strong style={{ color: 'var(--textColorAccent)' }}>
          {object.kind?.toLowerCase()}/{object.metadata?.name}
        </strong>
        . Uses the local <span className="mono">kubectl</span> binary.
      </div>
      <div className="field-row">
        <div className="field">
          <label>Local port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={localPort}
            onChange={(event) => setLocalPort(Number(event.target.value))}
          />
        </div>
        <div className="field">
          <label>Remote port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={remotePort}
            onChange={(event) => setRemotePort(Number(event.target.value))}
          />
        </div>
      </div>
      {busyLocalPorts.length > 0 && (
        <div className="hint">Local ports already in use: {busyLocalPorts.join(', ')}</div>
      )}
      {error && <div className="warning-box">{error}</div>}
    </Modal>
  );
}
