import { create } from 'zustand';
import type {
  AppInfo,
  ClusterInfo,
  ClusterState,
  PodMetric,
  NodeMetric,
  ResourceRef,
  StoredSettings,
  HotbarItem,
} from '@shared/types';
import { api } from '../api';
import { defaultTemplate, templateFor, type CreateTemplate } from '../lib/templates';

export interface ResourceTabRef {
  id: string;
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  label: string;
}

export type TabKind = 'overview' | 'resource' | 'create' | 'settings' | 'split';

export interface Tab {
  id: string;
  clusterId: string;
  kind: TabKind;
  title: string;
  resource?: ResourceTabRef;
  /** Set on `create` tabs: the scaffold the `+` button opened with. */
  create?: CreateTemplate;
  /** Unsaved YAML of a `create` tab, kept across tab switches. */
  createDraft?: string;
  /** Set on `resource` tabs: the current filter text, kept across tab switches. */
  query?: string;
  /** Set on `split` tabs: the objects currently compared, one per side. */
  split?: { left?: ResourceRef; right?: ResourceRef };
}

export interface DetailsTarget {
  clusterId: string;
  ref: ResourceRef;
  kindId: string;
  tab: 'overview' | 'yaml' | 'events';
}

export interface DockTab {
  id: string;
  type: 'logs' | 'terminal';
  title: string;
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
}

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'error';
  message: string;
}

interface AppStore {
  ready: boolean;
  info?: AppInfo;
  clusters: ClusterInfo[];
  states: Record<string, ClusterState>;
  activeClusterId?: string;
  settings: StoredSettings;

  tabs: Tab[];
  activeTabId?: string;
  details?: DetailsTarget;

  dock: {
    open: boolean;
    height: number;
    fullSize: boolean;
    tabs: DockTab[];
    activeTabId?: string;
  };

  metrics: {
    pods: Map<string, { cpu: number; memory: number }>;
    nodes: Map<string, { cpu: number; memory: number }>;
    available: boolean;
  };

  paletteOpen: boolean;
  toasts: Toast[];

  init: () => Promise<void>;
  refreshClusters: () => Promise<void>;
  connect: (clusterId: string) => Promise<void>;
  setActiveCluster: (clusterId: string) => Promise<void>;
  setNamespace: (clusterId: string, namespace: string) => void;
  namespaceFor: (clusterId: string) => string;

  openResourceTab: (clusterId: string, resource: ResourceTabRef) => void;
  openOverviewTab: (clusterId: string) => void;
  /**
   * Opens a create tab. When `resource` is given the editor starts from that
   * kind's template; otherwise it falls back to a Deployment scaffold.
   */
  openCreateTab: (clusterId: string, resource?: ResourceTabRef) => void;
  /** Swaps the scaffold of an open create tab (kind picker). */
  setCreateTemplate: (tabId: string, template: CreateTemplate) => void;
  /**
   * Stores the unsaved YAML of a create tab so switching tabs does not throw
   * the draft away. `undefined` drops the draft (the tab falls back to its
   * template); `''` is a real draft — the user emptied the document.
   * A no-op once the tab is gone, which is what makes closing a tab drop its
   * draft with it.
   */
  setCreateDraft: (tabId: string, yaml?: string) => void;
  /** Same idea for the resource list's filter text. */
  setListQuery: (tabId: string, query: string) => void;
  openSettingsTab: () => void;
  /**
   * Opens a side-by-side YAML comparison. Either side may be empty, and the
   * two refs may point at different clusters.
   */
  openSplitTab: (clusterId: string, left?: ResourceRef, right?: ResourceRef) => void;
  /** Remembers what one side of a `split` tab shows, so switching tabs keeps it. */
  setSplitSide: (tabId: string, side: 'left' | 'right', ref?: ResourceRef) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;

  openDetails: (clusterId: string, ref: ResourceRef, kindId: string) => void;
  closeDetails: () => void;
  setDetailsTab: (tab: DetailsTarget['tab']) => void;

  openLogs: (params: { clusterId: string; namespace: string; pod: string; container?: string }) => void;
  openTerminal: (params: { clusterId: string; namespace: string; pod: string; container?: string }) => void;
  closeDockTab: (id: string) => void;
  activateDockTab: (id: string) => void;
  setDockOpen: (open: boolean) => void;
  setDockHeight: (height: number) => void;
  toggleDockFullSize: () => void;

  refreshMetrics: () => Promise<void>;
  togglePalette: (open?: boolean) => void;
  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
  setSettings: (patch: Partial<StoredSettings>) => Promise<void>;
  toggleHotbar: (item: HotbarItem) => Promise<void>;
}

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_SETTINGS: StoredSettings = {
  themeId: 'kubepilot-dark',
  hotbar: [],
  hiddenColumns: {},
  nodeShellImage: 'busybox:1.36',
  showMetrics: true,
  namespaceByCluster: {},
};

