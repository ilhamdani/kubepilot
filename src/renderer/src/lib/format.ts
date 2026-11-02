export type Tone = 'ok' | 'warning' | 'error' | 'info' | 'vague';

export function get(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** Compact "3d 4h" style duration, like the Age column in Lens. */
export function formatAge(timestamp?: string): string {
  if (!timestamp) return '-';
  const delta = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(delta) || delta < 0) return '-';
  if (delta < MINUTE) return `${Math.max(1, Math.floor(delta / 1000))}s`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < YEAR) return `${Math.floor(delta / DAY)}d`;
  return `${Math.floor(delta / YEAR)}y`;
}

/** Longer "2 days ago" style used in detail panels. */
export function formatAgeLong(timestamp?: string): string {
  if (!timestamp) return 'unknown';
  const delta = Date.now() - new Date(timestamp).getTime();
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const m = Math.floor(delta / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(delta / DAY);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function formatDateTime(timestamp?: string): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

/** millicores -> "240m" / "1.2 cores" */
export function formatCpu(millicores?: number): string {
  if (millicores == null) return '-';
  if (millicores < 1000) return `${Math.round(millicores)}m`;
  return `${(millicores / 1000).toFixed(1)}`;
}

export function formatMemory(bytes?: number): string {
  if (bytes == null) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatBytes(bytes?: number): string {
  return formatMemory(bytes);
}

/** Kubernetes quantity ("250m", "1Gi", "2") to a number in base units. */
export function parseQuantity(value?: string | number, kind: 'cpu' | 'memory' = 'memory'): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const match = String(value).match(/^([\d.]+)([a-zA-Z]*)$/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const suffix = match[2] ?? '';
  if (kind === 'cpu') {
    if (suffix === 'n') return amount / 1_000_000;
    if (suffix === 'u') return amount / 1000;
    if (suffix === 'm') return amount;
    return amount * 1000;
  }
  const units: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  return amount * (units[suffix] ?? 1);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function shortImage(image?: string): string {
  if (!image) return '-';
  const withoutRegistry = image.replace(/^[^/]*\//, '');
  const [name, tag] = withoutRegistry.split(':');
  return tag ? `${name}:${tag}` : name;
}

/** Truncate the middle of long names, keeping both ends readable. */
export function middleTruncate(value: string, max = 48): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

export interface StatusDescriptor {
  text: string;
  tone: Tone;
}

/** Status text + colour for any object, matching Lens' status semantics. */
export function statusOf(object: any): StatusDescriptor {
  const kind = object?.kind;
  const deletion = object?.metadata?.deletionTimestamp;
  if (deletion) return { text: 'Terminating', tone: 'vague' };

  switch (kind) {
    case 'Pod': {
      const waiting = object.status?.containerStatuses?.find((c: any) => c.state?.waiting?.reason)?.state
        ?.waiting?.reason;
      if (waiting && waiting !== 'ContainerCreating') return { text: waiting, tone: 'error' };
      const terminated = object.status?.containerStatuses?.find(
        (c: any) => c.state?.terminated?.reason && c.state.terminated.exitCode !== 0,
      )?.state?.terminated?.reason;
      if (terminated) return { text: terminated, tone: 'error' };
      const phase = object.status?.phase ?? 'Unknown';
      if (phase === 'Running') return { text: 'Running', tone: 'ok' };
      if (phase === 'Succeeded') return { text: 'Completed', tone: 'vague' };
      if (phase === 'Failed') return { text: 'Failed', tone: 'error' };
      if (phase === 'Pending') {
        const scheduled = object.status?.conditions?.find((c: any) => c.type === 'PodScheduled');
        if (scheduled?.status === 'False') return { text: 'Pending', tone: 'warning' };
        return { text: 'Pending', tone: 'warning' };
      }
      return { text: phase, tone: 'info' };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'ReplicationController': {
      const desired = object.spec?.replicas ?? 0;
      const ready = object.status?.readyReplicas ?? 0;
      if (desired === 0) return { text: 'Scaled to 0', tone: 'vague' };
      if (ready >= desired) return { text: 'Running', tone: 'ok' };
      if (ready === 0) return { text: 'Not ready', tone: 'error' };
      return { text: 'Degraded', tone: 'warning' };
    }
    case 'DaemonSet': {
      const desired = object.status?.desiredNumberScheduled ?? 0;
      const ready = object.status?.numberReady ?? 0;
      if (ready >= desired) return { text: 'Running', tone: 'ok' };
      return { text: ready === 0 ? 'Not ready' : 'Degraded', tone: ready === 0 ? 'error' : 'warning' };
    }
    case 'Job': {
      if (object.status?.succeeded) return { text: 'Completed', tone: 'ok' };
      if (object.status?.failed) return { text: 'Failed', tone: 'error' };
      return { text: 'Running', tone: 'info' };
    }
    case 'CronJob': {
      return object.spec?.suspend ? { text: 'Suspended', tone: 'vague' } : { text: 'Active', tone: 'ok' };
    }
    case 'Node': {
      const ready = object.status?.conditions?.find((c: any) => c.type === 'Ready');
      if (ready?.status === 'True') return { text: 'Ready', tone: 'ok' };
      return { text: 'NotReady', tone: 'error' };
    }
    case 'PersistentVolumeClaim':
    case 'PersistentVolume':
      return {
        text: object.status?.phase ?? 'Unknown',
        tone:
          object.status?.phase === 'Bound'
            ? 'ok'
            : object.status?.phase === 'Lost'
              ? 'error'
              : 'warning',
      };
    case 'Namespace':
      return {
        text: object.status?.phase ?? 'Active',
        tone: object.status?.phase === 'Active' ? 'ok' : 'warning',
      };
    case 'Certificate': {
      const ready = object.status?.conditions?.find((c: any) => c.type === 'Ready');
      return ready?.status === 'True'
        ? { text: 'Ready', tone: 'ok' }
        : { text: 'Not ready', tone: 'warning' };
    }
    default:
      return { text: 'Active', tone: 'ok' };
  }
}

export function isReady(object: any): boolean {
  return statusOf(object).tone === 'ok';
}

export function labelsToText(labels?: Record<string, string>): string {
  if (!labels) return '';
  return Object.entries(labels)
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join(', ');
}
