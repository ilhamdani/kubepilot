import type {
  ApplyResult,
  AppInfo,
  ClusterInfo,
  ClusterState,
  ExecData,
  ExecRequest,
  KubeObject,
  ListResult,
  LogRequest,
  NodeMetric,
  PodMetric,
  PortForwardState,
  ResourceQuery,
  ResourceRef,
  StoredSettings,
  WatchEvent,
} from '@shared/types';

export interface KubeApi {
  app: {
    info: () => Promise<AppInfo>;
    relogin: () => Promise<boolean>;
  };
  clusters: {
    list: () => Promise<ClusterInfo[]>;
    states: () => Promise<ClusterState[]>;
    connect: (clusterId: string) => Promise<ClusterState>;
    disconnect: (clusterId: string) => Promise<void>;
    onState: (handler: (state: ClusterState) => void) => () => void;
  };
  kubeconfig: {
    paths: () => Promise<string[]>;
    add: () => Promise<{ paths: string[]; added: string[] }>;
    remove: (path: string) => Promise<string[]>;
  };
  resources: {
    list: (query: ResourceQuery) => Promise<ListResult>;
    get: (ref: ResourceRef) => Promise<KubeObject>;
    applyYaml: (payload: {
      clusterId: string;
      yaml: string;
      kindMap?: Record<string, { plural: string; namespaced: boolean }>;
    }) => Promise<ApplyResult[]>;
    remove: (ref: ResourceRef & { propagation?: 'Foreground' | 'Background' | 'Orphan' }) => Promise<boolean>;
    scale: (ref: ResourceRef, replicas: number) => Promise<KubeObject>;
    restart: (ref: ResourceRef) => Promise<KubeObject>;
  };
  metrics: {
    pods: (clusterId: string) => Promise<PodMetric[]>;
    nodes: (clusterId: string) => Promise<NodeMetric[]>;
  };
  watch: {
    start: (query: ResourceQuery) => Promise<string>;
    stop: (watchId: string) => Promise<boolean>;
    onEvent: (handler: (event: WatchEvent) => void) => () => void;
    onError: (handler: (payload: { watchId: string; message: string }) => void) => () => void;
  };
  logs: {
    start: (req: LogRequest) => Promise<string>;
    stop: (streamId: string) => Promise<boolean>;
    onData: (handler: (payload: { streamId: string; text: string }) => void) => () => void;
    onEnd: (handler: (payload: { streamId: string; error?: string }) => void) => () => void;
  };
  exec: {
    start: (req: ExecRequest) => Promise<string>;
    write: (sessionId: string, data: string) => Promise<boolean>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
    close: (sessionId: string) => Promise<boolean>;
    onData: (handler: (payload: ExecData) => void) => () => void;
    onExit: (handler: (payload: { sessionId: string; code?: number }) => void) => () => void;
  };
  portForward: {
    list: () => Promise<PortForwardState[]>;
    start: (req: {
      clusterId: string;
      namespace: string;
      kind: 'pod' | 'service';
      name: string;
      localPort: number;
      remotePort: number;
    }) => Promise<PortForwardState>;
    stop: (id: string) => Promise<boolean>;
    onState: (handler: (state: PortForwardState) => void) => () => void;
  };
  settings: {
    get: () => Promise<StoredSettings>;
    set: (patch: Partial<StoredSettings>) => Promise<StoredSettings>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    showItem: (path: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    kube: KubeApi;
  }
}

export const api: KubeApi = window.kube;
