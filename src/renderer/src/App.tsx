import { useEffect } from 'react';
import { useApp } from './state/store';
import { ClusterRail } from './components/ClusterRail';
import { Navigator } from './components/Navigator';
import { TabBar } from './components/TabBar';
import { ItemList } from './components/ItemList';
import { Overview } from './components/Overview';
import { CreateResource } from './components/CreateResource';
import { Settings } from './components/Settings';
import { DetailDrawer } from './components/DetailDrawer';
import { Dock } from './components/Dock';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { api } from './api';

export function App() {
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const settings = useApp((s) => s.settings);
  const clusters = useApp((s) => s.clusters);
  const states = useApp((s) => s.states);
  const activeClusterId = useApp((s) => s.activeClusterId);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const details = useApp((s) => s.details);
  const toasts = useApp((s) => s.toasts);
  const setActiveCluster = useApp((s) => s.setActiveCluster);
  const closeTab = useApp((s) => s.closeTab);
  const togglePalette = useApp((s) => s.togglePalette);
  const closeDetails = useApp((s) => s.closeDetails);
  const openSettingsTab = useApp((s) => s.openSettingsTab);
  const toast = useApp((s) => s.toast);
  const refreshClusters = useApp((s) => s.refreshClusters);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.themeId;
  }, [settings.themeId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        togglePalette();
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        togglePalette(true);
      } else if (mod && event.key.toLowerCase() === 'w') {
        const state = useApp.getState();
        if (state.activeTabId) {
          event.preventDefault();
          closeTab(state.activeTabId);
        }
      } else if (event.key === 'Escape') {
        closeDetails();
      } else if (mod && event.key === ',') {
        event.preventDefault();
        openSettingsTab();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette, closeTab, closeDetails, openSettingsTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeState = activeClusterId ? states[activeClusterId] : undefined;

  const addCluster = async () => {
    const result = await api.kubeconfig.add();
    if (result.added.length) {
      await refreshClusters();
      toast(`Imported ${result.added.length} kubeconfig file(s)`, 'success');
    }
  };

  if (!ready) {
    return (
      <div className="app">
        <div className="welcome">
          <div className="spinner" />
          <div>Starting KubePilot…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <ClusterRail
        clusters={clusters}
        states={states}
        activeClusterId={activeClusterId}
        onSelect={(id) => void setActiveCluster(id)}
        onAddCluster={() => void addCluster()}
        onOpenSettings={openSettingsTab}
        onOpenPalette={() => togglePalette(true)}
      />

      {activeClusterId && (
        <Navigator
          clusterId={activeClusterId}
          state={activeState}
          activeResourceId={activeTab?.resource?.id}
        />
      )}

      <div className="main">
        <TabBar />

        <div
          className="main-body"
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}
        >
          <div className="main-column">
          {activeState?.status === 'connecting' && !activeTab && (
            <div className="center-fill">
              <div className="spinner" />
              <div>Connecting to {activeState.cluster.displayName}…</div>
            </div>
          )}

          {activeState?.status === 'error' && !activeTab && (
            <div className="welcome">
              <h2>Cannot reach the cluster</h2>
              <p>{activeState.error}</p>
              <div className="welcome-actions">
                <button
                  className="btn btn--primary"
                  onClick={() => void useApp.getState().connect(activeState.cluster.id)}
                >
                  Retry
                </button>
                <button className="btn btn--ghost" onClick={openSettingsTab}>
                  Check kubeconfig
                </button>
              </div>
            </div>
          )}

          {activeTab?.kind === 'overview' && activeState?.status === 'connected' && (
            <Overview clusterId={activeTab.clusterId} state={activeState} />
          )}

          {activeTab?.kind === 'resource' && activeTab.resource && (
            <ItemList clusterId={activeTab.clusterId} resource={activeTab.resource} />
          )}

          {activeTab?.kind === 'create' && <CreateResource clusterId={activeTab.clusterId} />}

          {activeTab?.kind === 'settings' && <Settings />}

          {!activeTab && activeState?.status === 'connected' && (
            <div className="welcome">
              <h2>{activeState.cluster.displayName}</h2>
              <p>Pick a resource from the navigator, or press Ctrl+K to search everything.</p>
              <div className="welcome-actions">
                <button
                  className="btn btn--primary"
                  onClick={() => useApp.getState().openOverviewTab(activeState.cluster.id)}
                >
                  Cluster overview
                </button>
              </div>
            </div>
          )}

            <Dock />
          </div>
          {details && <DetailDrawer />}
        </div>

        <StatusBar />
      </div>

      <CommandPalette />

      <div className="toasts">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.tone === 'error' ? 'toast--error' : item.tone === 'success' ? 'toast--success' : ''}`}
            onClick={() => useApp.getState().dismissToast(item.id)}
          >
            {item.message}
          </div>
        ))}
      </div>
    </div>
  );
}
