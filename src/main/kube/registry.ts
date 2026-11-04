import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { app } from 'electron';
import type { ClusterInfo, ClusterState, StoredSettings } from '@shared/types';
import { defaultKubeconfigPaths, listClusters } from './config';
import { LiveBackend } from './live';
import type { ClusterBackend } from './backend';

const DEFAULT_SETTINGS: StoredSettings = {
  themeId: 'kubepilot-dark',
  hotbar: [],
  hiddenColumns: {},
  nodeShellImage: 'busybox:1.36',
  showMetrics: true,
  namespaceByCluster: {},
};

interface PersistedConfig extends StoredSettings {
  kubeconfigPaths: string[];
  clusterDisplayNames?: Record<string, string>;
}

export class ClusterRegistry {
  private backends = new Map<string, ClusterBackend>();
  private states = new Map<string, ClusterState>();
  private config: PersistedConfig;
  private configPath: string;
  private importDir: string;
  private listeners = new Set<(state: ClusterState) => void>();

  constructor() {
    const userData = app.getPath('userData');
    this.configPath = join(userData, 'kubepilot-settings.json');
    // Kubeconfigs pasted into the app live here, separate from the user's own
    // files, so "Remove" can delete the credentials it created without ever
    // touching ~/.kube/config or a file the user picked in a dialog.
    this.importDir = join(userData, 'kubeconfigs');
    this.config = this.loadConfig();
  }

  private loadConfig(): PersistedConfig {
    try {
      if (existsSync(this.configPath)) {
        const parsed = JSON.parse(readFileSync(this.configPath, 'utf8'));
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          kubeconfigPaths: parsed.kubeconfigPaths ?? [],
        };
      }
    } catch {
      /* fall through to defaults */
    }
    return { ...DEFAULT_SETTINGS, kubeconfigPaths: [] };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch {
      /* settings are best-effort */
    }
  }

  get settings(): StoredSettings {
    const { kubeconfigPaths: _paths, clusterDisplayNames: _names, ...rest } = this.config;
    return rest;
  }

  updateSettings(patch: Partial<StoredSettings>): StoredSettings {
    this.config = { ...this.config, ...patch };
    this.save();
    return this.settings;
  }

  get kubeconfigPaths(): string[] {
    return this.config.kubeconfigPaths;
  }

  /** Directory that holds kubeconfigs pasted into the app. */
  get kubeconfigImportDir(): string {
    return this.importDir;
  }

  /** Context names already visible, used to avoid `live:<name>` id collisions. */
  existingContextNames(): string[] {
    return this.listClusters().map((cluster) => cluster.name);
  }

  isManagedKubeconfig(path: string): boolean {
    const root = resolve(this.importDir) + sep;
    return resolve(path).startsWith(root);
  }

  allKubeconfigPaths(): string[] {
    return defaultKubeconfigPaths(this.config.kubeconfigPaths);
  }

  addKubeconfigPath(path: string): string[] {
    if (!this.config.kubeconfigPaths.includes(path)) {
      this.config.kubeconfigPaths.push(path);
      this.save();
    }
    return this.allKubeconfigPaths();
  }

  removeKubeconfigPath(path: string): string[] {
    this.config.kubeconfigPaths = this.config.kubeconfigPaths.filter((p) => p !== path);
    this.save();
    // A pasted kubeconfig can contain long-lived credentials. Once it is no
    // longer referenced, delete the copy this app created. Files the user
    // picked in a dialog are never touched.
    if (this.isManagedKubeconfig(path)) {
      try {
        unlinkSync(resolve(path));
      } catch {
        /* already gone, or locked — the path is no longer used either way */
      }
    }
    return this.allKubeconfigPaths();
  }

  listClusters(): ClusterInfo[] {
    let live: ClusterInfo[] = [];
    try {
      live = listClusters(this.allKubeconfigPaths());
    } catch {
      live = [];
    }
    const displayNames = this.config.clusterDisplayNames ?? {};
    return live.map((c) => ({
      ...c,
      displayName: displayNames[c.id] ?? c.displayName,
    }));
  }

  getState(clusterId: string): ClusterState | undefined {
    return this.states.get(clusterId);
  }

  allStates(): ClusterState[] {
    return [...this.states.values()];
  }

  onStateChange(listener: (state: ClusterState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(state: ClusterState) {
    this.states.set(state.cluster.id, state);
    for (const listener of this.listeners) listener(state);
  }

  backend(clusterId: string): ClusterBackend {
    const existing = this.backends.get(clusterId);
    if (existing) return existing;
    const backend = new LiveBackend(clusterId, this.allKubeconfigPaths());
    this.backends.set(clusterId, backend);
    return backend;
  }

  async connect(clusterId: string): Promise<ClusterState> {
    const cluster = this.listClusters().find((c) => c.id === clusterId);
    if (!cluster) throw new Error(`Unknown cluster "${clusterId}"`);

    const connecting: ClusterState = {
      cluster,
      status: 'connecting',
    };
    this.publish(connecting);

    try {
      const backend = this.backend(clusterId);
      const result = await backend.connect();
      const connected: ClusterState = {
        cluster,
        status: 'connected',
        version: result.version,
        namespaces: result.namespaces,
        namespacesForbidden: result.namespacesForbidden,
        resources: result.resources,
        connectedAt: Date.now(),
      };
      this.publish(connected);
      return connected;
    } catch (err: any) {
      const failed: ClusterState = {
        cluster,
        status: 'error',
        error: err?.message ?? String(err),
      };
      this.publish(failed);
      return failed;
    }
  }

  async disconnect(clusterId: string): Promise<void> {
    this.backends.delete(clusterId);
    const cluster = this.listClusters().find((c) => c.id === clusterId);
    if (cluster) this.publish({ cluster, status: 'disconnected' });
  }
}
