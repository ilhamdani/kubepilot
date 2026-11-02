import { KubeClient, watchResource } from './client';
import type { ClusterBackend, ConnectResult, ExecHandle, ExecHandlers } from './backend';
import type {
  DiscoveredResource,
  ExecRequest,
  KubeObject,
  LogRequest,
  ResourceQuery,
  ResourceRef,
  WatchEventType,
} from '@shared/types';

export class LiveBackend implements ClusterBackend {
  readonly kind = 'live' as const;
  readonly id: string;
  readonly client: KubeClient;

  constructor(id: string, kubeconfigPaths: string[]) {
    this.id = id;
    this.client = new KubeClient(id.replace(/^live:/, ''), kubeconfigPaths);
  }

  async connect(): Promise<ConnectResult> {
    const [version, ns, resources] = await Promise.all([
      this.client.version().catch(() => 'unknown'),
      this.client.namespaces(),
      this.client.discovery().catch((): DiscoveredResource[] => []),
    ]);
    return {
      version,
      namespaces: ns.items,
      namespacesForbidden: ns.forbidden,
      resources,
    };
  }

  list(query: ResourceQuery) {
    return this.client.list(query);
  }

  get(ref: ResourceRef) {
    return this.client.get(ref);
  }

  apply(manifest: KubeObject, plural: string, namespaced: boolean) {
    return this.client.apply(manifest, plural, namespaced);
  }

  remove(ref: ResourceRef, propagation: 'Foreground' | 'Background' | 'Orphan' = 'Background') {
    return this.client.remove(ref, propagation);
  }

  scale(ref: ResourceRef, replicas: number) {
    return this.client.scale(ref, replicas);
  }

  restart(ref: ResourceRef) {
    return this.client.rolloutRestart(ref);
  }

  podMetrics() {
    return this.client.podMetrics();
  }

  nodeMetrics() {
    return this.client.nodeMetrics();
  }

  watch(
    query: ResourceQuery,
    onEvent: (type: WatchEventType, object: KubeObject) => void,
    onError?: (message: string) => void,
  ): () => void {
    const handle = watchResource(this.client, query, onEvent, onError);
    return handle.stop;
  }

  logs(req: LogRequest, onChunk: (text: string) => void, onEnd: (err?: string) => void) {
    return this.client.streamLogs(req, onChunk, onEnd);
  }

  exec(req: ExecRequest, handlers: ExecHandlers): ExecHandle {
    return this.client.exec(req, handlers);
  }
}
