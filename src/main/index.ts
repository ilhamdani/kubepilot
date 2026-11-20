import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { ClusterRegistry } from './kube/registry';
import { registerIpc } from './ipc';

// A single instance keeps the kubeconfig watchers and port forwards sane.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#181a1c',
    title: 'KubePilot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode);
  });

  mainWindow.webContents.on('preload-error', (_event, path, error) => {
    console.error('[preload error]', path, error);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the system browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);

  const registry = new ClusterRegistry();
  registerIpc(registry);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
