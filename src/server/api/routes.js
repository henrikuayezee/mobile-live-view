"use strict";

const express = require("express");
const control = require("../scrcpy/control-protocol");
const { MOTIONEVENT_ACTION } = require("../scrcpy/constants");
const adb = require("../adb/adb");
const { BusyError } = require("../device-manager");
const qrPairing = require("../qr-pairing");
const ui = require("./ui");

// Plain HTTP endpoints for driving the device from a script or from
// Claude Code. The browser UI does not need these: it clicks the live
// view canvas directly, which is the same path a person uses.
// Reuses the same control-protocol encoders as the WS-driven UI.
//
// Every handler resolves deviceManager.currentSession FRESH per request:
// holding a closed-over session would keep driving the previous phone
// after a device switch (and write to its dead socket).
function buildApiRouter({ deviceManager, hub }) {
  const router = express.Router();
  router.use(express.json());

  // Returns the live session, or sends a 503 and returns null.
  function requireSession(res) {
    const session = deviceManager.currentSession;
    if (!session) {
      res.status(503).json({ error: "no device connected" });
      return null;
    }
    return session;
  }

  function requireStreaming(res) {
    const session = requireSession(res);
    if (!session) return null;
    if (!hub.lastSessionInfo) {
      res.status(503).json({ error: "stream dimensions not known yet" });
      return null;
    }
    // Callers work in DEVICE pixels, because that is what screenshots and
    // uiautomator report. The encoded stream may be smaller (max_size), and
    // scrcpy interprets touch coordinates against the stream size, so every
    // incoming coordinate has to be scaled across.
    const stream = hub.lastSessionInfo;
    const device = session.deviceResolution || stream;
    const toStream = (x, y) => ({
      x: Math.round(x * (stream.width / device.width)),
      y: Math.round(y * (stream.height / device.height)),
    });
    return { session, info: stream, stream, device, toStream };
  }

  function handleError(res, e) {
    if (e instanceof BusyError || e.code === "BUSY") {
      return res.status(409).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message });
  }

  // --- device management -------------------------------------------------

  router.get("/devices", async (req, res) => {
    try {
      res.json({ devices: await deviceManager.listDevices() });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get("/status", (req, res) => {
    const session = deviceManager.currentSession;
    res.json({
      // "connected" (sockets up) and "ready" (video metadata parsed) are
      // distinct moments — the parser needs to walk the stream header
      // before dimensions are known, typically a beat after connect.
      connected: !!session,
      ready: !!hub.lastSessionInfo,
      serial: session ? session.serial : null,
      adbBinary: session ? session.adbBinary : null,
      // Coordinates for every endpoint are in DEVICE pixels, matching
      // screenshots and uiautomator. streamResolution is the encoded size
      // and is informational only.
      resolution: session && session.deviceResolution ? session.deviceResolution : hub.lastSessionInfo || null,
      streamResolution: hub.lastSessionInfo || null,
    });
  });

  // Serial goes in the body rather than the path: wireless serials are
  // long and punctuation-heavy, and this matches /pair's shape.
  router.post("/devices/connect", async (req, res) => {
    const { serial } = req.body || {};
    if (!serial) return res.status(400).json({ error: "serial required" });
    try {
      res.json({ ok: true, ...(await deviceManager.connect(serial)) });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post("/devices/disconnect", async (req, res) => {
    try {
      await deviceManager.disconnect();
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post("/pair", async (req, res) => {
    const { addr, code } = req.body || {};
    if (!addr || !code) return res.status(400).json({ error: "addr and code required" });
    try {
      const { output } = await deviceManager.pair(addr, code);
      res.json({ ok: true, output: output.trim() });
    } catch (e) {
      handleError(res, e);
    }
  });

  // QR pairing: the phone scans a generated code and we discover + pair
  // against it automatically, so nothing has to be typed by hand.
  router.post("/pair/qr", async (req, res) => {
    try {
      res.json(await qrPairing.startSession());
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get("/pair/qr/status", (req, res) => {
    res.json(qrPairing.getStatus());
  });

  router.post("/pair/qr/cancel", (req, res) => {
    qrPairing.cancelSession();
    res.json({ ok: true });
  });

  // --- device interaction ------------------------------------------------

  router.get("/device-info", (req, res) => {
    const ctx = requireStreaming(res);
    if (!ctx) return;
    res.json({ ...ctx.device, serial: ctx.session.serial, streamResolution: ctx.stream });
  });

  router.post("/tap", (req, res) => {
    const ctx = requireStreaming(res);
    if (!ctx) return;
    const { x, y } = req.body;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "x and y (numbers) required" });
    }
    const p = ctx.toStream(x, y);
    const pos = { ...p, screenWidth: ctx.stream.width, screenHeight: ctx.stream.height };
    ctx.session.writeControl(control.injectTouchEvent({ action: MOTIONEVENT_ACTION.DOWN, ...pos }));
    ctx.session.writeControl(control.injectTouchEvent({ action: MOTIONEVENT_ACTION.UP, ...pos }));
    res.json({ ok: true, devicePoint: { x: Math.round(x), y: Math.round(y) }, streamPoint: p });
  });

  router.post("/swipe", async (req, res) => {
    const ctx = requireStreaming(res);
    if (!ctx) return;
    const { x1, y1, x2, y2, durationMs = 300, steps = 10 } = req.body;
    for (const v of [x1, y1, x2, y2]) {
      if (!Number.isFinite(v)) return res.status(400).json({ error: "x1,y1,x2,y2 (numbers) required" });
    }
    const screenWidth = ctx.stream.width;
    const screenHeight = ctx.stream.height;
    const stepDelay = durationMs / steps;
    const session = ctx.session;
    const start = ctx.toStream(x1, y1);
    const finish = ctx.toStream(x2, y2);

    // This loop awaits between steps, so the device can be switched out
    // from under it — bail cleanly rather than writing to a dead socket.
    try {
      session.writeControl(
        control.injectTouchEvent({ action: MOTIONEVENT_ACTION.DOWN, x: start.x, y: start.y, screenWidth, screenHeight })
      );
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, stepDelay));
        if (deviceManager.currentSession !== session) {
          return res.status(409).json({ error: "device changed during swipe" });
        }
        const t = i / steps;
        session.writeControl(
          control.injectTouchEvent({
            action: MOTIONEVENT_ACTION.MOVE,
            x: Math.round(start.x + (finish.x - start.x) * t),
            y: Math.round(start.y + (finish.y - start.y) * t),
            screenWidth,
            screenHeight,
          })
        );
      }
      session.writeControl(
        control.injectTouchEvent({ action: MOTIONEVENT_ACTION.UP, x: finish.x, y: finish.y, screenWidth, screenHeight })
      );
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post("/text", (req, res) => {
    const session = requireSession(res);
    if (!session) return;
    const { text } = req.body;
    if (typeof text !== "string" || !text.length) {
      return res.status(400).json({ error: "non-empty text (string) required" });
    }
    session.writeControl(control.injectText(text));
    res.json({ ok: true });
  });

  router.post("/key", (req, res) => {
    const session = requireSession(res);
    if (!session) return;
    const { keycode } = req.body;
    if (!Number.isFinite(keycode)) return res.status(400).json({ error: "keycode (number) required" });
    session.writeControl(control.keyDown(keycode));
    session.writeControl(control.keyUp(keycode));
    res.json({ ok: true });
  });

  // --- UI inspection ------------------------------------------------------
  // Lets a caller aim at things by NAME instead of guessed pixel
  // coordinates, which is the main source of mis-taps when automating.

  router.get("/ui/dump", async (req, res) => {
    const session = requireSession(res);
    if (!session) return;
    try {
      res.set("Content-Type", "application/xml").send(await ui.dumpXml(session));
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get("/ui/elements", async (req, res) => {
    const session = requireSession(res);
    if (!session) return;
    try {
      const xml = await ui.dumpXml(session);
      const all = ui.parseElements(xml, { interactiveOnly: req.query.all !== "1" });
      const list = req.query.q ? ui.findElements(all, req.query.q) : all;
      res.json({ count: list.length, elements: list });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Find by visible label and tap its real touch target in one call.
  router.post("/ui/tap", async (req, res) => {
    const ctx = requireStreaming(res);
    if (!ctx) return;
    const { text, exact = false, index = 0 } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });

    try {
      const xml = await ui.dumpXml(ctx.session);
      const all = ui.parseElements(xml, { interactiveOnly: false });
      const matches = ui.findElements(all, text, { exact });

      if (!matches.length) {
        const visible = all.filter((e) => e.label).map((e) => e.label);
        return res.status(404).json({
          error: `No element matching "${text}"`,
          visibleLabels: [...new Set(visible)].slice(0, 60),
        });
      }
      if (index >= matches.length) {
        return res.status(400).json({ error: `index ${index} out of range (${matches.length} matches)` });
      }

      const target = ui.resolveTapTarget(all, matches[index]);
      const p = ctx.toStream(target.center.x, target.center.y);
      const pos = { ...p, screenWidth: ctx.stream.width, screenHeight: ctx.stream.height };
      ctx.session.writeControl(control.injectTouchEvent({ action: MOTIONEVENT_ACTION.DOWN, ...pos }));
      ctx.session.writeControl(control.injectTouchEvent({ action: MOTIONEVENT_ACTION.UP, ...pos }));

      res.json({
        ok: true,
        matched: { label: matches[index].label, class: matches[index].class },
        tappedAt: target.center,
        totalMatches: matches.length,
      });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get("/screenshot", async (req, res) => {
    const session = requireSession(res);
    if (!session) return;
    try {
      const { stdout, err, stderr } = await adb.run(
        session.adbBinary,
        ["-s", session.serial, "exec-out", "screencap", "-p"],
        { encoding: "buffer", maxBuffer: 1024 * 1024 * 50 }
      );
      if (err) return res.status(500).json({ error: String(stderr || err.message) });
      res.set("Content-Type", "image/png");
      res.send(stdout);
    } catch (e) {
      handleError(res, e);
    }
  });

  return router;
}

module.exports = { buildApiRouter };
