"use strict";

const { WebSocketServer } = require("ws");

// Binary wire format from server -> browser, one WS message per video
// packet (config or frame):
//   byte 0    : flags (bit0 = isConfig, bit1 = isKeyFrame)
//   bytes 1-8 : pts, u64 BE (0 for config packets, meaningless there)
//   remainder : raw Annex-B H.264 payload
const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;

// Roughly a couple of frames' worth. Past this the client is behind.
const MAX_BUFFERED_BYTES = 512 * 1024;

function encodeVideoMessage({ config, keyFrame, pts, payload }) {
  const header = Buffer.alloc(9);
  header.writeUInt8((config ? FLAG_CONFIG : 0) | (keyFrame ? FLAG_KEYFRAME : 0), 0);
  header.writeBigUInt64BE(BigInt(config ? 0 : pts), 1);
  return Buffer.concat([header, payload]);
}

// Broadcasts scrcpy video frames to every connected browser client, and
// forwards JSON input messages from clients to a caller-supplied handler.
class Hub {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.clients = new Set();
    this.onInput = null; // set by index.js
    // Called at most once per resync episode, when a client first falls
    // behind, so the server can request a fresh keyframe from the device
    // sooner than the next spontaneous one (which this stream otherwise
    // only emits once, at startup). Set by index.js.
    this.onNeedKeyframe = null;
    this.lastSessionInfo = null; // { width, height } — re-sent to late-joining clients
    // scrcpy only emits one CONFIG+KEYFRAME pair at stream start, not
    // periodically — a client connecting after that point would otherwise
    // never see one and could never bootstrap its decoder. Cache and
    // replay the last pair (as the already-encoded wire buffers) to every
    // new connection.
    this.lastConfigMsg = null;
    this.lastKeyFrameMsg = null;
    this.lastStatus = { state: "idle", serial: null };

    // WebSocketServer re-emits errors from the http server it's attached
    // to (e.g. EADDRINUSE). Without a listener here that copy is
    // unhandled and crashes the process before index.js's own
    // server.on("error") handler can respond.
    this.wss.on("error", (err) => {
      if (err.code !== "EADDRINUSE") console.error("WebSocket server error:", err.message);
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      // A client that has fallen behind is held here (not sent delta
      // frames) until the next keyframe, since resuming mid-GOP would
      // decode against a reference frame it never received and corrupt
      // every frame after it — visible as smeared, doubled-looking video
      // that never self-heals until the rare next spontaneous keyframe.
      ws._resyncing = false;
      ws.send(JSON.stringify({ type: "status", ...this.lastStatus }));
      if (this.lastSessionInfo) ws.send(JSON.stringify({ type: "session", ...this.lastSessionInfo }));
      if (this.lastConfigMsg) ws.send(this.lastConfigMsg);
      if (this.lastKeyFrameMsg) ws.send(this.lastKeyFrameMsg);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (data, isBinary) => {
        if (isBinary || !this.onInput) return;
        try {
          this.onInput(JSON.parse(data.toString("utf8")));
        } catch (e) {
          console.error("Bad input message from client:", e.message);
        }
      });
    });
  }

  // Tells already-open tabs that the device changed. Without this, a tab
  // open across a switch keeps showing a frozen frame from the previous
  // device until new frames happen to arrive, and its VideoDecoder stays
  // configured for the old device's stream.
  broadcastStatus({ state, serial = null, error = null }) {
    this.lastStatus = { state, serial, error };
    const msg = JSON.stringify({ type: "status", ...this.lastStatus });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  // Drops cached video so a client connecting mid-switch can't be served
  // the previous device's keyframe.
  resetVideoCache() {
    this.lastSessionInfo = null;
    this.lastConfigMsg = null;
    this.lastKeyFrameMsg = null;
  }

  broadcastSessionInfo({ width, height }) {
    this.lastSessionInfo = { width, height };
    const msg = JSON.stringify({ type: "session", width, height });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  broadcastVideoPacket(packet) {
    const msg = encodeVideoMessage(packet);
    if (packet.config) this.lastConfigMsg = msg;
    else if (packet.keyFrame) this.lastKeyFrameMsg = msg;

    if (this.clients.size === 0) return;

    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;

      if (ws._resyncing) {
        // A keyframe is a valid resume point on its own; a bare config
        // packet is not (it carries no picture), so pair it with the
        // cached keyframe exactly like a fresh connection would receive,
        // rather than waiting for a second keyframe that may be a long
        // time coming.
        if (packet.keyFrame) {
          if (this.lastConfigMsg) ws.send(this.lastConfigMsg);
          ws.send(msg);
          ws._resyncing = false;
        }
        continue; // still behind — hold everything else, config included
      }

      // Config and key frames always go through even under backpressure:
      // skipping either would itself corrupt the stream rather than just
      // delaying it.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES && !packet.config && !packet.keyFrame) {
        ws._resyncing = true;
        if (this.onNeedKeyframe) this.onNeedKeyframe();
        continue;
      }
      ws.send(msg);
    }
  }
}

module.exports = { Hub };
