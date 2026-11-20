import type { CSSProperties } from 'react';

const COLORS: Record<string, string> = {
  Pod: '#3d90ce',
  Deployment: '#3d90ce',
  StatefulSet: '#3d90ce',
  DaemonSet: '#3d90ce',
  ReplicaSet: '#3d90ce',
  Job: '#3d90ce',
  CronJob: '#3d90ce',
  HorizontalPodAutoscaler: '#3d90ce',
  PodDisruptionBudget: '#3d90ce',
  ConfigMap: '#c93dce',
  Secret: '#c93dce',
  ResourceQuota: '#c93dce',
  LimitRange: '#c93dce',
  Lease: '#c93dce',
  PriorityClass: '#c93dce',
  RuntimeClass: '#c93dce',
  MutatingWebhookConfiguration: '#c93dce',
  Service: '#2aa198',
  Endpoints: '#2aa198',
  Ingress: '#2aa198',
  IngressClass: '#2aa198',
  NetworkPolicy: '#2aa198',
  PersistentVolumeClaim: '#d9a441',
  PersistentVolume: '#d9a441',
  StorageClass: '#d9a441',
  CSIDriver: '#d9a441',
  ServiceAccount: '#e08a3c',
  Role: '#e08a3c',
  RoleBinding: '#e08a3c',
  ClusterRole: '#e08a3c',
  ClusterRoleBinding: '#e08a3c',
  Namespace: '#87909c',
  Node: '#87909c',
  Event: '#87909c',
  CustomResourceDefinition: '#c93dce',
};

export function kindColor(kind: string): string {
  return COLORS[kind] ?? '#87909c';
}

interface IconProps {
  kind: string;
  size?: number;
  style?: CSSProperties;
}

