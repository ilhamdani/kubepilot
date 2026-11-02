import type { ReactNode } from 'react';
import { formatAge, formatCpu, formatMemory, get, parseQuantity, statusOf, type Tone } from './format';

export interface RowContext {
  /** `namespace/name` -> usage, from metrics-server when available. */
  metrics?: Map<string, { cpu: number; memory: number }>;
  /** Current namespace filter, used to hide a redundant column. */
  namespace?: string;
}

export interface ColumnDef {
  id: string;
  title: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  sortValue?: (object: any, ctx: RowContext) => string | number;
  cell: (object: any, ctx: RowContext) => ReactNode;
}

export type CatalogGroupId =
  | 'workloads'
  | 'config'
  | 'network'
  | 'storage'
  | 'access'
  | 'cluster'
  | 'custom';

export interface ResourceKind {
  id: string;
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  group: CatalogGroupId;
  label: string;
  /** Short description shown in the empty state and command palette. */
  description: string;
  columns: ColumnDef[];
  /** Supports `spec.replicas` scaling. */
  scalable?: boolean;
  /** Supports rollout restart. */
  restartable?: boolean;
}

const name: ColumnDef = {
  id: 'name',
  title: 'Name',
  width: 300,
  sortValue: (o) => o.metadata?.name ?? '',
  cell: (o) => o.metadata?.name,
};

const namespace: ColumnDef = {
  id: 'namespace',
  title: 'Namespace',
  width: 150,
  sortValue: (o) => o.metadata?.namespace ?? '',
  cell: (o) => o.metadata?.namespace ?? '-',
};

const age: ColumnDef = {
  id: 'age',
  title: 'Age',
  width: 90,
  align: 'right',
  sortValue: (o) => -(new Date(o.metadata?.creationTimestamp ?? 0).getTime() || 0),
  cell: (o) => formatAge(o.metadata?.creationTimestamp),
};

const text = (id: string, title: string, width: number, path: string, fallback = '-'): ColumnDef => ({
  id,
  title,
  width,
  sortValue: (o) => String(get(o, path) ?? ''),
  cell: (o) => {
    const value = get(o, path);
    if (value == null || value === '') return fallback;
    return Array.isArray(value) ? value.join(', ') : String(value);
  },
});

const count = (id: string, title: string, width: number, path: string): ColumnDef => ({
  id,
  title,
  width,
  align: 'right',
  sortValue: (o) => Number(get(o, path) ?? 0),
  cell: (o) => String(get(o, path) ?? 0),
});

function replicasColumn(id: string, title: string, width: number): ColumnDef {
  return {
    id,
    title,
    width,
    align: 'right',
    sortValue: (o) => Number(o.status?.readyReplicas ?? 0),
    cell: (o) => {
      const ready = o.status?.readyReplicas ?? 0;
      const desired = o.spec?.replicas ?? 0;
      return `${ready}/${desired}`;
    },
  };
}

function podCpu(): ColumnDef {
  return {
    id: 'cpu',
    title: 'CPU',
    width: 80,
    align: 'right',
    sortValue: (o, ctx) => ctx.metrics?.get(`${o.metadata.namespace}/${o.metadata.name}`)?.cpu ?? -1,
    cell: (o, ctx) => {
      const usage = ctx.metrics?.get(`${o.metadata.namespace}/${o.metadata.name}`);
      return usage ? formatCpu(usage.cpu) : '-';
    },
  };
}

function podMemory(): ColumnDef {
  return {
    id: 'memory',
    title: 'Memory',
    width: 100,
    align: 'right',
    sortValue: (o, ctx) => ctx.metrics?.get(`${o.metadata.namespace}/${o.metadata.name}`)?.memory ?? -1,
    cell: (o, ctx) => {
      const usage = ctx.metrics?.get(`${o.metadata.namespace}/${o.metadata.name}`);
      return usage ? formatMemory(usage.memory) : '-';
    },
  };
}

