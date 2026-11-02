/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keeping this file dependency-free means it can be imported from
 * either side of the context bridge without pulling Node APIs into the UI.
 */

export type ClusterConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ClusterInfo {
  /** Stable id: `live:<contextName>`. */
  id: string;
  /** Context name as it appears in the kubeconfig. */
  name: string;
  /** Human friendly display name (defaults to the context name). */
  displayName: string;
  server: string;
  userName?: string;
  namespace?: string;
  /** Which kubeconfig file the context came from. */
  kubeconfigPath: string;
  /** Optional per-cluster accent colour, used by the cluster rail. */
  color?: string;
}

export interface ClusterState {
  cluster: ClusterInfo;
  status: ClusterConnectionStatus;
  error?: string;
  /** Server version string, e.g. `v1.29.4+k3s1`. */
  version?: string;
  /** Namespaces the current credentials can see. */
  namespaces?: string[];
  /** False when the user is not allowed to list namespaces cluster-wide. */
  namespacesForbidden?: boolean;
  /** Result of `/api` + `/apis` discovery, keyed by `kind`. */
  resources?: DiscoveredResource[];
  connectedAt?: number;
}

export interface DiscoveredResource {
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  verbs: string[];
  group?: string;
  /** True for `*.example.com` style custom resources. */
  custom?: boolean;
}

/** Identifies one resource collection. */
export interface ResourceQuery {
  clusterId: string;
  apiVersion: string;
  plural: string;
  kind: string;
  namespaced: boolean;
  /** Empty string means "all namespaces". */
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
}

/** Identifies a single object. */
export interface ResourceRef {
  clusterId: string;
  apiVersion: string;
  plural: string;
  kind: string;
  namespaced: boolean;
  namespace?: string;
  name: string;
}

export interface ListResult {
  items: KubeObject[];
  resourceVersion?: string;
}

export type KubeObject = Record<string, any>;

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';

export interface WatchEvent {
  watchId: string;
  type: WatchEventType;
  object: KubeObject;
}

export interface LogRequest {
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  follow?: boolean;
  tailLines?: number;
  previous?: boolean;
  timestamps?: boolean;
}

export interface ExecRequest {
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  command: string[];
  tty?: boolean;
}

export interface ExecData {
  sessionId: string;
  /** `stdout` and `stderr` are rendered differently by the terminal. */
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface PodMetric {
  namespace: string;
  name: string;
  containers: Array<{ name: string; cpu: number; memory: number }>;
  cpu: number;
  memory: number;
  timestamp?: string;
}

export interface NodeMetric {
  name: string;
  cpu: number;
  memory: number;
  timestamp?: string;
}

export interface PortForwardRequest {
  clusterId: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  /** Local port; 0 lets the OS choose. */
  localPort: number;
  remotePort: number;
}

export interface PortForwardState {
  id: string;
  clusterId: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  localPort: number;
  remotePort: number;
  status: 'starting' | 'active' | 'error' | 'stopped';
  error?: string;
}

export interface ApplyResult {
  kind: string;
  name: string;
  namespace?: string;
  action: 'created' | 'configured' | 'unchanged' | 'patched';
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  kubeconfigPaths: string[];
  homeDir: string;
}

export interface StoredSettings {
  themeId: 'kubepilot-dark' | 'kubepilot-light';
  /** Pinned items in the hotbar. */
  hotbar: HotbarItem[];
  /** Column visibility per resource kind. */
  hiddenColumns: Record<string, string[]>;
  /** Remembered terminal image for node shells. */
  nodeShellImage: string;
  /** Show CPU/memory columns when metrics-server is reachable. */
  showMetrics: boolean;
  /** Namespace filter per cluster. */
  namespaceByCluster: Record<string, string>;
}

export interface HotbarItem {
  id: string;
  clusterId: string;
  title: string;
  icon?: string;
  target:
    | { type: 'resource'; apiVersion: string; plural: string; kind: string; namespaced: boolean }
    | { type: 'overview' };
}
