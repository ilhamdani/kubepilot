import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state/store';

export function Settings() {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const info = useApp((s) => s.info);
  const refreshClusters = useApp((s) => s.refreshClusters);
  const toggleKubeconfigModal = useApp((s) => s.toggleKubeconfigModal);
  const toast = useApp((s) => s.toast);
  const kubeconfigModalOpen = useApp((s) => s.kubeconfigModalOpen);
  const [paths, setPaths] = useState<string[]>([]);

  // Refresh on open *and* close: closing is what a successful paste import does.
  useEffect(() => {
    void api.kubeconfig.paths().then(setPaths);
  }, [kubeconfigModalOpen]);

  const addKubeconfig = async () => {
    try {
      const result = await api.kubeconfig.add();
      setPaths(result.paths);
      if (result.added.length) {
        await refreshClusters();
        toast(`${result.added.length} kubeconfig file${result.added.length === 1 ? '' : 's'} added.`, 'success', {
          title: 'Kubeconfig added',
          detail: result.added.join('\n'),
        });
      }
    } catch (err: any) {
      toast(err?.message ?? 'Could not add the kubeconfig file.', 'error', {
        title: 'Could not add kubeconfig',
        detail: err?.message,
      });
    }
  };

  const removePath = async (path: string) => {
    try {
      const next = await api.kubeconfig.remove(path);
      setPaths(next);
      await refreshClusters();
      toast('Kubeconfig removed from KubePilot.', 'success', {
        title: 'Kubeconfig removed',
        detail: path,
      });
    } catch (err: any) {
      toast(err?.message ?? 'Could not remove the kubeconfig.', 'error', {
        title: 'Could not remove kubeconfig',
        detail: err?.message,
      });
    }
  };

  return (
    <div className="overview">
      <div className="overview-header">
        <div>
          <h2 className="overview-title">Preferences</h2>
          <div className="overview-sub">Application settings are stored per user profile.</div>
        </div>
      </div>

      <div className="grid grid--two">
        <div className="card">
          <div className="card-title">Appearance</div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Theme</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`btn ${settings.themeId === 'kubepilot-dark' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => void setSettings({ themeId: 'kubepilot-dark' })}
              >
                Dark
              </button>
              <button
                className={`btn ${settings.themeId === 'kubepilot-light' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => void setSettings({ themeId: 'kubepilot-light' })}
              >
                Light
              </button>
            </div>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.showMetrics}
                onChange={(event) => void setSettings({ showMetrics: event.target.checked })}
                style={{ width: 'auto' }}
              />
              Show CPU and memory columns (requires metrics-server)
            </label>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Kubeconfig files</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn--small" onClick={() => toggleKubeconfigModal(true)}>
                Paste YAML
              </button>
              <button className="btn btn--small" onClick={() => void addKubeconfig()}>
                Add file
              </button>
            </span>
          </div>
          {paths.length === 0 && (
            <div className="hint">No kubeconfig found. Paste one or add a file to connect a cluster.</div>
          )}
          <div className="detail-list">
            {paths.map((path) => (
              <div className="detail-row" key={path}>
                <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {path}
                </span>
                <button className="btn btn--ghost" onClick={() => void api.shell.showItem(path)}>
                  Reveal
                </button>
                <button className="btn btn--ghost" onClick={() => void removePath(path)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Contexts are read on startup from <span className="mono">KUBECONFIG</span>,{' '}
            <span className="mono">~/.kube/config</span> and the paths above.
          </div>
        </div>

        <div className="card">
          <div className="card-title">Terminal</div>
          <div className="field">
            <label>Node shell image</label>
            <input
              value={settings.nodeShellImage}
              onChange={(event) => void setSettings({ nodeShellImage: event.target.value })}
            />
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Used when opening a shell on a node (kubectl debug style).
          </div>
        </div>

        <div className="card">
          <div className="card-title">About</div>
          <div className="kv">
            <div className="kv-key">Version</div>
            <div className="kv-value">{info?.version ?? '-'}</div>
            <div className="kv-key">Electron</div>
            <div className="kv-value">{info?.electron ?? '-'}</div>
            <div className="kv-key">Chromium</div>
            <div className="kv-value">{info?.chrome ?? '-'}</div>
            <div className="kv-key">Node</div>
            <div className="kv-value">{info?.node ?? '-'}</div>
            <div className="kv-key">Platform</div>
            <div className="kv-value">{info?.platform ?? '-'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