export const POD_COLUMNS: ColumnDef[] = [
  name,
  namespace,
  {
    id: 'status',
    title: 'Status',
    width: 118,
    sortValue: (o) => statusOf(o).text,
    cell: (o) => {
      const status = statusOf(o);
      return (
        <span style={{ color: toneForStatus(status.tone) }} title={status.text}>
          {status.text}
        </span>
      );
    },
  },
  {
    id: 'ready',
    title: 'Ready',
    width: 80,
    align: 'right',
    sortValue: (o) => {
      const statuses = o.status?.containerStatuses ?? [];
      return statuses.filter((c: any) => c.ready).length;
    },
    cell: (o) => {
      const statuses = o.status?.containerStatuses ?? [];
      const ready = statuses.filter((c: any) => c.ready).length;
      return `${ready}/${statuses.length || (o.spec?.containers?.length ?? 0)}`;
    },
  },
  {
    id: 'restarts',
    title: 'Restarts',
    width: 90,
    align: 'right',
    sortValue: (o) =>
      (o.status?.containerStatuses ?? []).reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0),
    cell: (o) => {
      const total = (o.status?.containerStatuses ?? []).reduce(
        (sum: number, c: any) => sum + (c.restartCount ?? 0),
        0,
      );
      return String(total);
    },
  },
  podCpu(),
  podMemory(),
  text('node', 'Node', 170, 'spec.nodeName'),
  age,
];