let metricsTimer: ReturnType<typeof setInterval> | undefined;

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  clusters: [],
  states: {},
  settings: DEFAULT_SETTINGS,
  tabs: [],
  dock: { open: false, height: 280, fullSize: false, tabs: [] },
  metrics: { pods: new Map(), nodes: new Map(), available: true },
  paletteOpen: false,
  toasts: [],

  async init() {
    const [info, clusters, states, settings] = await Promise.all([
      api.app.info(),
      api.clusters.list(),
      api.clusters.states(),
      api.settings.get(),
    ]);

    const stateMap: Record<string, ClusterState> = {};
    for (const state of states) stateMap[state.cluster.id] = state;

    set({ info, clusters, states: stateMap, settings, ready: true });

    api.clusters.onState((state) => {
      set((prev) => ({ states: { ...prev.states, [state.cluster.id]: state } }));
    });

    // Open the first cluster that has a kubeconfig so the app is useful
    // immediately; with no kubeconfig the UI explains how to add one.
    if (clusters.length) {
      await get().setActiveCluster(clusters[0].id);
    }
  },

  async refreshClusters() {
    const clusters = await api.clusters.list();
    set({ clusters });
  },

  async connect(clusterId) {
    const state = await api.clusters.connect(clusterId);
    set((prev) => ({ states: { ...prev.states, [clusterId]: state } }));
    if (state.status === 'connected') {
      const existing = get().tabs.filter((t) => t.clusterId === clusterId);
      // Only the cluster the user is looking at gets a landing tab; a
      // background connect (e.g. the second side of a YAML comparison) must
      // not yank the active tab away from what is on screen.
      if (!existing.length && get().activeClusterId === clusterId) {
        get().openOverviewTab(clusterId);
      }
      await get().refreshMetrics();
    }
  },

  async setActiveCluster(clusterId) {
    set({ activeClusterId: clusterId });
    const state = get().states[clusterId];
    if (!state || state.status !== 'connected') {
      await get().connect(clusterId);
    }
    const tabs = get().tabs.filter((t) => t.clusterId === clusterId);
    set({ activeTabId: tabs[0]?.id });
    if (!tabs.length) get().openOverviewTab(clusterId);
    await get().refreshMetrics();
  },

  setNamespace(clusterId, namespace) {
    const settings = get().settings;
    const next: StoredSettings = {
      ...settings,
      namespaceByCluster: { ...settings.namespaceByCluster, [clusterId]: namespace },
    };
    set({ settings: next });
    void api.settings.set({ namespaceByCluster: next.namespaceByCluster });
  },

  namespaceFor(clusterId) {
    return get().settings.namespaceByCluster[clusterId] ?? 'all';
  },

  openResourceTab(clusterId, resource) {
    const existing = get().tabs.find(
      (t) => t.clusterId === clusterId && t.resource?.id === resource.id && t.kind === 'resource',
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: Tab = {
      id: uid(),
      clusterId,
      kind: 'resource',
      title: resource.label,
      resource,
    };
    set((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  },

  openOverviewTab(clusterId) {
    const existing = get().tabs.find((t) => t.clusterId === clusterId && t.kind === 'overview');
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: Tab = { id: uid(), clusterId, kind: 'overview', title: 'Cluster Overview' };
    set((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  },

  openCreateTab(clusterId, resource) {
    const selected = get().settings.namespaceByCluster[clusterId] ?? 'all';
    // With "All namespaces" selected, scaffold into the context's namespace so
    // the manifest says where the object will land.
    const namespace =
      selected === 'all' ? get().states[clusterId]?.cluster.namespace : selected;
    const template = resource ? templateFor(resource, namespace) : defaultTemplate(namespace);
    const tab: Tab = {
      id: uid(),
      clusterId,
      kind: 'create',
      title: template ? `Create ${template.kind}` : 'Create Resource',
      create: template,
    };
    set((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  },

  setCreateTemplate(tabId, template) {
    set((prev) => ({
      tabs: prev.tabs.map((t) =>
        t.id === tabId ? { ...t, create: template, title: `Create ${template.kind}` } : t,
      ),
    }));
  },

  setCreateDraft(tabId, yaml) {
    set((prev) => ({
      tabs: prev.tabs.map((t) => {
        if (t.id !== tabId || t.kind !== 'create') return t;
        const next = { ...t, createDraft: yaml };
        if (yaml === undefined) delete next.createDraft;
        return next;
      }),
    }));
  },

  setListQuery(tabId, query) {
    set((prev) => ({
      tabs: prev.tabs.map((t) => (t.id === tabId && t.kind === 'resource' ? { ...t, query } : t)),
    }));
  },

  openSettingsTab() {
    const existing = get().tabs.find((t) => t.kind === 'settings');
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: Tab = { id: uid(), clusterId: get().activeClusterId ?? '', kind: 'settings', title: 'Preferences' };
    set((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  },

  openSplitTab(clusterId, left, right) {
    const tab: Tab = {
      id: uid(),
      clusterId,
      kind: 'split',
      title: 'Compare YAML',
      split: { left, right },
    };
    set((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  },

  setSplitSide(tabId, side, ref) {
    set((prev) => ({
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId && tab.kind === 'split'
          ? { ...tab, split: { ...tab.split, [side]: ref } }
          : tab,
      ),
    }));
  },

  activateTab(tabId) {
    set({ activeTabId: tabId });
  },

  closeTab(tabId) {
    const tabs = get().tabs;
    const index = tabs.findIndex((t) => t.id === tabId);
    const next = tabs.filter((t) => t.id !== tabId);
    const activeTabId =
      get().activeTabId === tabId ? (next[Math.max(0, index - 1)]?.id ?? next[0]?.id) : get().activeTabId;
    set({ tabs: next, activeTabId });
  },

  openDetails(clusterId, ref, kindId) {
    set({ details: { clusterId, ref, kindId, tab: 'overview' } });
  },

  closeDetails() {
    set({ details: undefined });
  },

  setDetailsTab(tab) {
    const details = get().details;
    if (details) set({ details: { ...details, tab } });
  },

  openLogs({ clusterId, namespace, pod, container }) {
    const existing = get().dock.tabs.find(
      (t) => t.type === 'logs' && t.pod === pod && t.container === container,
    );
    if (existing) {
      set((prev) => ({
        dock: { ...prev.dock, open: true, activeTabId: existing.id },
      }));
      return;
    }
    const tab: DockTab = {
      id: uid(),
      type: 'logs',
      title: container ? `${pod} · ${container}` : pod,
      clusterId,
      namespace,
      pod,
      container,
    };
    set((prev) => ({
      dock: { ...prev.dock, open: true, tabs: [...prev.dock.tabs, tab], activeTabId: tab.id },
    }));
  },

  openTerminal({ clusterId, namespace, pod, container }) {
    const tab: DockTab = {
      id: uid(),
      type: 'terminal',
      title: `${pod} · terminal`,
      clusterId,
      namespace,
      pod,
      container,
    };
    set((prev) => ({
      dock: { ...prev.dock, open: true, tabs: [...prev.dock.tabs, tab], activeTabId: tab.id },
    }));
  },

  closeDockTab(id) {
    set((prev) => {
      const tabs = prev.dock.tabs.filter((t) => t.id !== id);
      const activeTabId =
        prev.dock.activeTabId === id ? tabs[tabs.length - 1]?.id : prev.dock.activeTabId;
      return { dock: { ...prev.dock, tabs, activeTabId, open: tabs.length > 0 && prev.dock.open } };
    });
  },

  activateDockTab(id) {
    set((prev) => ({ dock: { ...prev.dock, activeTabId: id, open: true } }));
  },

  setDockOpen(open) {
    set((prev) => ({ dock: { ...prev.dock, open } }));
  },

  setDockHeight(height) {
    set((prev) => ({ dock: { ...prev.dock, height } }));
  },

  toggleDockFullSize() {
    set((prev) => ({ dock: { ...prev.dock, fullSize: !prev.dock.fullSize } }));
  },

  async refreshMetrics() {
    const clusterId = get().activeClusterId;
    const state = clusterId ? get().states[clusterId] : undefined;
    if (!clusterId || state?.status !== 'connected') return;
    if (!get().settings.showMetrics) {
      set({ metrics: { pods: new Map(), nodes: new Map(), available: false } });
      return;
    }
    const [pods, nodes] = await Promise.all([
      api.metrics.pods(clusterId).catch(() => []),
      api.metrics.nodes(clusterId).catch(() => []),
    ]);
    const podMap = new Map<string, { cpu: number; memory: number }>();
    for (const metric of pods as PodMetric[]) {
      podMap.set(`${metric.namespace}/${metric.name}`, { cpu: metric.cpu, memory: metric.memory });
    }
    const nodeMap = new Map<string, { cpu: number; memory: number }>();
    for (const metric of nodes as NodeMetric[]) {
      nodeMap.set(`/${metric.name}`, { cpu: metric.cpu, memory: metric.memory });
    }
    set({
      metrics: {
        pods: podMap,
        nodes: nodeMap,
        available: podMap.size > 0 || nodeMap.size > 0,
      },
    });
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = setInterval(() => {
      void get().refreshMetrics();
    }, 20_000);
  },

  togglePalette(open) {
    set((prev) => ({ paletteOpen: open ?? !prev.paletteOpen }));
  },

  toast(message, tone = 'info') {
    const id = uid();
    set((prev) => ({ toasts: [...prev.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), 4500);
  },

  dismissToast(id) {
    set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
  },

  async setSettings(patch) {
    const settings = await api.settings.set(patch);
    set({ settings });
  },

  async toggleHotbar(item) {
    const hotbar = get().settings.hotbar;
    const exists = hotbar.some((h) => h.id === item.id);
    const next = exists ? hotbar.filter((h) => h.id !== item.id) : [...hotbar, item].slice(-12);
    await get().setSettings({ hotbar: next });
  },
}));

/**
 * The resource collection currently on screen, if the active tab is a list.
 * This is what makes the `+` button context sensitive. The returned object is
 * the same reference stored on the tab, so it is safe as a selector result.
 */
export function useActiveResource(): ResourceTabRef | undefined {
  return useApp((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === 'resource' ? tab.resource : undefined;
  });
}
