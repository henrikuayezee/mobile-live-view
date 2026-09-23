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
const forgotten = require("./forgotten-devices");
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
    const hidden = forgotten.load();
    const visible = devices
      .filter((d) => !forgotten.isForgotten(d, hidden))
      .map((d) => ({ ...d, isCurrent: d.serial === current, aliases: [] }));
    return mergeSamePhone(visible);
  }

  async pair(addr, code) {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      const result = await pairWithAnyCandidate(addr, code);
      forgotten.unforgetAddress(addr);
      return result;
    } finally {
      this._busy = false;
    }
  }

  // Hides a wireless phone from the list, drops its adb connection, and
  // stops auto-reconnecting to it. The pairing itself lives on the phone
  // and can only be revoked there.
  async forget(serial) {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      const { adbBinary } = await resolveAdbBinary();
      const all = await listDevices(adbBinary);
      const target = all.find((d) => d.serial === serial);
      if (!target) throw new Error(`Device ${serial} not found`);
      if (target.connectionType !== "wireless") {
        throw new Error("A phone on a cable can't be removed — unplug it instead.");
      }

      const entries = forgotten.forget(target, all);

      if (entries.some((d) => d.serial === this.currentSerial)) {
        await this._teardown();
        this.hub.broadcastStatus({ state: "idle", serial: null });
      }
      for (const d of entries) {
        if (d.state !== "available") await adb.disconnect(adbBinary, d.serial);
      }

      const last = this.readLastDevice();
      const lastType = last && isWirelessSerial(last) ? "wireless" : "usb";
      if (last && forgotten.isForgotten({ serial: last, connectionType: lastType })) {
        fs.rmSync(LAST_DEVICE_FILE, { force: true });
      }
      return { removed: entries.map((d) => d.serial) };
    } finally {
      this._busy = false;
    }
  }

  // `reconnect: true` is purely which status string the first broadcast
  // uses ("reconnecting" vs "attaching") — the design specifies distinct
  // copy/steps for each, but the actual adb/session work underneath is
  // identical either way, so this stays one method rather than a
  // duplicate.
  async connect(serial, { reconnect = false } = {}) {
    if (this._busy) throw new BusyError();
    this._busy = true;
    try {
      // Resolved up front so even the very first broadcast (attaching /
      // reconnecting) can show "{model}" — the design names the device
      // from the start, not just once streaming begins.
      const model = await this._resolveModel(serial);
      // The titlebar's "{resolution} · USB/Wi-Fi" text needs this too —
      // reuses the same classification locate-adb.js already does for
      // device listing, rather than re-deriving it from the serial format
      // a second time in the browser.
      const connectionType = isWirelessSerial(serial) ? "wireless" : "usb";

      await this._teardown();

      this.hub.broadcastStatus({
        state: reconnect ? "reconnecting" : "attaching",
        serial,
        model,
        connectionType,
      });

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
        // No state in the design's 7-state model fits a generic connect
        // failure (their copy for e.g. "lost" is specifically about
        // Android's own wireless-debugging timeout). Drop back to idle
        // and let the client surface the message as a toast instead.
        this.hub.broadcastStatus({ state: "idle", serial: null, error: e.message });
        throw e;
      }

      this._session = session;
      this._wireSession(session, model, connectionType);
      // Sockets are up but no picture exists yet — that's "starting", not
      // "streaming". The real streaming broadcast happens once the video
      // parser actually reports dimensions, in _wireSession below.
      this.hub.broadcastStatus({ state: "starting", serial: session.serial, model, connectionType });
      this._saveLastDevice(session.serial);
      return { serial: session.serial, adbBinary: session.adbBinary };
    } finally {
      this._busy = false;
    }
  }

  // Observed empty in practice specifically when reconnecting right after
  // a drop — adb's own device-state settling (offline -> device) can still
  // be mid-transition at the exact moment this queries it, so `adb devices
  // -l`'s line for this serial can momentarily lack a model property. One
  // short retry clears it in the cases actually seen; a genuinely unknown
  // model (e.g. a serial that legitimately isn't listed) still degrades
  // to the titlebar's plain "Device" fallback rather than retrying forever.
  async _resolveModel(serial, { retried = false } = {}) {
    try {
      const devices = await this.listDevices();
      const match = devices.find((d) => matchesSerial(d, serial));
      if ((!match || !match.model) && !retried) {
        await new Promise((r) => setTimeout(r, 400));
        return this._resolveModel(serial, { retried: true });
      }
      return match ? match.model : null;
    } catch (_) {
      return null;
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

  _wireSession(session, model, connectionType) {
    session.video.on("session", (info) => {
      console.log(`Resolution: ${info.width}x${info.height}`);
      this.hub.broadcastSessionInfo(info);
      // Real dimensions existing is the actual definition of "a picture
      // exists" — this is the true streaming moment, not session.start()
      // resolving. Guarded the same way "close" below already is: a fast
      // device switch can leave a stale "session" event in flight from a
      // session that is no longer current, which would otherwise falsely
      // announce streaming for a device that's already been replaced.
      if (this._session === session) {
        this.hub.broadcastStatus({ state: "streaming", serial: session.serial, model, connectionType });
      }
    });
    session.video.on("frame", (packet) => this.hub.broadcastVideoPacket(packet));
    session.video.on("error", (err) => console.error("Video stream error:", err.message));
    session.video.on("close", () => {
      if (this._session === session) {
        console.warn("Video socket closed — device disconnected?");
        this._session = null;
        this.hub.resetVideoCache();
        this.hub.broadcastStatus({ state: "lost", serial: session.serial, model, connectionType });
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
      const match = devices.find((d) => matchesSerial(d, serial) && d.state === "device");
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

// One card per phone: adb can hold an ip:port and an mDNS-name connection
// to the same Wi-Fi phone at once. The streaming or ready transport wins;
// the rest are kept as `aliases` so lookups by either serial still match.
function mergeSamePhone(devices) {
  const rank = (d) => (d.isCurrent ? 0 : d.state === "device" ? 1 : 2);
  const primaries = new Map();
  const out = [];
  for (const d of [...devices].sort((a, b) => rank(a) - rank(b))) {
    const key = d.connectionType === "wireless" && d.hwSerial;
    const primary = key && primaries.get(key);
    if (!primary) {
      if (key) primaries.set(key, d);
      out.push(d);
      continue;
    }
    primary.aliases.push(d.serial);
    primary.address = primary.address || d.address;
    primary.model = primary.model || d.model;
  }
  return devices.filter((d) => out.includes(d));
}

function matchesSerial(device, serial) {
  return device.serial === serial || device.aliases.includes(serial);
}

class BusyError extends Error {
  constructor() {
    super("A device operation is already in progress");
    this.code = "BUSY";
  }
}

module.exports = { DeviceManager, BusyError };
