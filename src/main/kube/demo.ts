import type { ClusterBackend, ConnectResult, ExecHandle, ExecHandlers } from './backend';
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

/** Deterministic PRNG so the demo cluster looks the same on every launch. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261026);
const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
const SUFFIX = 'bcdfghjklmnpqrstvwxz2456789';

function randomSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += SUFFIX[Math.floor(rand() * SUFFIX.length)];
  return out;
}

function hashSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += '0123456789abcdef'[Math.floor(rand() * 16)];
  return out;
}

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

function meta(
  name: string,
  namespace: string | undefined,
  createdMinutes: number,
  labels: Record<string, string> = {},
  extra: Record<string, any> = {},
) {
  return {
    name,
    ...(namespace ? { namespace } : {}),
    uid: `${hashSuffix(8)}-${hashSuffix(4)}-${hashSuffix(4)}-${hashSuffix(4)}-${hashSuffix(12)}`,
    resourceVersion: String(1000 + Math.floor(rand() * 900000)),
    creationTimestamp: ago(createdMinutes),
    labels,
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
    ...extra,
  };
}

const NODES = [
  { name: 'ip-10-0-1-11', role: 'control-plane', zone: 'eu-central-1a', cpu: '8', mem: '32Gi' },
  { name: 'ip-10-0-2-24', role: 'worker', zone: 'eu-central-1b', cpu: '16', mem: '64Gi' },
  { name: 'ip-10-0-3-31', role: 'worker', zone: 'eu-central-1c', cpu: '16', mem: '64Gi' },
];

const NAMESPACES = ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'monitoring', 'shop', 'argocd'];

interface WorkloadSeed {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob';
  name: string;
  namespace: string;
  replicas: number;
  image: string;
  port: number;
  labels: Record<string, string>;
  problem?: 'crashloop' | 'pending' | 'imagepull';
}

const WORKLOADS: WorkloadSeed[] = [
  {
    kind: 'Deployment',
    name: 'checkout-api',
    namespace: 'shop',
    replicas: 3,
    image: 'ghcr.io/acme/checkout-api:2.14.3',
    port: 8080,
    labels: { app: 'checkout-api', tier: 'backend', 'app.kubernetes.io/part-of': 'shop' },
  },
  {
    kind: 'Deployment',
    name: 'catalog-api',
    namespace: 'shop',
    replicas: 2,
    image: 'ghcr.io/acme/catalog-api:1.9.0',
    port: 8080,
    labels: { app: 'catalog-api', tier: 'backend', 'app.kubernetes.io/part-of': 'shop' },
  },
  {
    kind: 'Deployment',
    name: 'storefront',
    namespace: 'shop',
    replicas: 2,
    image: 'ghcr.io/acme/storefront:4.2.1',
    port: 3000,
    labels: { app: 'storefront', tier: 'frontend', 'app.kubernetes.io/part-of': 'shop' },
  },
  {
    kind: 'Deployment',
    name: 'payments-worker',
    namespace: 'shop',
    replicas: 2,
    image: 'ghcr.io/acme/payments-worker:0.8.6',
    port: 9090,
    labels: { app: 'payments-worker', tier: 'backend' },
    problem: 'crashloop',
  },
  {
    kind: 'StatefulSet',
    name: 'postgres',
    namespace: 'shop',
    replicas: 1,
    image: 'postgres:16.3-alpine',
    port: 5432,
    labels: { app: 'postgres', tier: 'database' },
  },
  {
    kind: 'StatefulSet',
    name: 'redis',
    namespace: 'shop',
    replicas: 1,
    image: 'redis:7.2-alpine',
    port: 6379,
    labels: { app: 'redis', tier: 'cache' },
  },
  {
    kind: 'DaemonSet',
    name: 'node-exporter',
    namespace: 'monitoring',
    replicas: 3,
    image: 'quay.io/prometheus/node-exporter:v1.8.1',
    port: 9100,
    labels: { app: 'node-exporter' },
  },
  {
    kind: 'DaemonSet',
    name: 'fluent-bit',
    namespace: 'monitoring',
    replicas: 3,
    image: 'cr.fluentbit.io/fluent/fluent-bit:3.0.7',
    port: 2020,
    labels: { app: 'fluent-bit' },
  },
  {
    kind: 'Deployment',
    name: 'prometheus',
    namespace: 'monitoring',
    replicas: 1,
    image: 'quay.io/prometheus/prometheus:v2.53.0',
    port: 9090,
    labels: { app: 'prometheus' },
  },
  {
    kind: 'Deployment',
    name: 'argocd-server',
    namespace: 'argocd',
    replicas: 1,
    image: 'quay.io/argoproj/argocd:v2.11.3',
    port: 8080,
    labels: { app: 'argocd-server' },
  },
  {
    kind: 'Deployment',
    name: 'coredns',
    namespace: 'kube-system',
    replicas: 2,
    image: 'registry.k8s.io/coredns/coredns:v1.11.1',
    port: 53,
    labels: { 'k8s-app': 'kube-dns' },
  },
];

const CPU_BASE: Record<string, number> = {
  'checkout-api': 210,
  'catalog-api': 95,
  storefront: 40,
  'payments-worker': 12,
  postgres: 320,
  redis: 25,
  'node-exporter': 18,
  'fluent-bit': 32,
  prometheus: 480,
  'argocd-server': 60,
  coredns: 15,
};

export class DemoBackend implements ClusterBackend {
  readonly kind = 'demo' as const;
  readonly id = 'demo';
  private store = new Map<string, KubeObject[]>();
  /** Kind metadata per store key, so discovery never has to parse the key. */
  private index = new Map<string, { apiVersion: string; plural: string; kind: string; namespaced: boolean }>();
  private watchers = new Set<(query: ResourceQuery, type: WatchEventType, object: KubeObject) => void>();
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor() {
    this.seed();
  }

  private key(apiVersion: string, plural: string) {
    return `${apiVersion}|${plural}`;
  }

  private put(apiVersion: string, plural: string, object: KubeObject) {
    const key = this.key(apiVersion, plural);
    const list = this.store.get(key) ?? [];
    const index = list.findIndex(
      (o) =>
        o.metadata.name === object.metadata.name &&
        (o.metadata.namespace ?? '') === (object.metadata.namespace ?? ''),
    );
    if (index >= 0) list[index] = object;
    else list.push(object);
    this.store.set(key, list);
    this.index.set(key, {
      apiVersion,
      plural,
      kind: object.kind ?? plural,
      namespaced: Boolean(object.metadata?.namespace),
    });
  }

  private seed() {
    const add = (apiVersion: string, plural: string, object: KubeObject) =>
      this.put(apiVersion, plural, object);

    for (const ns of NAMESPACES) {
      add('v1', 'namespaces', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: meta(ns, undefined, 60 * 24 * 12, { 'kubernetes.io/metadata.name': ns }),
        spec: { finalizers: ['kubernetes'] },
        status: { phase: 'Active' },
      });
    }

    for (const node of NODES) {
      const labels: Record<string, string> = {
        'kubernetes.io/hostname': node.name,
        'topology.kubernetes.io/zone': node.zone,
        'node.kubernetes.io/instance-type': node.role === 'worker' ? 'm6i.4xlarge' : 'm6i.2xlarge',
      };
      if (node.role === 'control-plane') labels['node-role.kubernetes.io/control-plane'] = '';
      add('v1', 'nodes', {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: meta(node.name, undefined, 60 * 24 * 21, labels),
        spec: { podCIDR: `10.42.${NODES.indexOf(node)}.0/24` },
        status: {
          capacity: { cpu: node.cpu, memory: node.mem, pods: '110', 'ephemeral-storage': '100Gi' },
          allocatable: { cpu: node.cpu, memory: node.mem, pods: '110', 'ephemeral-storage': '100Gi' },
          conditions: [
            { type: 'Ready', status: 'True', lastHeartbeatTime: new Date().toISOString() },
            { type: 'MemoryPressure', status: 'False' },
            { type: 'DiskPressure', status: 'False' },
            { type: 'PIDPressure', status: 'False' },
          ],
          nodeInfo: {
            kubeletVersion: 'v1.29.6+k3s1',
            osImage: 'Ubuntu 22.04.4 LTS',
            kernelVersion: '5.15.0-105-generic',
            containerRuntimeVersion: 'containerd://1.7.16-k3s1',
            architecture: 'amd64',
          },
          addresses: [{ type: 'InternalIP', address: node.name.replace('ip-', '').replace(/-/g, '.') }],
        },
      });
    }

    const podNames: Array<{ ns: string; name: string; app: string; node: string; phase: string }> = [];

    for (const w of WORKLOADS) {
      const ownerName = w.name;
      const ownerUid = `${hashSuffix(8)}-${hashSuffix(4)}-${hashSuffix(4)}-${hashSuffix(4)}-${hashSuffix(12)}`;
      const selector = { matchLabels: w.labels };

      if (w.kind === 'Deployment') {
        add('apps/v1', 'deployments', {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: meta(w.name, w.namespace, 60 * 24 * 9, w.labels, { uid: ownerUid }),
          spec: {
            replicas: w.replicas,
            selector,
            strategy: { type: 'RollingUpdate' },
            template: {
              metadata: { labels: w.labels },
              spec: {
                containers: [
                  {
                    name: w.name,
                    image: w.image,
                    ports: [{ containerPort: w.port, protocol: 'TCP' }],
                    resources: {
                      requests: { cpu: '100m', memory: '256Mi' },
                      limits: { cpu: '500m', memory: '512Mi' },
                    },
                  },
                ],
              },
            },
          },
          status: {
            replicas: w.replicas,
            readyReplicas: w.problem ? Math.max(0, w.replicas - 1) : w.replicas,
            availableReplicas: w.problem ? Math.max(0, w.replicas - 1) : w.replicas,
            updatedReplicas: w.replicas,
            observedGeneration: 1,
            conditions: [
              {
                type: 'Available',
                status: w.problem ? 'False' : 'True',
                reason: w.problem ? 'MinimumReplicasUnavailable' : 'MinimumReplicasAvailable',
                message: w.problem ? 'Deployment does not have minimum availability.' : 'Deployment has minimum availability.',
              },
            ],
          },
        });
        const rsName = `${w.name}-${hashSuffix(10)}`;
        add('apps/v1', 'replicasets', {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          metadata: meta(rsName, w.namespace, 60 * 24 * 2, { ...w.labels, 'pod-template-hash': 'x' }, {
            ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: ownerName, uid: ownerUid }],
          }),
          spec: { replicas: w.replicas, selector },
          status: { replicas: w.replicas, readyReplicas: w.problem ? w.replicas - 1 : w.replicas },
        });
      } else if (w.kind === 'StatefulSet') {
        add('apps/v1', 'statefulsets', {
          apiVersion: 'apps/v1',
          kind: 'StatefulSet',
          metadata: meta(w.name, w.namespace, 60 * 24 * 14, w.labels, { uid: ownerUid }),
          spec: { replicas: w.replicas, serviceName: w.name, selector },
          status: { replicas: w.replicas, readyReplicas: w.replicas, currentReplicas: w.replicas },
        });
      } else if (w.kind === 'DaemonSet') {
        add('apps/v1', 'daemonsets', {
          apiVersion: 'apps/v1',
          kind: 'DaemonSet',
          metadata: meta(w.name, w.namespace, 60 * 24 * 14, w.labels, { uid: ownerUid }),
          spec: { selector, template: { spec: { containers: [{ name: w.name, image: w.image }] } } },
          status: {
            desiredNumberScheduled: 3,
            currentNumberScheduled: 3,
            numberReady: 3,
            numberAvailable: 3,
          },
        });
      }

      const podCount = w.kind === 'DaemonSet' ? 3 : w.replicas;
      for (let i = 0; i < podCount; i += 1) {
        const node = w.kind === 'DaemonSet' ? NODES[i].name : pick(NODES).name;
        let phase = 'Running';
        if (w.problem === 'crashloop' && i === podCount - 1) phase = 'CrashLoopBackOff';
        if (w.problem === 'pending' && i === 0) phase = 'Pending';
        const name =
          w.kind === 'StatefulSet'
            ? `${w.name}-${i}`
            : `${w.name}-${hashSuffix(10)}-${randomSuffix(5)}`;
        podNames.push({ ns: w.namespace, name, app: w.name, node, phase });
        add('v1', 'pods', this.buildPod(w, name, node, phase, ownerName, ownerUid));
      }

      add('v1', 'services', {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta(w.name, w.namespace, 60 * 24 * 9, w.labels),
        spec: {
          type: w.kind === 'StatefulSet' ? 'ClusterIP' : 'ClusterIP',
          clusterIP: `10.43.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)}`,
          selector: w.labels,
          ports: [{ port: w.port, targetPort: w.port, protocol: 'TCP', name: 'http' }],
        },
        status: { loadBalancer: {} },
      });
    }

    // Public facing services + ingress for the storefront.
    add('v1', 'services', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('kubernetes', 'default', 60 * 24 * 21, { component: 'apiserver', provider: 'kubernetes' }),
      spec: {
        type: 'ClusterIP',
        clusterIP: '10.43.0.1',
        ports: [{ port: 443, targetPort: 6443, protocol: 'TCP', name: 'https' }],
      },
      status: { loadBalancer: {} },
    });
    add('v1', 'services', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('storefront-lb', 'shop', 60 * 24 * 6, { app: 'storefront' }),
      spec: {
        type: 'LoadBalancer',
        clusterIP: '10.43.87.12',
        externalIPs: ['203.0.113.42'],
        selector: { app: 'storefront' },
        ports: [{ port: 80, targetPort: 3000, protocol: 'TCP', name: 'http' }],
      },
      status: { loadBalancer: { ingress: [{ ip: '203.0.113.42' }] } },
    });

    add('networking.k8s.io/v1', 'ingresses', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: meta('storefront', 'shop', 60 * 24 * 6, { app: 'storefront' }),
      spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: ['shop.acme.dev'], secretName: 'shop-tls' }],
        rules: [
          {
            host: 'shop.acme.dev',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: { service: { name: 'storefront', port: { number: 3000 } } },
                },
              ],
            },
          },
        ],
      },
      status: { loadBalancer: { ingress: [{ ip: '203.0.113.42' }] } },
    });

    add('networking.k8s.io/v1', 'ingressclasses', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'IngressClass',
      metadata: meta('nginx', undefined, 60 * 24 * 21, { 'app.kubernetes.io/name': 'ingress-nginx' }),
      spec: { controller: 'k8s.io/ingress-nginx' },
    });

    add('networking.k8s.io/v1', 'networkpolicies', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: meta('allow-shop-internal', 'shop', 60 * 24 * 8, { app: 'checkout-api' }),
      spec: {
        podSelector: { matchLabels: { tier: 'backend' } },
        policyTypes: ['Ingress'],
        ingress: [{ from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/part-of': 'shop' } } }] }],
      },
    });

    for (const name of ['shop-config', 'storefront-config', 'prometheus-config']) {
      const ns = name === 'prometheus-config' ? 'monitoring' : 'shop';
      add('v1', 'configmaps', {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: meta(name, ns, 60 * 24 * 5, { app: name.replace('-config', '') }),
        data: {
          'LOG_LEVEL': 'info',
          'FEATURE_FLAGS': 'checkout-v2=true,new-search=false',
          'config.yaml': 'server:\n  port: 8080\n  readTimeout: 15s\n',
        },
      });
    }

    for (const [name, type] of [
      ['shop-tls', 'kubernetes.io/tls'],
      ['registry-credentials', 'kubernetes.io/dockerconfigjson'],
      ['payments-api-keys', 'Opaque'],
    ] as const) {
      add('v1', 'secrets', {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: meta(name, 'shop', 60 * 24 * 5, { app: 'shop' }),
        type,
        data: {
          'tls.crt': b64('-----BEGIN CERTIFICATE-----MIIB...'),
          'tls.key': b64('-----BEGIN PRIVATE KEY-----MIIE...'),
          'api-key': b64('sk_live_51H8xQ2'),
        },
      });
    }

    add('v1', 'persistentvolumeclaims', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta('postgres-data', 'shop', 60 * 24 * 14, { app: 'postgres' }),
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'local-path',
        volumeName: 'pvc-9f2c1b7a',
        resources: { requests: { storage: '50Gi' } },
        status: { phase: 'Bound', capacity: { storage: '50Gi' }, accessModes: ['ReadWriteOnce'] },
      },
      status: { phase: 'Bound', capacity: { storage: '50Gi' }, accessModes: ['ReadWriteOnce'] },
    });
    add('v1', 'persistentvolumeclaims', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta('redis-data', 'shop', 60 * 24 * 14, { app: 'redis' }),
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'local-path',
        resources: { requests: { storage: '10Gi' } },
      },
      status: { phase: 'Pending' },
    });
    add('storage.k8s.io/v1', 'storageclasses', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: meta('local-path', undefined, 60 * 24 * 21, { 'app.kubernetes.io/name': 'local-path-provisioner' }),
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
    });

    for (const [name, size, node] of [
      ['pvc-9f2c1b7a', '50Gi', NODES[1].name],
      ['pvc-1d4e77aa', '10Gi', NODES[2].name],
    ]) {
      add('v1', 'persistentvolumes', {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: meta(name, undefined, 60 * 24 * 14, {}),
        spec: { capacity: { storage: size }, storageClassName: 'local-path', accessModes: ['ReadWriteOnce'] },
        status: { phase: 'Bound' },
        ...(node ? {} : {}),
      });
    }

    add('v1', 'serviceaccounts', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: meta('default', 'shop', 60 * 24 * 12, {}),
    });
    add('rbac.authorization.k8s.io/v1', 'roles', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: meta('shop-reader', 'shop', 60 * 24 * 10, {}),
      rules: [{ apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] }],
    });
    add('rbac.authorization.k8s.io/v1', 'rolebindings', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta('shop-reader-binding', 'shop', 60 * 24 * 10, {}),
      subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'shop' }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'shop-reader' },
    });
    add('rbac.authorization.k8s.io/v1', 'clusterroles', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: meta('cluster-admin-lite', undefined, 60 * 24 * 21, {}),
      rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list', 'watch'] }],
    });
    add('rbac.authorization.k8s.io/v1', 'clusterrolebindings', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: meta('argocd-manager', undefined, 60 * 24 * 21, {}),
      subjects: [{ kind: 'ServiceAccount', name: 'argocd-manager', namespace: 'argocd' }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin-lite' },
    });

    add('apiextensions.k8s.io/v1', 'customresourcedefinitions', {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: meta('certificates.cert-manager.io', undefined, 60 * 24 * 21, {}),
      spec: {
        group: 'cert-manager.io',
        scope: 'Namespaced',
        names: { plural: 'certificates', singular: 'certificate', kind: 'Certificate' },
        versions: [{ name: 'v1', served: true, storage: true }],
      },
      status: { conditions: [{ type: 'Established', status: 'True' }] },
    });
    add('cert-manager.io/v1', 'certificates', {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: meta('shop-tls', 'shop', 60 * 24 * 6, {}),
      spec: { secretName: 'shop-tls', dnsNames: ['shop.acme.dev'], issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' } },
      status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Ready', message: 'Certificate is up to date' }] },
    });

    // Events: a mix of warnings and normal noise, like a real cluster.
    const eventSeeds: Array<[string, string, string, string, string, number]> = [
      ['Warning', 'FailedScheduling', 'shop', 'payments-worker-6d4b9c7f8-q2x4n', '0/3 nodes are available: 3 Insufficient memory.', 4],
      ['Warning', 'BackOff', 'shop', 'payments-worker-6d4b9c7f8-q2x4n', 'Back-off restarting failed container payments-worker', 12],
      ['Normal', 'Pulled', 'shop', 'checkout-api-7d9f8c6b5-4xk2p', 'Successfully pulled image "ghcr.io/acme/checkout-api:2.14.3"', 96],
      ['Normal', 'Created', 'shop', 'storefront-58c7d4b9f6-lm9zw', 'Created container storefront', 240],
      ['Normal', 'Scheduled', 'monitoring', 'prometheus-6f7d9c8b5-h4tjq', 'Successfully assigned monitoring/prometheus to ip-10-0-2-24', 300],
      ['Warning', 'Unhealthy', 'argocd', 'argocd-server-7b5f9d6c4-w8vzr', 'Readiness probe failed: connection refused', 55],
      ['Normal', 'Pulled', 'monitoring', 'node-exporter-2x9kd', 'Container image already present on machine', 480],
      ['Warning', 'FailedMount', 'shop', 'postgres-0', 'MountVolume.SetUp failed for volume "pvc-9f2c1b7a"', 18],
    ];
    eventSeeds.forEach(([type, reason, ns, object, message, minutes], index) => {
      add('v1', 'events', {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: meta(`${object}.${hashSuffix(16)}`, ns, minutes),
        type,
        reason,
        message,
        count: 1 + Math.floor(rand() * 6),
        firstTimestamp: ago(minutes + 20),
        lastTimestamp: ago(minutes),
        involvedObject: { kind: 'Pod', name: object, namespace: ns, apiVersion: 'v1' },
        source: { component: index % 2 ? 'kubelet' : 'default-scheduler' },
      });
    });

    add('autoscaling/v2', 'horizontalpodautoscalers', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: meta('checkout-api', 'shop', 60 * 24 * 4, { app: 'checkout-api' }),
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'checkout-api' },
        minReplicas: 2,
        maxReplicas: 8,
        metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
      },
      status: { currentReplicas: 3, desiredReplicas: 3, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 42 } } }] },
    });

    add('batch/v1', 'jobs', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: meta('db-migrate-2-14-3', 'shop', 60 * 6, { app: 'db-migrate' }),
      spec: { completions: 1, parallelism: 1, template: { spec: { containers: [{ name: 'migrate', image: 'ghcr.io/acme/migrate:2.14.3' }] } } },
      status: { succeeded: 1, startTime: ago(360), completionTime: ago(354) },
    });

    add('batch/v1', 'cronjobs', {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: meta('nightly-backup', 'shop', 60 * 24 * 12, { app: 'backup' }),
      spec: {
        schedule: '0 2 * * *',
        suspend: false,
        jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'ghcr.io/acme/backup:1.2.0' }] } } } },
      },
      status: { lastScheduleTime: ago(60 * 8) },
    });
  }

  private buildPod(
    w: WorkloadSeed,
    name: string,
    node: string,
    phase: string,
    ownerName: string,
    ownerUid: string,
  ): KubeObject {
    const restartCount =
      phase === 'CrashLoopBackOff' ? 7 + Math.floor(rand() * 5) : Math.floor(rand() * 2);
    const started = phase !== 'Pending';
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: meta(name, w.namespace, phase === 'Pending' ? 4 : 60 * 6 + Math.floor(rand() * 4000), {
        ...w.labels,
        'pod-template-hash': '7d9f8c6b5',
      }, {
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: w.kind === 'DaemonSet' ? 'DaemonSet' : w.kind === 'StatefulSet' ? 'StatefulSet' : 'ReplicaSet',
            name: ownerName,
            uid: ownerUid,
            controller: true,
          },
        ],
      }),
      spec: {
        nodeName: started ? node : undefined,
        restartPolicy: 'Always',
        serviceAccountName: 'default',
        containers: [
          {
            name: w.name,
            image: w.image,
            ports: [{ containerPort: w.port, protocol: 'TCP' }],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            env: [{ name: 'LOG_LEVEL', value: 'info' }],
          },
        ],
        volumes: [
          { name: 'config', configMap: { name: 'shop-config' } },
          { name: 'kube-api-access', projected: { defaultMode: 420 } },
        ],
      },
      status: {
        phase: phase === 'CrashLoopBackOff' ? 'Running' : phase,
        podIP: started ? `10.42.${Math.floor(rand() * 3)}.${Math.floor(rand() * 250)}` : undefined,
        hostIP: node.replace('ip-', '').replace(/-/g, '.'),
        startTime: started ? ago(60 * 5) : undefined,
        conditions: [
          { type: 'Initialized', status: started ? 'True' : 'False' },
          { type: 'Ready', status: phase === 'Running' ? 'True' : 'False' },
          { type: 'ContainersReady', status: phase === 'Running' ? 'True' : 'False' },
          { type: 'PodScheduled', status: started ? 'True' : 'False' },
        ],
        containerStatuses: started
          ? [
              {
                name: w.name,
                image: w.image,
                ready: phase === 'Running',
                restartCount,
                started: true,
                state:
                  phase === 'CrashLoopBackOff'
                    ? { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } }
                    : { running: { startedAt: ago(60 * 5) } },
              },
            ]
          : [],
      },
    };
  }

  async connect(): Promise<ConnectResult> {
    this.startTicker();
    return {
      version: 'v1.29.6+k3s1',
      namespaces: [...NAMESPACES].sort(),
      namespacesForbidden: false,
      resources: this.discovery(),
    };
  }

  private discovery(): DiscoveredResource[] {
    return [...this.index.values()].map((entry) => ({
      kind: entry.kind,
      apiVersion: entry.apiVersion,
      plural: entry.plural,
      namespaced: entry.namespaced,
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      group: entry.apiVersion.includes('/') ? entry.apiVersion.split('/')[0] : '',
      custom: entry.apiVersion === 'cert-manager.io/v1',
    }));
  }

  private startTicker() {
    if (this.started) return;
    this.started = true;
    // Simulate a live cluster: pods churn a little so watches have something to say.
    this.timers.push(
      setInterval(() => {
        const pods = this.store.get(this.key('v1', 'pods')) ?? [];
        if (!pods.length) return;
        const pod = pods[Math.floor(rand() * pods.length)];
        const next: any = {
          ...pod,
          metadata: { ...pod.metadata, resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) },
        };
        if (pod.status?.containerStatuses?.[0] && rand() > 0.6) {
          next.status = {
            ...pod.status,
            containerStatuses: [
              {
                ...pod.status.containerStatuses[0],
                restartCount: pod.status.containerStatuses[0].restartCount,
              },
            ],
          };
        }
        this.put('v1', 'pods', next);
        this.emit({ apiVersion: 'v1', plural: 'pods', kind: 'Pod', namespaced: true, clusterId: 'demo' }, 'MODIFIED', next);
      }, 6000),
    );
  }

  private emit(query: ResourceQuery, type: WatchEventType, object: KubeObject) {
    for (const watcher of this.watchers) watcher(query, type, object);
  }

  async list(query: ResourceQuery) {
    const items = this.store.get(this.key(query.apiVersion, query.plural)) ?? [];
    const filtered = query.namespace
      ? items.filter((o) => o.metadata.namespace === query.namespace)
      : items;
    return { items: [...filtered], resourceVersion: '1' };
  }

  async get(ref: ResourceRef) {
    const items = this.store.get(this.key(ref.apiVersion, ref.plural)) ?? [];
    const found = items.find(
      (o) => o.metadata.name === ref.name && (o.metadata.namespace ?? '') === (ref.namespace ?? ''),
    );
    if (!found) throw new Error(`${ref.kind} "${ref.name}" not found`);
    return found;
  }

  async apply(manifest: KubeObject, plural: string, _namespaced: boolean) {
    const apiVersion = manifest.apiVersion ?? 'v1';
    const key = this.key(apiVersion, plural);
    const existing = (this.store.get(key) ?? []).find(
      (o) =>
        o.metadata.name === manifest.metadata?.name &&
        (o.metadata.namespace ?? '') === (manifest.metadata?.namespace ?? ''),
    );
    const next: any = existing
      ? { ...existing, ...manifest, metadata: { ...existing.metadata, ...manifest.metadata } }
      : {
          ...manifest,
          metadata: { ...manifest.metadata, uid: `${hashSuffix(8)}-x`, creationTimestamp: new Date().toISOString() },
        };
    this.put(apiVersion, plural, next);
    this.emit(
      { apiVersion, plural, kind: next.kind ?? '', namespaced: true, clusterId: 'demo' },
      existing ? 'MODIFIED' : 'ADDED',
      next,
    );
    return next;
  }

  async remove(ref: ResourceRef) {
    const key = this.key(ref.apiVersion, ref.plural);
    const items = this.store.get(key) ?? [];
    const found = items.find(
      (o) => o.metadata.name === ref.name && (o.metadata.namespace ?? '') === (ref.namespace ?? ''),
    );
    this.store.set(
      key,
      items.filter((o) => o !== found),
    );
    if (found) {
      this.emit(
        { apiVersion: ref.apiVersion, plural: ref.plural, kind: ref.kind, namespaced: ref.namespaced, clusterId: 'demo' },
        'DELETED',
        found,
      );
    }
    return {};
  }

  async scale(ref: ResourceRef, replicas: number) {
    const object = await this.get(ref);
    const next = {
      ...object,
      spec: { ...object.spec, replicas },
      status: { ...object.status, replicas, readyReplicas: replicas, availableReplicas: replicas },
    };
    this.put(ref.apiVersion, ref.plural, next);
    this.emit(
      { apiVersion: ref.apiVersion, plural: ref.plural, kind: ref.kind, namespaced: ref.namespaced, clusterId: 'demo' },
      'MODIFIED',
      next,
    );
    return next;
  }

  async restart(ref: ResourceRef) {
    const object = await this.get(ref);
    const next = {
      ...object,
      metadata: {
        ...object.metadata,
        annotations: {
          ...(object.metadata.annotations ?? {}),
          'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
        },
      },
    };
    this.put(ref.apiVersion, ref.plural, next);
    return next;
  }

  async podMetrics(): Promise<PodMetric[]> {
    const pods = this.store.get(this.key('v1', 'pods')) ?? [];
    return pods.map((pod) => {
      const app = pod.metadata.labels?.app ?? pod.metadata.name;
      const base = CPU_BASE[app] ?? 60;
      const jitter = 0.7 + rand() * 0.6;
      const cpu = Math.round(base * jitter);
      const memory = Math.round((180 + rand() * 260) * 1024 * 1024);
      return {
        namespace: pod.metadata.namespace,
        name: pod.metadata.name,
        containers: [{ name: app, cpu, memory }],
        cpu,
        memory,
        timestamp: new Date().toISOString(),
      };
    });
  }

  async nodeMetrics(): Promise<NodeMetric[]> {
    return NODES.map((node, index) => ({
      name: node.name,
      cpu: Math.round([1240, 3820, 2910][index] * (0.85 + rand() * 0.3)),
      memory: Math.round([6.2, 18.4, 12.1][index] * 1024 ** 3),
      timestamp: new Date().toISOString(),
    }));
  }

  watch(
    query: ResourceQuery,
    onEvent: (type: WatchEventType, object: KubeObject) => void,
    _onError?: (message: string) => void,
  ): () => void {
    const watcher = (q: ResourceQuery, type: WatchEventType, object: KubeObject) => {
      if (q.apiVersion !== query.apiVersion || q.plural !== query.plural) return;
      if (query.namespace && object.metadata.namespace !== query.namespace) return;
      onEvent(type, object);
    };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  logs(req: LogRequest, onChunk: (text: string) => void, onEnd: (err?: string) => void): () => void {
    const pod = (this.store.get(this.key('v1', 'pods')) ?? []).find(
      (p) => p.metadata.name === req.pod && p.metadata.namespace === req.namespace,
    );
    if (!pod) {
      setTimeout(() => onEnd(`Pod "${req.pod}" not found in namespace "${req.namespace}"`), 0);
      return () => undefined;
    }
    const app = pod.metadata.labels?.app ?? 'app';
    const crash = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason === 'CrashLoopBackOff';
    const templates = [
      `level=info msg="starting ${app}" version=2.14.3 commit=9f2c1b7 env=production`,
      'level=info msg="connected to postgres:5432" pool=8 latency=3ms',
      'level=info msg="http server listening" addr=:8080',
      'level=debug msg="request completed" method=GET path=/healthz status=200 duration=1.2ms',
      'level=info msg="request completed" method=POST path=/api/v1/checkout status=201 duration=42ms',
      'level=info msg="cache hit" key=product:8842 ttl=120s',
      'level=warn msg="slow query" duration=820ms query="select * from orders where id=$1"',
      'level=info msg="request completed" method=GET path=/api/v1/catalog status=200 duration=18ms',
    ];
    let index = 0;
    const line = () => {
      const ts = new Date().toISOString();
      const text = crash && index > 3 ? 'panic: failed to connect to postgres: connection refused' : pick(templates);
      return `${ts} ${text}\n`;
    };
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;

    const tail = req.tailLines ?? 200;
    let buffered = '';
    for (let i = 0; i < Math.min(tail, 40); i += 1) {
      buffered += line();
      index += 1;
    }
    setTimeout(() => !stopped && onChunk(buffered), 30);

    if (req.follow) {
      timer = setInterval(() => {
        if (stopped) return;
        onChunk(line());
        index += 1;
      }, 1800);
    } else {
      setTimeout(() => !stopped && onEnd(), 120);
    }

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }

  async exec(req: ExecRequest, handlers: ExecHandlers): Promise<ExecHandle> {
    let buffer = '';
    const prompt = `\u001b[32mroot@${req.pod.slice(0, 24)}\u001b[0m:\u001b[34m/${req.container ?? 'app'}\u001b[0m# `;

    setTimeout(() => {
      handlers.onData(
        'stdout',
        `\u001b[90mConnected to ${req.pod} (${req.container ?? 'container'}) — demo session\u001b[0m\r\n`,
      );
      handlers.onData('stdout', prompt);
    }, 120);

    const run = (command: string): string => {
      const [cmd, ...args] = command.trim().split(/\s+/);
      switch (cmd) {
        case '':
          return '';
        case 'ls':
          return '\u001b[34mapp\u001b[0m  \u001b[34mconfig\u001b[0m  Dockerfile  package.json  README.md\r\n';
        case 'pwd':
          return '/app\r\n';
        case 'whoami':
          return 'root\r\n';
        case 'hostname':
          return `${req.pod}\r\n`;
        case 'uname':
          return 'Linux ' + req.pod + ' 5.15.0-105-generic #115-Ubuntu SMP x86_64 GNU/Linux\r\n';
        case 'id':
          return 'uid=0(root) gid=0(root) groups=0(root)\r\n';
        case 'cat':
          if (args.join(' ').includes('os-release')) {
            return 'NAME="Ubuntu"\r\nVERSION="22.04.4 LTS (Jammy Jellyfish)"\r\nID=ubuntu\r\nVERSION_ID="22.04"\r\n';
          }
          return `cat: ${args.join(' ')}: No such file or directory\r\n`;
        case 'ps':
          return '  PID TTY          TIME CMD\r\n    1 ?        00:00:04 node\r\n   18 ?        00:00:00 sh\r\n   42 pts/0    00:00:00 sh\r\n';
        case 'df':
          return 'Filesystem      Size  Used Avail Use% Mounted on\r\noverlay         100G   18G   82G  18% /\r\n';
        case 'env':
          return 'NODE_ENV=production\r\nLOG_LEVEL=info\r\nHOSTNAME=' + req.pod + '\r\n';
        case 'echo':
          return args.join(' ') + '\r\n';
        case 'exit':
          handlers.onClose(0);
          return '';
        default:
          return `sh: ${cmd}: command not found\r\n`;
      }
    };

    return {
      write: (data: string) => {
        for (const char of data) {
          if (char === '\r') {
            handlers.onData('stdout', '\r\n' + run(buffer) + prompt);
            buffer = '';
          } else if (char === '\u007f') {
            if (buffer.length) {
              buffer = buffer.slice(0, -1);
              handlers.onData('stdout', '\b \b');
            }
          } else {
            buffer += char;
            handlers.onData('stdout', char);
          }
        }
      },
      resize: () => undefined,
      close: () => handlers.onClose(0),
    };
  }

  dispose() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
