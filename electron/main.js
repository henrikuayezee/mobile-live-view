"use strict";

const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");
const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const config = require("../src/server/config");

// Only one window makes sense for a single-device live view — a second
// launch should just bring the existing one forward, not start a second
// server fighting the first for the same port and adb session.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let serverChild = null;
  // The window's bounds right before "compact view" shrank it — restored
  // verbatim on exit. Also doubles as the "are we currently compact" flag.
  let preCompactBounds = null;

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Read-only files shipped with the app. In a packaged build these live
  // under extraResources (real files outside app.asar — adb.exe gets
  // spawned and the jar gets `adb push`'d, and neither is visible to an
  // external process if left inside the archive). Unpackaged (`npm run
  // electron`), there is no resourcesPath equivalent worth relying on, so
  // fall back to the project's own vendor/ — exactly what `npm run
  // fetch-scrcpy-server` / `npm run fetch-adb` already populate.
  function bundledVendorDir() {
    return app.isPackaged
      ? path.join(process.resourcesPath, "vendor")
      : path.join(__dirname, "..", "vendor");
  }

  // vendor/last-device.json and vendor/quality-settings.json are written
  // at runtime — an installed app's own directory may not be writable
  // (and shouldn't be depended on across updates/reinstalls anyway), so
  // the server actually reads/writes a per-user directory instead (see
  // config.js's MLV_VENDOR_DIR). Seed it once from the bundled read-only
  // jar so that directory has everything session.js expects, matching
  // dev-mode's vendor/ layout.
  function seedUserVendorDir() {
    const userVendorDir = path.join(app.getPath("userData"), "vendor");
    fs.mkdirSync(userVendorDir, { recursive: true });

    const bundledJar = path.join(bundledVendorDir(), config.SCRCPY_SERVER_JAR);
    const userJar = path.join(userVendorDir, config.SCRCPY_SERVER_JAR);
    if (!fs.existsSync(userJar) && fs.existsSync(bundledJar)) {
      fs.copyFileSync(bundledJar, userJar);
    }
    return userVendorDir;
  }

  function startServer() {
    const userVendorDir = seedUserVendorDir();
    const bundledAdb = path.join(bundledVendorDir(), "platform-tools", "adb.exe");

    const serverPath = path.join(__dirname, "..", "src", "server", "index.js");
    const child = fork(serverPath, [], {
      env: {
        ...process.env,
        MLV_VENDOR_DIR: userVendorDir,
        MLV_BUNDLED_ADB_PATH: fs.existsSync(bundledAdb) ? bundledAdb : "",
        // The window is created by this file once the server is ready —
        // the server's own "open an OS browser tab" behavior would be
        // redundant (and wrong) here.
        AUTO_OPEN_BROWSER: "0",
      },
    });
    serverChild = child;

    child.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

    let readyReceived = false;
    child.once("message", (msg) => {
      if (msg && msg.type === "listening") {
        readyReceived = true;
        createWindow(msg.port);
      }
    });

    // Covers the case where the server exits before ever reporting
    // ready — most commonly the port already being in use by a `npm
    // start`/dev-server instance run separately. Without this the app
    // would just sit there with no window and no explanation.
    child.on("exit", (code) => {
      if (!readyReceived) {
        dialog.showErrorBox(
          "Mobile Live View could not start",
          `The background server exited before it was ready (code ${code}).\n\n` +
            `If another copy of Mobile Live View (or a dev server on the same port) is already running, close it and try again.`
        );
        app.quit();
      }
    });
  }

  function createWindow(port) {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 780,
      // Low enough that "compact view" (see mlv:enter-compact below) can
      // shrink the window down around a narrow portrait phone stream —
      // just a floor against a degenerate zero-size window, not a
      // meaningful usability minimum for normal mode.
      minWidth: 280,
      minHeight: 360,
      frame: false,
      backgroundColor: "#141414",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.on("maximize", () => mainWindow.webContents.send("mlv:maximized-change", true));
    mainWindow.on("unmaximize", () => mainWindow.webContents.send("mlv:maximized-change", false));
    mainWindow.on("closed", () => {
      mainWindow = null;
      preCompactBounds = null;
    });

    mainWindow.loadURL(`http://localhost:${port}/index.html`);
  }

  ipcMain.on("mlv:minimize", () => mainWindow?.minimize());
  ipcMain.on("mlv:maximize", () => mainWindow?.maximize());
  ipcMain.on("mlv:unmaximize", () => mainWindow?.unmaximize());
  ipcMain.on("mlv:close", () => mainWindow?.close());
  ipcMain.handle("mlv:isMaximized", () => mainWindow?.isMaximized() ?? false);

  // "Compact view" (app.js) — collapses the title bar and rail down to
  // their thin strips and shrinks the actual OS window to exactly the
  // phone's own pixel size, so there's no leftover black gutter around
  // it. CSS alone can only do the first half; the window itself has to
  // actually get smaller for the second half, which is a main-process
  // job. Sizing is capped to the display's work area (minus a small
  // margin) and scaled down proportionally if the phone stream itself
  // is bigger than the screen.
  const COMPACT_CHROME_PX = 10; // matches titlebar.css/live-view.css's .collapsed size
  ipcMain.on("mlv:enter-compact", (_event, { phoneWidth, phoneHeight }) => {
    if (!mainWindow || preCompactBounds) return; // already compact — ignore
    if (!Number.isFinite(phoneWidth) || !Number.isFinite(phoneHeight)) return;

    preCompactBounds = mainWindow.getBounds();
    if (mainWindow.isMaximized()) mainWindow.unmaximize();

    let targetWidth = phoneWidth + COMPACT_CHROME_PX;
    let targetHeight = phoneHeight + COMPACT_CHROME_PX;

    const { workAreaSize } = screen.getDisplayMatching(mainWindow.getBounds());
    const maxWidth = workAreaSize.width - 40;
    const maxHeight = workAreaSize.height - 40;
    if (targetWidth > maxWidth || targetHeight > maxHeight) {
      const scale = Math.min(maxWidth / targetWidth, maxHeight / targetHeight);
      targetWidth = Math.round(targetWidth * scale);
      targetHeight = Math.round(targetHeight * scale);
    }

    mainWindow.setContentSize(Math.round(targetWidth), Math.round(targetHeight));
  });

  ipcMain.on("mlv:exit-compact", () => {
    if (!mainWindow || !preCompactBounds) return;
    mainWindow.setBounds(preCompactBounds);
    preCompactBounds = null;
  });

  app.whenReady().then(startServer);

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", () => {
    if (serverChild && !serverChild.killed) serverChild.kill();
  });
}
