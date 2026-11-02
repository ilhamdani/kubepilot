import { dump } from 'js-yaml';
import type { KubeObject } from '@shared/types';

/**
 * YAML for the editor and the diff panes. `metadata.managedFields` is written
 * by the API server, is enormous, and would make every apply fail, so it is
 * removed from the copy we render. Everything else (labels, annotations,
 * resourceVersion) stays: the document should match what the user sees on the
 * cluster.
 */
export function dumpObject(object: KubeObject | null | undefined): string {
  if (!object) return '';
  const clone: KubeObject = { ...object };
  if (object.metadata) {
    clone.metadata = { ...object.metadata };
    delete clone.metadata.managedFields;
  }
  return dump(clone, { noRefs: true, lineWidth: 120 });
}