/** Small geometric glyphs, one per Kubernetes kind. */
export function ResourceIcon({ kind, size = 16, style }: IconProps) {
  const color = kindColor(kind);
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style,
  };

  switch (kind) {
    case 'Pod':
      return (
        <svg {...common}>
          <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" />
          <circle cx="8" cy="8" r="2.1" />
        </svg>
      );
    case 'Deployment':
      return (
        <svg {...common}>
          <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" />
          <path d="M5.4 6.4 8 8l2.6-1.6M8 8v3.6" />
        </svg>
      );
    case 'StatefulSet':
      return (
        <svg {...common}>
          <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" />
          <path d="M5.6 5.8h4.8M5.6 8h4.8M5.6 10.2h4.8" />
        </svg>
      );
    case 'DaemonSet':
      return (
        <svg {...common}>
          <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" />
          <circle cx="5.9" cy="8" r="0.9" fill={color} />
          <circle cx="8" cy="8" r="0.9" fill={color} />
          <circle cx="10.1" cy="8" r="0.9" fill={color} />
        </svg>
      );
    case 'ReplicaSet':
      return (
        <svg {...common}>
          <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" strokeDasharray="2 1.6" />
          <path d="M8 5.4 11 7v3L8 11.6 5 10V7z" />
        </svg>
      );
    case 'Job':
      return (
        <svg {...common}>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" />
          <path d="M5.6 8.2 7.4 10l3-3.6" />
        </svg>
      );
    case 'CronJob':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.4" />
          <path d="M8 4.8V8l2.2 1.6" />
        </svg>
      );
    case 'HorizontalPodAutoscaler':
      return (
        <svg {...common}>
          <path d="M2.4 5.2h4.4M2.4 10.8h4.4M13.6 5.2H9.2M13.6 10.8H9.2" />
          <path d="M5 3.2 2.4 5.2 5 7.2M11 8.8l2.6 2-2.6 2" />
        </svg>
      );
    case 'PodDisruptionBudget':
      return (
        <svg {...common}>
          <path d="M8 2 12.6 3.8v4c0 2.6-1.9 4.6-4.6 5.8-2.7-1.2-4.6-3.2-4.6-5.8v-4z" />
          <path d="M6.2 7.8 7.6 9.2l2.4-2.8" />
        </svg>
      );
    case 'ConfigMap':
      return (
        <svg {...common}>
          <path d="M3.4 2.6h6l3.2 3.2v7.6H3.4z" />
          <path d="M9.2 2.6v3.4h3.4M5.4 8.4h5M5.4 10.6h3.4" />
        </svg>
      );
    case 'Secret':
      return (
        <svg {...common}>
          <rect x="3" y="6.6" width="10" height="7" rx="1.6" />
          <path d="M5.6 6.6V5a2.4 2.4 0 0 1 4.8 0v1.6" />
          <circle cx="8" cy="10" r="0.9" fill={color} />
        </svg>
      );
    case 'ResourceQuota':
    case 'LimitRange':
      return (
        <svg {...common}>
          <path d="M2.6 11.4a5.4 5.4 0 0 1 10.8 0" />
          <path d="M8 11.4 10.6 7.8" />
          <circle cx="8" cy="11.4" r="1" fill={color} />
        </svg>
      );
    case 'Service':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2v3.8M8 10.2V14M2 8h3.8M10.2 8H14" />
          <circle cx="8" cy="2" r="1" fill={color} />
          <circle cx="8" cy="14" r="1" fill={color} />
          <circle cx="2" cy="8" r="1" fill={color} />
          <circle cx="14" cy="8" r="1" fill={color} />
        </svg>
      );
    case 'Endpoints':
      return (
        <svg {...common}>
          <circle cx="3.4" cy="8" r="1.8" />
          <circle cx="12.6" cy="8" r="1.8" />
          <path d="M5.2 8h5.6" />
        </svg>
      );
    case 'Ingress':
      return (
        <svg {...common}>
          <path d="M2.4 4.6h7.2v6.8H2.4z" />
          <path d="M9.6 8h4M11.6 6l2 2-2 2" />
        </svg>
      );
    case 'IngressClass':
      return (
        <svg {...common}>
          <path d="M2.6 5.4h6.2v5.2H2.6zM8.8 8h4.6" />
          <path d="M10.8 6.2 12.8 8l-2 1.8" />
        </svg>
      );
    case 'NetworkPolicy':
      return (
        <svg {...common}>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" />
          <path d="M2.6 8h10.8M8 2.6v10.8" />
        </svg>
      );
    case 'PersistentVolumeClaim':
    case 'PersistentVolume':
      return (
        <svg {...common}>
          <ellipse cx="8" cy="4.2" rx="4.6" ry="1.8" />
          <path d="M3.4 4.2v7.6c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8V4.2" />
        </svg>
      );
    case 'StorageClass':
      return (
        <svg {...common}>
          <ellipse cx="8" cy="3.8" rx="4.6" ry="1.6" />
          <path d="M3.4 3.8v4c0 .9 2 1.6 4.6 1.6s4.6-.7 4.6-1.6v-4" />
          <path d="M3.4 7.8v4c0 .9 2 1.6 4.6 1.6s4.6-.7 4.6-1.6v-4" />
        </svg>
      );
    case 'CSIDriver':
      return (
        <svg {...common}>
          <rect x="2.6" y="4.6" width="10.8" height="6.8" rx="1.4" />
          <path d="M5.2 4.6V3.4h5.6v1.2M6 8h4" />
        </svg>
      );
    case 'Namespace':
      return (
        <svg {...common}>
          <path d="M2.4 4.4a1.4 1.4 0 0 1 1.4-1.4h2.4l1.4 1.8h5a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z" />
        </svg>
      );
    case 'Node':
      return (
        <svg {...common}>
          <rect x="2.6" y="2.8" width="10.8" height="4.4" rx="1.2" />
          <rect x="2.6" y="8.8" width="10.8" height="4.4" rx="1.2" />
          <circle cx="5" cy="5" r="0.7" fill={color} />
          <circle cx="5" cy="11" r="0.7" fill={color} />
        </svg>
      );
    case 'Event':
      return (
        <svg {...common}>
          <path d="M8.8 1.8 4.4 8.6h3.2l-.8 5.6 4.8-7.2H8z" />
        </svg>
      );
    case 'ServiceAccount':
      return (
        <svg {...common}>
          <circle cx="8" cy="5.6" r="2.2" />
          <path d="M3.6 13.4a4.4 4.4 0 0 1 8.8 0" />
        </svg>
      );
    case 'Role':
    case 'RoleBinding':
    case 'ClusterRole':
    case 'ClusterRoleBinding':
      return (
        <svg {...common}>
          <circle cx="5.6" cy="5.8" r="2.2" />
          <path d="M7.4 7.4 12.4 12.4M10.6 10.6l1.4-1.4M11.8 11.8l1.2-1.2" />
        </svg>
      );
    case 'CustomResourceDefinition':
      return (
        <svg {...common}>
          <path d="M8 2 13.4 5v6L8 14 2.6 11V5z" />
          <path d="M8 8 13.4 5M8 8v6M8 8 2.6 5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 2 13.4 5v6L8 14 2.6 11V5z" />
          <path d="M8 8 13.4 5M8 8v6M8 8 2.6 5" />
        </svg>
      );
  }
}

export function StatusBrick({ tone, style }: { tone: string; style?: CSSProperties }) {
  const color =
    tone === 'ok'
      ? 'var(--colorOk)'
      : tone === 'warning'
        ? 'var(--colorWarning)'
        : tone === 'error'
          ? 'var(--colorError)'
          : tone === 'info'
            ? 'var(--colorInfo)'
            : 'var(--colorTerminated)';
  return <span className="status-brick" style={{ background: color, ...style }} />;
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron ${open ? 'chevron--open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 2 6.5 5 3.5 8" />
    </svg>
  );
}

export function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3 3" />
    </svg>
  );
}

export function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="m3 3 6 6M9 3l-6 6" />
    </svg>
  );
}

export function KubeIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2.6 20.4 7.4v9.2L12 21.4 3.6 16.6V7.4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 9.4V6.2M14.3 13.3l2.6 1.6M9.7 13.3l-2.6 1.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
