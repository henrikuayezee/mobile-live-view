"use strict";

const express = require("express");
const http = require("http");
const { exec } = require("child_process");
const config = require("./config");
const { mountStatic } = require("./static");
const { Hub } = require("./ws/hub");
const { DeviceManager } = require("./device-manager");
const control = require("./scrcpy/control-protocol");
const { MOTIONEVENT_ACTION } = require("./scrcpy/constants");
const { buildApiRouter } = require("./api/routes");

const AUTO_OPEN = process.env.AUTO_OPEN_BROWSER === "1";

// Resolves once the launch command has actually run. exec() is async, so
// callers that exit immediately afterwards MUST await this — otherwise the
// process dies before the browser is ever spawned.
function openBrowser(url) {
  return new Promise((resolve) => {
    // `start` is a cmd builtin, hence the cmd /c wrapper; the empty ""
    // argument is the window title, which `start` otherwise steals from a
    // quoted URL.
    let cmd;
    if (process.platform === "win32") cmd = `cmd /c start "" "${url}"`;
    else if (process.platform === "darwin") cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}"`;

    exec(cmd, (err) => {
      if (err) console.warn(`Could not open browser automatically: ${err.message}`);
      resolve();
    });
  });
}

(async () => {
  const app = express();
  mountStatic(app);

  const server = http.createServer(app);
  const hub = new Hub(server);
  const deviceManager = new DeviceManager(hub);

  const TOUCH_ACTION = {
    down: MOTIONEVENT_ACTION.DOWN,
    move: MOTIONEVENT_ACTION.MOVE,
    up: MOTIONEVENT_ACTION.UP,
  };
  hub.onInput = (msg) => {
    // Resolved fresh per event — a closed-over session would keep driving
    // the previous phone (and write to its dead socket) after a switch.
    const session = deviceManager.currentSession;
    if (!session) return;

    if (msg.type === "touch") {
      const action = TOUCH_ACTION[msg.action];
      if (action === undefined || !hub.lastSessionInfo) return;
      // The canvas is sized from the decoded stream, so these coordinates
      // are already in stream space and need no scaling - unlike the HTTP
      // API, whose callers work in device pixels.
      session.writeControl(
        control.injectTouchEvent({
          action,
          x: msg.x,
          y: msg.y,
          screenWidth: hub.lastSessionInfo.width,
          screenHeight: hub.lastSessionInfo.height,
        })
      );
    } else if (msg.type === "key" && Number.isFinite(msg.keycode)) {
      session.writeControl(control.keyDown(msg.keycode));
      session.writeControl(control.keyUp(msg.keycode));
    } else if (msg.type === "scroll") {
      if (!hub.lastSessionInfo) return;
      session.writeControl(
        control.injectScrollEvent({
          x: msg.x,
          y: msg.y,
          screenWidth: hub.lastSessionInfo.width,
          screenHeight: hub.lastSessionInfo.height,
          hscroll: msg.hscroll,
          vscroll: msg.vscroll,
        })
      );
    }
  };

  // A client falling behind is recovered by requesting a fresh keyframe
  // (hub.js holds that client's stream at the current keyframe/config
  // pair until it arrives), not by dropping frames arbitrarily — this
  // stream otherwise only emits a keyframe once, at startup, and P-frames
  // decode relative to the frame before them, so an arbitrary drop
  // corrupts everything downstream until the next one.
  hub.onNeedKeyframe = () => {
    const session = deviceManager.currentSession;
    if (session) session.writeControl(control.resetVideo());
  };

  app.use("/api", buildApiRouter({ deviceManager, hub }));

  const url = `http://localhost:${config.webPort}`;

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      // Double-launch: an instance is already serving this port. When
      // launched by launch.bat, just surface that one instead of dying in
      // a minimized window the user can't see. During a plain dev run,
      // fail loudly instead.
      if (AUTO_OPEN) {
        console.log(`Already running at ${url} — opening existing instance.`);
        await openBrowser(url); // must await, or exit kills the spawn
        process.exit(0);
      }
      console.error(`Port ${config.webPort} is already in use.`);
      process.exit(1);
    }
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  // Listen FIRST, unconditionally: the UI (and Settings in particular)
  // must be reachable even with no device connected — that's exactly when
  // you need it to pick or pair one.
  server.listen(config.webPort, async () => {
    console.log(`Mobile Live View running at ${url}`);
    if (AUTO_OPEN) openBrowser(url);
    // No-op under plain `node src/server/index.js` (process.send only
    // exists when forked) — lets electron/main.js know when to create its
    // window instead of polling the port or scraping stdout.
    if (process.send) process.send({ type: "listening", port: config.webPort });

    const result = await deviceManager.autoReconnect();
    if (!result) console.log("No device connected. Open Settings to pick one.");
  });

  async function shutdown() {
    console.log("\nShutting down...");
    try {
      await deviceManager.disconnect();
    } catch (_) {
      // Best-effort; we're exiting regardless.
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // A phone dropping off the network (wireless debugging switching itself
  // off, Wi-Fi roaming) can surface as an async error from a dying adb or
  // socket. That must not take the whole tool down: the web UI is exactly
  // what the user needs at that moment to reconnect. Log and keep serving.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server staying up):", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server staying up):", reason && reason.message ? reason.message : reason);
  });
})().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
