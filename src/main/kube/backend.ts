import type {
  DiscoveredResource,
  ExecRequest,
  KubeObject,
  LogRequest,
  NodeMetric,
  PodMetric,
  ResourceQuery,
  ResourceRef,
  WatchEventType,
} from '@shared/types';

export interface ConnectResult {
  version: string;
  namespaces: string[];
  namespacesForbidden: boolean;
  resources: DiscoveredResource[];
}

export interface ExecHandle {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

export interface ExecHandlers {
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onError: (message: string) => void;
  onClose: (code?: number) => void;
}

/**
 * Everything the UI needs from a cluster. `LiveBackend` talks to a real API
 * server; `DemoBackend` serves fixtures with the same semantics so the whole
 * interface is explorable without a kubeconfig.
 */
export interface ClusterBackend {
  readonly id: string;
  readonly kind: 'live' | 'demo';
  connect(): Promise<ConnectResult>;
  list(query: ResourceQuery): Promise<{ items: KubeObject[]; resourceVersion?: string }>;
  get(ref: ResourceRef): Promise<KubeObject>;
  apply(manifest: KubeObject, plural: string, namespaced: boolean): Promise<KubeObject>;
  remove(ref: ResourceRef, propagation?: 'Foreground' | 'Background' | 'Orphan'): Promise<unknown>;
  scale(ref: ResourceRef, replicas: number): Promise<KubeObject>;
  restart(ref: ResourceRef): Promise<KubeObject>;
  podMetrics(): Promise<PodMetric[]>;
  nodeMetrics(): Promise<NodeMetric[]>;
  watch(
    query: ResourceQuery,
    onEvent: (type: WatchEventType, object: KubeObject) => void,
    onError?: (message: string) => void,
  ): () => void;
  logs(req: LogRequest, onChunk: (text: string) => void, onEnd: (err?: string) => void): () => void;
  /**
   * Rejects when the session cannot be opened at all — for example a distroless
   * container with no shell — so the UI can explain why instead of hanging.
   */
  exec(req: ExecRequest, handlers: ExecHandlers): Promise<ExecHandle>;
}
