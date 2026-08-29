/**
 * electron/main.cjs — Electron entry for BJS Character Controller Builder
 *
 * Starts the existing Express server (server.mjs) in-process on a free port,
 * then opens builder.html in a BrowserWindow.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getFreePort } = require('./ports.cjs');

let mainWindow = null;

async function startServer(port) {
  process.env.PORT = String(port);
  const serverPath = path.join(__dirname, '..', 'server.mjs');
  const serverModule = await import(pathToFileURL(serverPath).href);
  return serverModule.startServer({ port, host: '127.0.0.1' });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1024,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d1017',
    autoHideMenuBar: true,
    title: 'BJS Character Controller Builder V2',
    icon: path.join(__dirname, '..', 'assets', 'icons', 'icon2.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links (Mixamo, Buy Me a Coffee…) open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') shell.openExternal(parsed.toString());
    } catch (_) { /* deny malformed external URLs */ }
    return { action: 'deny' };
  });

  const localOrigin = `http://127.0.0.1:${port}`;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${localOrigin}/`)) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  mainWindow.loadURL(`${localOrigin}/builder.html`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Single instance lock — second launch focuses existing window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const port = await getFreePort(3000);
      await startServer(port);
      createWindow(port);
    } catch (err) {
      console.error('[electron] Startup error:', err && err.stack || err);
      dialog.showErrorBox('Startup error', String(err && err.stack || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