export const CATALOG: ResourceKind[] = [
  {
    id: 'pods',
    kind: 'Pod',
    apiVersion: 'v1',
    plural: 'pods',
    namespaced: true,
    group: 'workloads',
    label: 'Pods',
    description: 'The smallest deployable units of computing',
    columns: POD_COLUMNS,
  },
  {
    id: 'deployments',
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    plural: 'deployments',
    namespaced: true,
    group: 'workloads',
    label: 'Deployments',
    description: 'Declarative rolling updates for pods',
    scalable: true,
    restartable: true,
    columns: [
      name,
      namespace,
      replicasColumn('replicas', 'Replicas', 100),
      count('available', 'Available', 100, 'status.availableReplicas'),
      text('images', 'Images', 260, 'spec.template.spec.containers.0.image'),
      age,
    ],
  },
  {
    id: 'statefulsets',
    kind: 'StatefulSet',
    apiVersion: 'apps/v1',
    plural: 'statefulsets',
    namespaced: true,
    group: 'workloads',
    label: 'Stateful Sets',
    description: 'Pods with stable identity and storage',
    scalable: true,
    restartable: true,
    columns: [
      name,
      namespace,
      replicasColumn('replicas', 'Replicas', 100),
      text('service', 'Service', 180, 'spec.serviceName'),
      age,
    ],
  },
  {
    id: 'daemonsets',
    kind: 'DaemonSet',
    apiVersion: 'apps/v1',
    plural: 'daemonsets',
    namespaced: true,
    group: 'workloads',
    label: 'Daemon Sets',
    description: 'One pod per node, for cluster-wide agents',
    restartable: true,
    columns: [
      name,
      namespace,
      count('desired', 'Desired', 90, 'status.desiredNumberScheduled'),
      count('current', 'Current', 90, 'status.currentNumberScheduled'),
      count('ready', 'Ready', 90, 'status.numberReady'),
      age,
    ],
  },
  {
    id: 'replicasets',
    kind: 'ReplicaSet',
    apiVersion: 'apps/v1',
    plural: 'replicasets',
    namespaced: true,
    group: 'workloads',
    label: 'Replica Sets',
    description: 'Maintains a stable set of replica pods',
    scalable: true,
    columns: [
      name,
      namespace,
      replicasColumn('replicas', 'Replicas', 100),
      count('available', 'Available', 100, 'status.availableReplicas'),
      age,
    ],
  },
  {
    id: 'jobs',
    kind: 'Job',
    apiVersion: 'batch/v1',
    plural: 'jobs',
    namespaced: true,
    group: 'workloads',
    label: 'Jobs',
    description: 'Run pods to completion',
    columns: [
      name,
      namespace,
      {
        id: 'completions',
        title: 'Completions',
        width: 110,
        align: 'right',
        sortValue: (o) => o.status?.succeeded ?? 0,
        cell: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`,
      },
      age,
    ],
  },
  {
    id: 'cronjobs',
    kind: 'CronJob',
    apiVersion: 'batch/v1',
    plural: 'cronjobs',
    namespaced: true,
    group: 'workloads',
    label: 'Cron Jobs',
    description: 'Jobs on a recurring schedule',
    columns: [
      name,
      namespace,
      text('schedule', 'Schedule', 130, 'spec.schedule'),
      {
        id: 'suspend',
        title: 'Suspend',
        width: 90,
        sortValue: (o) => String(Boolean(o.spec?.suspend)),
        cell: (o) => (o.spec?.suspend ? 'Yes' : 'No'),
      },
      {
        id: 'last',
        title: 'Last schedule',
        width: 130,
        sortValue: (o) => -(new Date(o.status?.lastScheduleTime ?? 0).getTime() || 0),
        cell: (o) => formatAge(o.status?.lastScheduleTime),
      },
      age,
    ],
  },
  {
    id: 'horizontalpodautoscalers',
    kind: 'HorizontalPodAutoscaler',
    apiVersion: 'autoscaling/v2',
    plural: 'horizontalpodautoscalers',
    namespaced: true,
    group: 'workloads',
    label: 'Horizontal Pod Autoscalers',
    description: 'Automatic replica scaling from metrics',
    columns: [
      name,
      namespace,
      text('reference', 'Reference', 180, 'spec.scaleTargetRef.name'),
      {
        id: 'replicas',
        title: 'Replicas',
        width: 100,
        align: 'right',
        sortValue: (o) => o.status?.currentReplicas ?? 0,
        cell: (o) => `${o.status?.currentReplicas ?? 0} (max ${o.spec?.maxReplicas ?? '-'})`,
      },
      age,
    ],
  },
  {
    id: 'poddisruptionbudgets',
    kind: 'PodDisruptionBudget',
    apiVersion: 'policy/v1',
    plural: 'poddisruptionbudgets',
    namespaced: true,
    group: 'workloads',
    label: 'Pod Disruption Budgets',
    description: 'Limits voluntary pod disruption',
    columns: [
      name,
      namespace,
      text('minAvailable', 'Min available', 120, 'spec.minAvailable'),
      count('healthy', 'Healthy', 90, 'status.currentHealthy'),
      age,
    ],
  },

  {
    id: 'configmaps',
    kind: 'ConfigMap',
    apiVersion: 'v1',
    plural: 'configmaps',
    namespaced: true,
    group: 'config',
    label: 'Config Maps',
    description: 'Non-confidential configuration data',
    columns: [
      name,
      namespace,
      {
        id: 'keys',
        title: 'Keys',
        width: 90,
        align: 'right',
        sortValue: (o) => Object.keys(o.data ?? {}).length,
        cell: (o) => String(Object.keys(o.data ?? {}).length),
      },
      age,
    ],
  },
  {
    id: 'secrets',
    kind: 'Secret',
    apiVersion: 'v1',
    plural: 'secrets',
    namespaced: true,
    group: 'config',
    label: 'Secrets',
    description: 'Sensitive configuration and credentials',
    columns: [
      name,
      namespace,
      text('type', 'Type', 200, 'type'),
      {
        id: 'keys',
        title: 'Keys',
        width: 90,
        align: 'right',
        sortValue: (o) => Object.keys(o.data ?? {}).length,
        cell: (o) => String(Object.keys(o.data ?? {}).length),
      },
      age,
    ],
  },
  {
    id: 'resourcequotas',
    kind: 'ResourceQuota',
    apiVersion: 'v1',
    plural: 'resourcequotas',
    namespaced: true,
    group: 'config',
    label: 'Resource Quotas',
    description: 'Aggregate namespace resource limits',
    columns: [name, namespace, age],
  },
  {
    id: 'limitranges',
    kind: 'LimitRange',
    apiVersion: 'v1',
    plural: 'limitranges',
    namespaced: true,
    group: 'config',
    label: 'Limit Ranges',
    description: 'Default and max resource constraints per pod',
    columns: [name, namespace, age],
  },
  {
    id: 'leases',
    kind: 'Lease',
    apiVersion: 'coordination.k8s.io/v1',
    plural: 'leases',
    namespaced: true,
    group: 'config',
    label: 'Leases',
    description: 'Leader election and node heartbeats',
    columns: [name, namespace, text('holder', 'Holder', 220, 'spec.holderIdentity'), age],
  },
  {
    id: 'priorityclasses',
    kind: 'PriorityClass',
    apiVersion: 'scheduling.k8s.io/v1',
    plural: 'priorityclasses',
    namespaced: false,
    group: 'config',
    label: 'Priority Classes',
    description: 'Pod scheduling priority',
    columns: [name, count('value', 'Value', 90, 'value'), age],
  },
  {
    id: 'runtimeclasses',
    kind: 'RuntimeClass',
    apiVersion: 'node.k8s.io/v1',
    plural: 'runtimeclasses',
    namespaced: false,
    group: 'config',
    label: 'Runtime Classes',
    description: 'Container runtime configuration',
    columns: [name, text('handler', 'Handler', 160, 'handler'), age],
  },
  {
    id: 'mutatingwebhookconfigurations',
    kind: 'MutatingWebhookConfiguration',
    apiVersion: 'admissionregistration.k8s.io/v1',
    plural: 'mutatingwebhookconfigurations',
    namespaced: false,
    group: 'config',
    label: 'Mutating Webhooks',
    description: 'Admission webhooks that can mutate objects',
    columns: [
      name,
      {
        id: 'hooks',
        title: 'Webhooks',
        width: 100,
        align: 'right',
        sortValue: (o) => (o.webhooks ?? []).length,
        cell: (o) => String((o.webhooks ?? []).length),
      },
      age,
    ],
  },

  {
    id: 'services',
    kind: 'Service',
    apiVersion: 'v1',
    plural: 'services',
    namespaced: true,
    group: 'network',
    label: 'Services',
    description: 'Stable virtual IPs and load balancing',
    columns: [
      name,
      namespace,
      text('type', 'Type', 130, 'spec.type'),
      text('clusterIP', 'Cluster IP', 140, 'spec.clusterIP'),
      {
        id: 'external',
        title: 'External IP',
        width: 150,
        sortValue: (o) =>
          (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(','),
        cell: (o) => {
          const lb = (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname);
          if (lb.length) return lb.join(', ');
          if ((o.spec?.externalIPs ?? []).length) return o.spec.externalIPs.join(', ');
          return '-';
        },
      },
      {
        id: 'ports',
        title: 'Ports',
        width: 140,
        sortValue: (o) => (o.spec?.ports ?? []).map((p: any) => p.port).join(','),
        cell: (o) =>
          (o.spec?.ports ?? [])
            .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
            .join(', ') || '-',
      },
      age,
    ],
  },
  {
    id: 'endpoints',
    kind: 'Endpoints',
    apiVersion: 'v1',
    plural: 'endpoints',
    namespaced: true,
    group: 'network',
    label: 'Endpoints',
    description: 'Resolved addresses behind a service',
    columns: [
      name,
      namespace,
      {
        id: 'addresses',
        title: 'Addresses',
        width: 300,
        sortValue: (o) => (o.subsets ?? []).length,
        cell: (o) =>
          (o.subsets ?? [])
            .flatMap((s: any) => (s.addresses ?? []).map((a: any) => a.ip))
            .join(', ') || '-',
      },
      age,
    ],
  },
  {
    id: 'ingresses',
    kind: 'Ingress',
    apiVersion: 'networking.k8s.io/v1',
    plural: 'ingresses',
    namespaced: true,
    group: 'network',
    label: 'Ingresses',
    description: 'HTTP routing into the cluster',
    columns: [
      name,
      namespace,
      text('class', 'Class', 110, 'spec.ingressClassName'),
      {
        id: 'hosts',
        title: 'Hosts',
        width: 260,
        sortValue: (o) => (o.spec?.rules ?? []).map((r: any) => r.host).join(','),
        cell: (o) => (o.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean).join(', ') || '-',
      },
      age,
    ],
  },
  {
    id: 'ingressclasses',
    kind: 'IngressClass',
    apiVersion: 'networking.k8s.io/v1',
    plural: 'ingressclasses',
    namespaced: false,
    group: 'network',
    label: 'Ingress Classes',
    description: 'Ingress controller implementations',
    columns: [name, text('controller', 'Controller', 260, 'spec.controller'), age],
  },
  {
    id: 'networkpolicies',
    kind: 'NetworkPolicy',
    apiVersion: 'networking.k8s.io/v1',
    plural: 'networkpolicies',
    namespaced: true,
    group: 'network',
    label: 'Network Policies',
    description: 'Pod-level network segmentation',
    columns: [
      name,
      namespace,
      {
        id: 'types',
        title: 'Policy types',
        width: 180,
        sortValue: (o) => (o.spec?.policyTypes ?? []).join(','),
        cell: (o) => (o.spec?.policyTypes ?? []).join(', ') || '-',
      },
      age,
    ],
  },

  {
    id: 'persistentvolumeclaims',
    kind: 'PersistentVolumeClaim',
    apiVersion: 'v1',
    plural: 'persistentvolumeclaims',
    namespaced: true,
    group: 'storage',
    label: 'Persistent Volume Claims',
    description: 'Storage requests bound to volumes',
    columns: [
      name,
      namespace,
      text('volume', 'Volume', 180, 'spec.volumeName'),
      text('class', 'Storage Class', 150, 'spec.storageClassName'),
      {
        id: 'capacity',
        title: 'Capacity',
        width: 100,
        align: 'right',
        sortValue: (o) => parseQuantity(o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage),
        cell: (o) => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? '-',
      },
      age,
    ],
  },
  {
    id: 'persistentvolumes',
    kind: 'PersistentVolume',
    apiVersion: 'v1',
    plural: 'persistentvolumes',
    namespaced: false,
    group: 'storage',
    label: 'Persistent Volumes',
    description: 'Cluster-wide storage resources',
    columns: [
      name,
      text('capacity', 'Capacity', 100, 'spec.capacity.storage'),
      text('claim', 'Claim', 200, 'spec.claimRef.name'),
      text('class', 'Storage Class', 150, 'spec.storageClassName'),
      age,
    ],
  },
  {
    id: 'storageclasses',
    kind: 'StorageClass',
    apiVersion: 'storage.k8s.io/v1',
    plural: 'storageclasses',
    namespaced: false,
    group: 'storage',
    label: 'Storage Classes',
    description: 'Dynamic volume provisioning profiles',
    columns: [
      name,
      text('provisioner', 'Provisioner', 240, 'provisioner'),
      text('reclaim', 'Reclaim policy', 130, 'reclaimPolicy'),
      text('binding', 'Binding mode', 180, 'volumeBindingMode'),
      age,
    ],
  },
  {
    id: 'csidrivers',
    kind: 'CSIDriver',
    apiVersion: 'storage.k8s.io/v1',
    plural: 'csidrivers',
    namespaced: false,
    group: 'storage',
    label: 'CSI Drivers',
    description: 'Container storage interface drivers',
    columns: [name, text('attach', 'Attach required', 140, 'spec.attachRequired'), age],
  },

  {
    id: 'serviceaccounts',
    kind: 'ServiceAccount',
    apiVersion: 'v1',
    plural: 'serviceaccounts',
    namespaced: true,
    group: 'access',
    label: 'Service Accounts',
    description: 'Identities for workloads',
    columns: [
      name,
      namespace,
      {
        id: 'secrets',
        title: 'Secrets',
        width: 90,
        align: 'right',
        sortValue: (o) => (o.secrets ?? []).length,
        cell: (o) => String((o.secrets ?? []).length),
      },
      age,
    ],
  },
  {
    id: 'roles',
    kind: 'Role',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    plural: 'roles',
    namespaced: true,
    group: 'access',
    label: 'Roles',
    description: 'Namespace scoped permission rules',
    columns: [name, namespace, age],
  },
  {
    id: 'rolebindings',
    kind: 'RoleBinding',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    plural: 'rolebindings',
    namespaced: true,
    group: 'access',
    label: 'Role Bindings',
    description: 'Grants roles inside a namespace',
    columns: [name, namespace, text('role', 'Role', 200, 'roleRef.name'), age],
  },
  {
    id: 'clusterroles',
    kind: 'ClusterRole',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    plural: 'clusterroles',
    namespaced: false,
    group: 'access',
    label: 'Cluster Roles',
    description: 'Cluster wide permission rules',
    columns: [name, age],
  },
  {
    id: 'clusterrolebindings',
    kind: 'ClusterRoleBinding',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    plural: 'clusterrolebindings',
    namespaced: false,
    group: 'access',
    label: 'Cluster Role Bindings',
    description: 'Grants cluster roles to subjects',
    columns: [name, text('role', 'Role', 220, 'roleRef.name'), age],
  },

  {
    id: 'namespaces',
    kind: 'Namespace',
    apiVersion: 'v1',
    plural: 'namespaces',
    namespaced: false,
    group: 'cluster',
    label: 'Namespaces',
    description: 'Virtual clusters for resource isolation',
    columns: [name, age],
  },
  {
    id: 'nodes',
    kind: 'Node',
    apiVersion: 'v1',
    plural: 'nodes',
    namespaced: false,
    group: 'cluster',
    label: 'Nodes',
    description: 'Machines that run your workloads',
    columns: [
      name,
      {
        id: 'status',
        title: 'Status',
        width: 110,
        sortValue: (o) => statusOf(o).text,
        cell: (o) => {
          const status = statusOf(o);
          return <span style={{ color: toneForStatus(status.tone) }}>{status.text}</span>;
        },
      },
      {
        id: 'roles',
        title: 'Roles',
        width: 150,
        sortValue: (o) => Object.keys(o.metadata?.labels ?? {}).filter((l) => l.startsWith('node-role')).join(','),
        cell: (o) => {
          const roles = Object.keys(o.metadata?.labels ?? {})
            .filter((l) => l.startsWith('node-role.kubernetes.io/'))
            .map((l) => l.replace('node-role.kubernetes.io/', ''));
          return roles.length ? roles.join(', ') : '<none>';
        },
      },
      {
        id: 'cpu',
        title: 'CPU',
        width: 130,
        align: 'right',
        sortValue: (o, ctx) => ctx.metrics?.get(`/${o.metadata.name}`)?.cpu ?? -1,
        cell: (o, ctx) => {
          const usage = ctx.metrics?.get(`/${o.metadata.name}`);
          const capacity = parseQuantity(o.status?.allocatable?.cpu ?? o.status?.capacity?.cpu, 'cpu');
          return usage ? `${formatCpu(usage.cpu)} / ${formatCpu(capacity)}` : formatCpu(capacity);
        },
      },
      {
        id: 'memory',
        title: 'Memory',
        width: 170,
        align: 'right',
        sortValue: (o, ctx) => ctx.metrics?.get(`/${o.metadata.name}`)?.memory ?? -1,
        cell: (o, ctx) => {
          const usage = ctx.metrics?.get(`/${o.metadata.name}`);
          const capacity = parseQuantity(o.status?.allocatable?.memory ?? o.status?.capacity?.memory);
          return usage ? `${formatMemory(usage.memory)} / ${formatMemory(capacity)}` : formatMemory(capacity);
        },
      },
      text('version', 'Version', 130, 'status.nodeInfo.kubeletVersion'),
      age,
    ],
  },
  {
    id: 'events',
    kind: 'Event',
    apiVersion: 'v1',
    plural: 'events',
    namespaced: true,
    group: 'cluster',
    label: 'Events',
    description: 'What the cluster has been doing',
    columns: [
      {
        id: 'type',
        title: 'Type',
        width: 100,
        sortValue: (o) => o.type ?? '',
        cell: (o) => o.type ?? 'Normal',
      },
      text('reason', 'Reason', 170, 'reason'),
      {
        id: 'object',
        title: 'Object',
        width: 240,
        sortValue: (o) => o.involvedObject?.name ?? '',
        cell: (o) => `${o.involvedObject?.kind ?? ''}/${o.involvedObject?.name ?? ''}`,
      },
      {
        id: 'message',
        title: 'Message',
        width: 420,
        sortValue: (o) => o.message ?? '',
        cell: (o) => o.message ?? '-',
      },
      count('count', 'Count', 70, 'count'),
      {
        id: 'lastSeen',
        title: 'Last seen',
        width: 110,
        align: 'right',
        sortValue: (o) => -(new Date(o.lastTimestamp ?? 0).getTime() || 0),
        cell: (o) => formatAge(o.lastTimestamp ?? o.eventTime),
      },
    ],
  },
  {
    id: 'customresourcedefinitions',
    kind: 'CustomResourceDefinition',
    apiVersion: 'apiextensions.k8s.io/v1',
    plural: 'customresourcedefinitions',
    namespaced: false,
    group: 'cluster',
    label: 'Custom Resource Definitions',
    description: 'Extend the Kubernetes API',
    columns: [
      name,
      text('group', 'Group', 200, 'spec.group'),
      text('kind', 'Kind', 160, 'spec.names.kind'),
      text('scope', 'Scope', 120, 'spec.scope'),
      age,
    ],
  },
];

export const GROUPS: Array<{ id: CatalogGroupId; label: string }> = [
  { id: 'workloads', label: 'Workloads' },
  { id: 'config', label: 'Config' },
  { id: 'network', label: 'Network' },
  { id: 'storage', label: 'Storage' },
  { id: 'access', label: 'Access Control' },
  { id: 'cluster', label: 'Cluster' },
  { id: 'custom', label: 'Custom Resources' },
];

export function findKindByKind(kind: string): ResourceKind | undefined {
  return CATALOG.find((entry) => entry.kind === kind);
}

export function findKindById(id: string): ResourceKind | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

export function toneForStatus(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'var(--colorOk)';
    case 'warning':
      return 'var(--colorWarning)';
    case 'error':
      return 'var(--colorError)';
    case 'info':
      return 'var(--colorInfo)';
    default:
      return 'var(--colorTerminated)';
  }
}

export function statusColumn(object: any) {
  return statusOf(object);
}
