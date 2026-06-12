/**
 * electron/main.cjs — Electron entry for BJS Character Controller Builder
 *
 * Starts the existing Express server (server.mjs) in-process on a free port,
 * then opens builder.html in a BrowserWindow.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const net = require('net');
const { pathToFileURL } = require('url');

let mainWindow = null;

/** Find a free TCP port, preferring 3000. */
function getFreePort(preferred = 3000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // Preferred port busy → let OS pick one
      const srv2 = net.createServer();
      srv2.listen(0, () => {
        const port = srv2.address().port;
        srv2.close(() => resolve(port));
      });
    });
    srv.listen(preferred, () => {
      srv.close(() => resolve(preferred));
    });
  });
}

async function startServer(port) {
  process.env.PORT = String(port);
  // server.mjs calls app.listen() on import
  const serverPath = path.join(__dirname, '..', 'server.mjs');
  await import(pathToFileURL(serverPath).href);
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
    },
  });

  // External links (Mixamo, Buy Me a Coffee…) open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://localhost:${port}/builder.html`);
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
      dialog.showErrorBox('Startup error', String(err && err.stack || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
