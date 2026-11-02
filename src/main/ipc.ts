import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron';
import { loadAll } from 'js-yaml';
import type {
  ApplyResult,
  AppInfo,
  ClusterState,
  ExecRequest,
  LogRequest,
  PortForwardState,
  ResourceQuery,
  ResourceRef,
  StoredSettings,
} from '@shared/types';
import { ClusterRegistry } from './kube/registry';
import { invalidateExecCache } from './kube/config';

interface LogSession {
  stop: () => void;
  sender: Electron.WebContents;
}
interface ExecSession {
  handle: { write: (d: string) => void; resize: (c: number, r: number) => void; close: () => void };
  sender: Electron.WebContents;
}
interface PortForwardSession {
  process: ChildProcess;
  state: PortForwardState;
}

export function registerIpc(registry: ClusterRegistry): void {
  const watches = new Map<string, () => void>();
  const logSessions = new Map<string, LogSession>();
  const execSessions = new Map<string, ExecSession>();
  const portForwards = new Map<string, PortForwardSession>();

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
  ipcMain.handle('portforward:list', () => [...portForwards.values()].map((p) => p.state));

  ipcMain.handle(
    'portforward:start',
    async (event, req: { clusterId: string; namespace: string; kind: 'pod' | 'service'; name: string; localPort: number; remotePort: number }) => {
      const id = `${req.namespace}/${req.name}:${req.localPort}`;
      const state: PortForwardState = {
        id,
        ...req,
        status: 'starting',
      };
      const cluster = registry.listClusters().find((c) => c.id === req.clusterId);
      if (!cluster || cluster.kind === 'demo') {
        const failed = { ...state, status: 'error' as const, error: 'Port forwarding needs a live cluster' };
        event.sender.send('kubepilot:portforward-state', failed);
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
      const child = spawn('kubectl', args, {
        env: { ...process.env, KUBECONFIG: registry.allKubeconfigPaths().join(delimiter) },
        windowsHide: true,
      });
      portForwards.set(id, { process: child, state });
      const emit = (next: PortForwardState) => {
        const session = portForwards.get(id);
        if (session) session.state = next;
        if (!event.sender.isDestroyed()) event.sender.send('kubepilot:portforward-state', next);
      };
      child.stdout?.on('data', (chunk) => {
        if (String(chunk).includes('Forwarding from')) emit({ ...state, status: 'active' });
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) emit({ ...state, status: 'error', error: text });
      });
      child.on('error', (err) => {
        // Spawning a missing binary emits 'error'; without a listener the main
        // process would die instead of reporting the problem.
        emit({ ...state, status: 'error', error: `kubectl could not be started: ${err.message}` });
        portForwards.delete(id);
      });
      child.on('exit', () => {
        portForwards.delete(id);
        if (!event.sender.isDestroyed()) {
          event.sender.send('kubepilot:portforward-state', { ...state, status: 'stopped' });
        }
      });
      return state;
    },
  );

  ipcMain.handle('portforward:stop', (_e, id: string) => {
    portForwards.get(id)?.process.kill();
    portForwards.delete(id);
    return true;
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
