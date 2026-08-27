"use strict";

const fs = require("fs");
const path = require("path");
const adb = require("./adb/adb");
const {
  resolveAdbBinary,
  listDevices,
  isWirelessSerial,
  pairWithAnyCandidate,
} = require("./adb/locate-adb");
const { ScrcpySession } = require("./scrcpy/session");
const config = require("./config");

const LAST_DEVICE_FILE = path.join(config.vendorDir, "last-device.json");

// Owns the single mutable ScrcpySession and mediates every device
// transition. ScrcpySession itself assumes exactly one session exists at
// a time (it binds one fixed local forward port), so all transitions are
// serialized behind a busy flag.
class DeviceManager {
  constructor(hub) {
    this.hub = hub;
    this._session = null;
    this._busy = false;
  }

  get currentSession() {
    return this._session;
  }

  get currentSerial() {
    return this._session ? this._session.serial : null;
  }

  async listDevices() {
    const { adbBinary } = await resolveAdbBinary();
    const devices = await listDevices(adbBinary);
    const current = this.currentSerial;
    return devices.map((d) => ({ ...d, isCurrent: d.serial === current }));
  }

  async pair(addr, code) {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      return await pairWithAnyCandidate(addr, code);
    } finally {
      this._busy = false;
    }
  }

  async connect(serial) {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      await this._teardown();

      this.hub.broadcastStatus({ state: "connecting", serial });

      // A device known only via mDNS isn't in `adb devices` yet — dial it
      // first so the forward/push below have a transport to use.
      if (isWirelessSerial(serial)) {
        const { adbBinary } = await resolveAdbBinary();
        try {
          await adb.connect(adbBinary, serial);
        } catch (_) {
          // Non-fatal: it may already be connected. A genuinely
          // unreachable device surfaces as a clear failure in start().
        }
      }

      const session = new ScrcpySession();
      try {
        await session.start(serial);
      } catch (e) {
        this.hub.broadcastStatus({ state: "error", serial, error: e.message });
        throw e;
      }

      this._session = session;
      this._wireSession(session);
      this.hub.broadcastStatus({ state: "streaming", serial: session.serial });
      this._saveLastDevice(session.serial);
      return { serial: session.serial, adbBinary: session.adbBinary };
    } finally {
      this._busy = false;
    }
  }

  async disconnect() {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      await this._teardown();
      this.hub.broadcastStatus({ state: "idle", serial: null });
    } finally {
      this._busy = false;
    }
  }

  async _teardown() {
    const old = this._session;
    // Clear the reference BEFORE awaiting stop(), so anything reading
    // currentSession during teardown sees null instead of a session whose
    // sockets are being destroyed underneath it.
    this._session = null;
    this.hub.resetVideoCache();
    if (old) {
      try {
        await old.stop();
      } catch (e) {
        console.warn("Error stopping previous session:", e.message);
      }
    }
  }

  _wireSession(session) {
    session.video.on("session", (info) => {
      console.log(`Resolution: ${info.width}x${info.height}`);
      this.hub.broadcastSessionInfo(info);
    });
    session.video.on("frame", (packet) => this.hub.broadcastVideoPacket(packet));
    session.video.on("error", (err) => console.error("Video stream error:", err.message));
    session.video.on("close", () => {
      if (this._session === session) {
        console.warn("Video socket closed — device disconnected?");
        this._session = null;
        this.hub.resetVideoCache();
        this.hub.broadcastStatus({ state: "idle", serial: null });
      }
    });
  }

  _saveLastDevice(serial) {
    try {
      fs.mkdirSync(config.vendorDir, { recursive: true });
      fs.writeFileSync(LAST_DEVICE_FILE, JSON.stringify({ serial }, null, 2));
    } catch (e) {
      console.warn("Could not persist last device:", e.message);
    }
  }

  readLastDevice() {
    try {
      return JSON.parse(fs.readFileSync(LAST_DEVICE_FILE, "utf8")).serial || null;
    } catch (_) {
      return null;
    }
  }

  // Reconnects to the last-used device if it's currently available.
  // Never throws — a failed auto-reconnect should leave the server idle
  // and reachable, not prevent it from starting.
  async autoReconnect() {
    const serial = this.readLastDevice();
    if (!serial) return null;
    try {
      const devices = await this.listDevices();
      const match = devices.find((d) => d.serial === serial && d.state === "device");
      if (!match) {
        console.log(`Last device (${serial}) not available — starting idle.`);
        return null;
      }
      console.log(`Auto-reconnecting to ${serial}...`);
      return await this.connect(serial);
    } catch (e) {
      console.warn("Auto-reconnect failed:", e.message);
      return null;
    }
  }
}

class BusyError extends Error {
  constructor() {
    super("A device operation is already in progress");
    this.code = "BUSY";
  }
}

module.exports = { DeviceManager, BusyError };
