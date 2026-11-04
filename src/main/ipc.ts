import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron';
import { dump, loadAll } from 'js-yaml';
import type {
  ApplyResult,
  AppInfo,
  ClusterState,
  ExecRequest,
  KubeconfigImportResult,
  LogRequest,
  PortForwardState,
  ResourceQuery,
  ResourceRef,
  StoredSettings,
} from '@shared/types';
import { ClusterRegistry } from './kube/registry';
import { invalidateExecCache } from './kube/config';
import {
  KubeconfigError,
  normalizeKubeconfigDoc,
  renameConflictingContexts,
  safeFileStem,
  validateKubeconfigDoc,
} from './kube/paste';

interface LogSession {
  stop: () => void;
  sender: Electron.WebContents;
}
interface ExecSession {
  handle: { write: (d: string) => void; resize: (c: number, r: number) => void; close: () => void };
  sender: Electron.WebContents;
}
export function registerIpc(registry: ClusterRegistry): void {
  const watches = new Map<string, () => void>();
  const logSessions = new Map<string, LogSession>();
  const execSessions = new Map<string, ExecSession>();
  // Processes and states are separate: an errored tunnel keeps a visible state
  // after its process has exited, so the user can still read what went wrong.
  const portForwardProcesses = new Map<string, ChildProcess>();
  const portForwardStates = new Map<string, PortForwardState>();

  const send = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  registry.onStateChange((state: ClusterState) => send('kubepilot:cluster-state', state));

  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    kubeconfigPaths: registry.allKubeconfigPaths(),
    homeDir: app.getPath('home'),
  }));

  ipcMain.handle('clusters:list', () => registry.listClusters());
  ipcMain.handle('clusters:states', () => registry.allStates());
  ipcMain.handle('clusters:connect', (_e, clusterId: string) => registry.connect(clusterId));
  ipcMain.handle('clusters:disconnect', (_e, clusterId: string) => registry.disconnect(clusterId));

  ipcMain.handle('kubeconfig:paths', () => registry.allKubeconfigPaths());
  ipcMain.handle('kubeconfig:add', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Add kubeconfig',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'kubeconfig', extensions: ['yaml', 'yml', 'config', 'kubeconfig', '*'] }],
    });
    if (result.canceled) return { paths: registry.allKubeconfigPaths(), added: [] as string[] };
    for (const file of result.filePaths) registry.addKubeconfigPath(file);
    return { paths: registry.allKubeconfigPaths(), added: result.filePaths };
  });
  ipcMain.handle('kubeconfig:remove', (_e, path: string) => registry.removeKubeconfigPath(path));

  /**
   * Imports a kubeconfig the user pasted as text. The copy is stored inside
   * userData (never in ~/.kube), with owner-only permissions where the OS
   * supports them. Context names that collide with an existing kubeconfig are
   * renamed in the imported copy so `live:<name>` ids stay unique.
   */
  ipcMain.handle(
    'kubeconfig:paste',
    (_e, payload: { content: string; name?: string }): KubeconfigImportResult => {
      const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
      if (!content) throw new Error('Paste a kubeconfig first — the text area is empty.');
      if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
        throw new Error('That kubeconfig is larger than the 2 MB import limit.');
      }

      let docs: unknown[];
      try {
        docs = loadAll(content) as unknown[];
      } catch (err: any) {
        const reason = String(err?.message ?? err).split('\n')[0];
        throw new Error(`This is not valid YAML: ${reason}`);
      }
      const objects = docs.filter(
        (doc): doc is Record<string, unknown> =>
          Boolean(doc) && typeof doc === 'object' && !Array.isArray(doc),
      );
      if (!objects.length) throw new Error('The pasted text does not contain a YAML document.');

      const chosen =
        objects.find(
          (doc) => Array.isArray(doc.contexts) || Array.isArray(doc.clusters),
        ) ?? objects[0];
      const ignoredDocuments = Math.max(0, objects.length - 1);

      let parsed;
      try {
        parsed = validateKubeconfigDoc(chosen, ignoredDocuments);
      } catch (err) {
        if (err instanceof KubeconfigError) throw new Error(err.message);
        throw err;
      }

      const warnings = [...parsed.warnings];
      const normalized = normalizeKubeconfigDoc(parsed.doc);
      const renamed = renameConflictingContexts(parsed.doc, registry.existingContextNames());
      warnings.push(...renamed.warnings);

      // Keep the user's text verbatim when nothing had to change; otherwise
      // write the normalized single document (a multi-doc file would be
      // unreadable to the YAML loader used everywhere else).
      const fileContent =
        normalized || renamed.renames.length || ignoredDocuments ? dump(parsed.doc) : content;

      const dir = registry.kubeconfigImportDir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stem = safeFileStem(payload.name?.trim() || parsed.contexts[0] || 'pasted');
      const file = join(dir, `${stem}-${Date.now()}-${randomBytes(3).toString('hex')}.yaml`);
      writeFileSync(file, fileContent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* Windows has no POSIX modes; the file is already inside userData */
      }

      registry.addKubeconfigPath(file);
      const contexts = registry
        .listClusters()
        .filter((cluster) => resolve(cluster.kubeconfigPath) === resolve(file))
        .map((cluster) => cluster.name);
      if (!contexts.length) {
        warnings.push('The file was saved but no connectable context was found in it.');
      }
      return { paths: registry.allKubeconfigPaths(), path: file, contexts, warnings };
    },
  );

  ipcMain.handle('resources:list', async (_e, query: ResourceQuery) => {
    const backend = registry.backend(query.clusterId);
    return backend.list(query);
  });

  ipcMain.handle('resources:get', async (_e, ref: ResourceRef) => {
    const backend = registry.backend(ref.clusterId);
    return backend.get(ref);
  });

  ipcMain.handle(
    'resources:apply',
    async (
      _e,
      payload: {
        clusterId: string;
        yaml: string;
        kindMap?: Record<string, { plural: string; namespaced: boolean }>;
      },
    ): Promise<ApplyResult[]> => {
      const backend = registry.backend(payload.clusterId);
      const docs = loadAll(payload.yaml) as any[];
      const results: ApplyResult[] = [];
      for (const doc of docs) {
        if (!doc || typeof doc !== 'object' || !doc.kind) continue;
        const hint = payload.kindMap?.[doc.kind];
        const plural = hint?.plural ?? guessPlural(doc.kind);
        const namespaced = hint?.namespaced ?? Boolean(doc.metadata?.namespace);
        const saved = await backend.apply(doc, plural, namespaced);
        results.push({
          kind: saved.kind ?? doc.kind,
          name: saved.metadata?.name ?? doc.metadata?.name,
          namespace: saved.metadata?.namespace,
          action: 'configured',
        });
      }
      return results;
    },
  );

  ipcMain.handle('resources:delete', async (_e, ref: ResourceRef & { propagation?: 'Foreground' | 'Background' | 'Orphan' }) => {
    const backend = registry.backend(ref.clusterId);
    await backend.remove(ref, ref.propagation ?? 'Background');
    return true;
  });

  ipcMain.handle('resources:scale', async (_e, payload: { ref: ResourceRef; replicas: number }) => {
    const backend = registry.backend(payload.ref.clusterId);
    return backend.scale(payload.ref, payload.replicas);
  });

  ipcMain.handle('resources:restart', async (_e, ref: ResourceRef) => {
    const backend = registry.backend(ref.clusterId);
    return backend.restart(ref);
  });

  ipcMain.handle('metrics:pods', async (_e, clusterId: string) => {
    try {
      return await registry.backend(clusterId).podMetrics();
    } catch {
      return [];
    }
  });

  ipcMain.handle('metrics:nodes', async (_e, clusterId: string) => {
    try {
      return await registry.backend(clusterId).nodeMetrics();
    } catch {
      return [];
    }
  });

  ipcMain.handle('watch:start', (event, query: ResourceQuery) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const backend = registry.backend(query.clusterId);
    const stop = backend.watch(
      query,
      (type, object) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('kubepilot:watch-event', { watchId: id, type, object });
        }
      },
      (message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('kubepilot:watch-error', { watchId: id, message });
        }
      },
    );
    watches.set(id, stop);
    return id;
  });

  ipcMain.handle('watch:stop', (_e, id: string) => {
    watches.get(id)?.();
    watches.delete(id);
    return true;
  });

  ipcMain.handle('logs:start', (event, req: LogRequest) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const backend = registry.backend(req.clusterId);
    const stop = backend.logs(
      req,
      (text) => {
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:logs-data', { streamId: id, text });
      },
      (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:logs-end', { streamId: id, error: err });
        logSessions.delete(id);
      },
    );
    logSessions.set(id, { stop, sender: event.sender });
    return id;
  });

  ipcMain.handle('logs:stop', (_e, id: string) => {
    logSessions.get(id)?.stop();
    logSessions.delete(id);
    return true;
  });

  ipcMain.handle('exec:start', async (event, req: ExecRequest) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const backend = registry.backend(req.clusterId);
    // May reject (e.g. no shell in a distroless container); the renderer shows it.
    const handle = await backend.exec(req, {
      onData: (stream, data) => {
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:exec-data', { sessionId: id, stream, data });
      },
      onError: (message) => {
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:exec-data', { sessionId: id, stream: 'stderr', data: message });
      },
      onClose: (code) => {
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:exec-exit', { sessionId: id, code });
        execSessions.delete(id);
      },
    });
    execSessions.set(id, { handle, sender: event.sender });
    return id;
  });

  ipcMain.handle('exec:write', (_e, payload: { sessionId: string; data: string }) => {
    execSessions.get(payload.sessionId)?.handle.write(payload.data);
    return true;
  });

  ipcMain.handle('exec:resize', (_e, payload: { sessionId: string; cols: number; rows: number }) => {
    execSessions.get(payload.sessionId)?.handle.resize(payload.cols, payload.rows);
    return true;
  });

  ipcMain.handle('exec:close', (_e, sessionId: string) => {
    execSessions.get(sessionId)?.handle.close();
    execSessions.delete(sessionId);
    return true;
  });

  ipcMain.handle('settings:get', () => registry.settings);
  ipcMain.handle('settings:set', (_e, patch: Partial<StoredSettings>) => registry.updateSettings(patch));

  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('shell:show-item', (_e, path: string) => shell.showItemInFolder(path));

  // Port forwarding is delegated to kubectl when it is installed: implementing
  // the SPDY upgrade by hand would duplicate a tool the user already has.
  // State is broadcast to *every* window, not just the one that started the
  // tunnel, so the sidebar and status bar cannot drift out of sync.
  const publishForward = (next: PortForwardState) => {
    if (next.status === 'stopped') portForwardStates.delete(next.id);
    else portForwardStates.set(next.id, next);
    send('kubepilot:portforward-state', next);
  };
  const stopForward = (id: string): boolean => {
    const child = portForwardProcesses.get(id);
    portForwardProcesses.delete(id);
    child?.kill();
    const current = portForwardStates.get(id);
    if (current) publishForward({ ...current, status: 'stopped' });
    return Boolean(child || current);
  };

  ipcMain.handle('portforward:list', () => [...portForwardStates.values()]);

  ipcMain.handle(
    'portforward:start',
    async (
      _event,
      req: {
        clusterId: string;
        namespace: string;
        kind: 'pod' | 'service';
        name: string;
        localPort: number;
        remotePort: number;
      },
    ) => {
      // Ids must be unique: the old `ns/name:port` key overwrote the previous
      // process handle when two tunnels shared a local port, leaving a stray
      // kubectl child that could never be stopped.
      const id = `${req.namespace}/${req.name}:${req.localPort}-${randomBytes(3).toString('hex')}`;
      const state: PortForwardState = {
        id,
        ...req,
        status: 'starting',
        startedAt: Date.now(),
      };
      const emit = (next: PortForwardState) => publishForward({ ...state, ...next, id });

      const conflict = [...portForwardStates.values()].find(
        (other) => other.localPort === req.localPort && other.status !== 'stopped',
      );
      if (conflict) {
        const failed: PortForwardState = {
          ...state,
          status: 'error',
          error: `Local port ${req.localPort} is already used by ${conflict.namespace}/${conflict.name}:${conflict.remotePort}. Pick a different local port or stop that tunnel first.`,
        };
        publishForward(failed);
        return failed;
      }
      const cluster = registry.listClusters().find((c) => c.id === req.clusterId);
      if (!cluster) {
        const failed: PortForwardState = { ...state, status: 'error', error: 'Unknown cluster' };
        publishForward(failed);
        return failed;
      }

      const args = [
        'port-forward',
        `${req.kind}/${req.name}`,
        `${req.localPort}:${req.remotePort}`,
        '-n',
        req.namespace,
        '--context',
        cluster.name,
      ];
      let child: ChildProcess;
      try {
        child = spawn('kubectl', args, {
          env: { ...process.env, KUBECONFIG: registry.allKubeconfigPaths().join(delimiter) },
          windowsHide: true,
        });
      } catch (err: any) {
        const failed: PortForwardState = {
          ...state,
          status: 'error',
          error: `kubectl could not be started: ${err?.message ?? String(err)}`,
        };
        publishForward(failed);
        return failed;
      }
      portForwardProcesses.set(id, child);
      publishForward(state);

      const latest = () => portForwardStates.get(id) ?? state;
      child.stdout?.on('data', (chunk) => {
        if (String(chunk).includes('Forwarding from') && latest().status !== 'error') {
          emit({ ...latest(), status: 'active' });
        }
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) emit({ ...latest(), status: 'error', error: text });
      });
      child.on('error', (err) => {
        // Spawning a missing binary emits 'error'; without a listener the main
        // process would die instead of reporting the problem.
        emit({
          ...latest(),
          status: 'error',
          error: `kubectl could not be started: ${err.message}. Install kubectl and make sure it is on PATH.`,
        });
        portForwardProcesses.delete(id);
      });
      child.on('exit', () => {
        portForwardProcesses.delete(id);
        const current = portForwardStates.get(id);
        if (current) publishForward({ ...current, status: 'stopped' });
      });
      return state;
    },
  );

  ipcMain.handle('portforward:stop', (_e, id: string) => stopForward(id));
  ipcMain.handle('portforward:stopAll', () => {
    const ids = [...portForwardStates.keys()];
    for (const id of ids) stopForward(id);
    return ids.length;
  });

  ipcMain.handle('app:relogin', () => {
    invalidateExecCache();
    return true;
  });
}

function guessPlural(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith('s')) return lower;
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}
