import { useEffect } from 'react';
import { useApp } from './state/store';
import { ClusterRail } from './components/ClusterRail';
import { Navigator } from './components/Navigator';
import { TabBar } from './components/TabBar';
import { ItemList } from './components/ItemList';
import { Overview } from './components/Overview';
import { CreateResource } from './components/CreateResource';
import { Settings } from './components/Settings';
import { SplitView } from './components/SplitView';
import { DetailDrawer } from './components/DetailDrawer';
import { Dock } from './components/Dock';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { AddKubeconfigModal } from './components/AddKubeconfigModal';
import { PortForwardPanel } from './components/PortForwardPanel';
import { NotificationCenter, Toasts } from './components/Notifications';

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
  const setActiveCluster = useApp((s) => s.setActiveCluster);
  const closeTab = useApp((s) => s.closeTab);
  const requestCloseAllTabs = useApp((s) => s.requestCloseAllTabs);
  const togglePalette = useApp((s) => s.togglePalette);
  const toggleKubeconfigModal = useApp((s) => s.toggleKubeconfigModal);
  const closeDetails = useApp((s) => s.closeDetails);
  const openSettingsTab = useApp((s) => s.openSettingsTab);

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
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        requestCloseAllTabs();
      } else if (mod && event.key.toLowerCase() === 'w') {
        const state = useApp.getState();
        if (state.activeTabId) {
          event.preventDefault();
          closeTab(state.activeTabId);
        }
      } else if (event.key === 'Escape') {
        // A modal, the palette or a context menu owns Escape while it is on
        // screen. Their own handler closes them; closing the drawer behind
        // them at the same time would lose the resource the user is reading.
        const overlay = document.querySelector('.modal-overlay, .palette-overlay, .context-menu');
        if (!overlay) closeDetails();
      } else if (mod && event.key === ',') {
        event.preventDefault();
        openSettingsTab();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette, closeTab, requestCloseAllTabs, closeDetails, openSettingsTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeState = activeClusterId ? states[activeClusterId] : undefined;

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
        onAddCluster={() => toggleKubeconfigModal(true)}
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

          {/* Each tab owns its view: without the key React reuses one instance
              for every tab of the same kind, leaking one tab's state into the
              next (two create tabs showing the same YAML, two split tabs
              sharing a selection). */}
          {activeTab?.kind === 'overview' && activeState?.status === 'connected' && (
            <Overview key={activeTab.id} clusterId={activeTab.clusterId} state={activeState} />
          )}

          {activeTab?.kind === 'resource' && activeTab.resource && (
            <ItemList
              key={activeTab.id}
              tabId={activeTab.id}
              clusterId={activeTab.clusterId}
              resource={activeTab.resource}
            />
          )}

          {activeTab?.kind === 'create' && <CreateResource key={activeTab.id} tab={activeTab} />}

          {activeTab?.kind === 'split' && <SplitView key={activeTab.id} tab={activeTab} />}

          {activeTab?.kind === 'settings' && <Settings key={activeTab.id} />}

          {!activeClusterId && (
            <div className="welcome">
              <h2>No cluster yet</h2>
              <p>
                KubePilot reads contexts from your kubeconfig. None were found in{' '}
                <span className="mono">~/.kube/config</span> or the paths listed in Preferences. Paste the
                YAML directly or pick a file.
              </p>
              <div className="welcome-actions">
                <button className="btn btn--primary" onClick={() => toggleKubeconfigModal(true)}>
                  Paste / add kubeconfig
                </button>
                <button className="btn btn--ghost" onClick={openSettingsTab}>
                  Preferences
                </button>
              </div>
            </div>
          )}

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
      <AddKubeconfigModal />
      <PortForwardPanel />
      <NotificationCenter />
      <Toasts />
    </div>
  );
}
