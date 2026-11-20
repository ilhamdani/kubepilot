/**
 * Pure state rules for notifications, port forwards and tab bookkeeping.
 * Kept free of React and Electron imports so they can be unit-tested directly.
 */
import type { PortForwardState } from '@shared/types';

export type NoticeTone = 'info' | 'success' | 'error';

export interface Notice {
  id: string;
  tone: NoticeTone;
  message: string;
  title?: string;
  /** Extra technical text (API error, warnings), shown behind "Show details". */
  detail?: string;
  /** Milliseconds before auto-dismiss; 0 means sticky until dismissed. */
  duration: number;
  at: number;
  read: boolean;
}

export interface NoticeOptions {
  title?: string;
  detail?: string;
  duration?: number;
}

export const DEFAULT_DURATION: Record<NoticeTone, number> = {
  info: 5000,
  success: 6500,
  // Errors must not vanish before the user has read them.
  error: 0,
};

export const DEFAULT_TITLE: Record<NoticeTone, string> = {
  info: 'Heads up',
  success: 'Success',
  error: 'Something went wrong',
};

export const MAX_VISIBLE_NOTICES = 4;
export const MAX_NOTICE_HISTORY = 60;

export function makeNotice(
  id: string,
  message: string,
  tone: NoticeTone = 'info',
  options: NoticeOptions = {},
  now = Date.now(),
): Notice {
  return {
    id,
    tone,
    message: message || '(no message)',
    title: options.title || DEFAULT_TITLE[tone],
    detail: options.detail?.trim() || undefined,
    duration: options.duration ?? DEFAULT_DURATION[tone],
    at: now,
    read: false,
  };
}

/** Merge one port-forward state update into the list; `stopped` removes it. */
export function applyPortForwardState(
  list: PortForwardState[],
  next: PortForwardState,
): PortForwardState[] {
  if (next.status === 'stopped') return list.filter((entry) => entry.id !== next.id);
  const index = list.findIndex((entry) => entry.id === next.id);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  copy[index] = { ...copy[index], ...next };
  return copy;
}

export function activeForwards(list: PortForwardState[]): PortForwardState[] {
  return list.filter((entry) => entry.status === 'starting' || entry.status === 'active');
}

/** Create tabs whose YAML differs from their untouched template. */
export function unsavedDraftCount(
  tabs: Array<{ kind: string; createDraft?: string; create?: { yaml?: string } }>,
): number {
  return tabs.filter(
    (tab) =>
      tab.kind === 'create' &&
      tab.createDraft !== undefined &&
      tab.createDraft !== (tab.create?.yaml ?? ''),
  ).length;
}
