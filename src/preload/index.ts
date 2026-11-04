import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApplyResult,
  AppInfo,
  ClusterInfo,
  ClusterState,
  ExecData,
  ExecRequest,
  KubeObject,
  KubeconfigImportResult,
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

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  app: {
    info: () => invoke<AppInfo>('app:info'),
    relogin: () => invoke<boolean>('app:relogin'),
  },
  clusters: {
    list: () => invoke<ClusterInfo[]>('clusters:list'),
    states: () => invoke<ClusterState[]>('clusters:states'),
    connect: (clusterId: string) => invoke<ClusterState>('clusters:connect', clusterId),
    disconnect: (clusterId: string) => invoke<void>('clusters:disconnect', clusterId),
    onState: (handler: (state: ClusterState) => void) => subscribe('kubepilot:cluster-state', handler),
  },
  kubeconfig: {
    paths: () => invoke<string[]>('kubeconfig:paths'),
    add: () => invoke<{ paths: string[]; added: string[] }>('kubeconfig:add'),
    paste: (payload: { content: string; name?: string }) =>
      invoke<KubeconfigImportResult>('kubeconfig:paste', payload),
    remove: (path: string) => invoke<string[]>('kubeconfig:remove', path),
  },
  resources: {
    list: (query: ResourceQuery) => invoke<ListResult>('resources:list', query),
    get: (ref: ResourceRef) => invoke<KubeObject>('resources:get', ref),
    applyYaml: (payload: {
      clusterId: string;
      yaml: string;
      kindMap?: Record<string, { plural: string; namespaced: boolean }>;
    }) => invoke<ApplyResult[]>('resources:apply', payload),
    remove: (ref: ResourceRef & { propagation?: 'Foreground' | 'Background' | 'Orphan' }) =>
      invoke<boolean>('resources:delete', ref),
    scale: (ref: ResourceRef, replicas: number) => invoke<KubeObject>('resources:scale', { ref, replicas }),
    restart: (ref: ResourceRef) => invoke<KubeObject>('resources:restart', ref),
  },
  metrics: {
    pods: (clusterId: string) => invoke<PodMetric[]>('metrics:pods', clusterId),
    nodes: (clusterId: string) => invoke<NodeMetric[]>('metrics:nodes', clusterId),
  },
  watch: {
    start: (query: ResourceQuery) => invoke<string>('watch:start', query),
    stop: (watchId: string) => invoke<boolean>('watch:stop', watchId),
    onEvent: (handler: (event: WatchEvent) => void) => subscribe('kubepilot:watch-event', handler),
    onError: (handler: (payload: { watchId: string; message: string }) => void) =>
      subscribe('kubepilot:watch-error', handler),
  },
  logs: {
    start: (req: LogRequest) => invoke<string>('logs:start', req),
    stop: (streamId: string) => invoke<boolean>('logs:stop', streamId),
    onData: (handler: (payload: { streamId: string; text: string }) => void) =>
      subscribe('kubepilot:logs-data', handler),
    onEnd: (handler: (payload: { streamId: string; error?: string }) => void) =>
      subscribe('kubepilot:logs-end', handler),
  },
  exec: {
    start: (req: ExecRequest) => invoke<string>('exec:start', req),
    write: (sessionId: string, data: string) => invoke<boolean>('exec:write', { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      invoke<boolean>('exec:resize', { sessionId, cols, rows }),
    close: (sessionId: string) => invoke<boolean>('exec:close', sessionId),
    onData: (handler: (payload: ExecData) => void) => subscribe('kubepilot:exec-data', handler),
    onExit: (handler: (payload: { sessionId: string; code?: number }) => void) =>
      subscribe('kubepilot:exec-exit', handler),
  },
  portForward: {
    list: () => invoke<PortForwardState[]>('portforward:list'),
    start: (req: {
      clusterId: string;
      namespace: string;
      kind: 'pod' | 'service';
      name: string;
      localPort: number;
      remotePort: number;
    }) => invoke<PortForwardState>('portforward:start', req),
    stop: (id: string) => invoke<boolean>('portforward:stop', id),
    stopAll: () => invoke<number>('portforward:stopAll'),
    onState: (handler: (state: PortForwardState) => void) =>
      subscribe('kubepilot:portforward-state', handler),
  },
  settings: {
    get: () => invoke<StoredSettings>('settings:get'),
    set: (patch: Partial<StoredSettings>) => invoke<StoredSettings>('settings:set', patch),
  },
  shell: {
    openExternal: (url: string) => invoke<void>('shell:open-external', url),
    showItem: (path: string) => invoke<void>('shell:show-item', path),
  },
};

export type KubeApi = typeof api;

contextBridge.exposeInMainWorld('kube', api);
