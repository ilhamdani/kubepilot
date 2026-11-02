import { isCreateable } from '../lib/templates';
import { useActiveResource, useApp } from '../state/store';
import { CloseIcon, ResourceIcon } from './Icons';

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const activateTab = useApp((s) => s.activateTab);
  const closeTab = useApp((s) => s.closeTab);
  const activeClusterId = useApp((s) => s.activeClusterId);
  const openCreateTab = useApp((s) => s.openCreateTab);
  const activeResource = useActiveResource();

  // `+` creates whatever the current list shows; kinds the cluster owns
  // (nodes, events) have no scaffold, so the action is disabled for them.
  const canCreate = !activeResource || isCreateable(activeResource.kind);
  const createTitle = !canCreate
    ? `${activeResource?.kind} objects cannot be created from YAML`
    : activeResource
      ? `Create ${activeResource.kind} from YAML`
      : 'Create resource from YAML';

  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'tab--active' : ''}`}
          onClick={() => activateTab(tab.id)}
          onAuxClick={(event) => {
            if (event.button === 1) closeTab(tab.id);
          }}
        >
          {tab.kind === 'overview' && (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--blue)" strokeWidth="1.4">
              <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
            </svg>
          )}
          {tab.kind === 'resource' && tab.resource && (
            <ResourceIcon kind={tab.resource.kind} size={13} />
          )}
          {tab.kind === 'create' && (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--colorWarning)" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          )}
          {tab.kind === 'settings' && (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="2" />
              <path d="M8 2v1.4M8 12.6V14M2 8h1.4M12.6 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" strokeLinecap="round" />
            </svg>
          )}
          <span className="tab-title">{tab.title}</span>
          <button
            className="tab-close"
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
            title="Close tab"
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}

      <div className="tabs-actions">
        {activeClusterId && (
          <button
            className="icon-btn"
            title={createTitle}
            disabled={!canCreate}
            onClick={() => openCreateTab(activeClusterId, activeResource)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
