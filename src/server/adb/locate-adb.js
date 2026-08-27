"use strict";

const fs = require("fs");
const adb = require("./adb");
const config = require("../config");

function candidatePaths() {
  const candidates = [];
  if (config.adbPath) candidates.push(config.adbPath);
  candidates.push("adb"); // relies on PATH
  if (config.adbFallbackPath) candidates.push(config.adbFallbackPath);
  return candidates;
}

// Finds an adb binary that actually RUNS — deliberately does not require
// any device to be present, since we need a working binary to list
// devices, pair a new phone, or show an empty Settings screen when
// nothing is plugged in.
//
// Preference order still favours a binary that can currently see a
// device: on this dev machine only AirDroid Cast's bundled adb can see
// the USB-attached phone (Windows USB driver binding), while the newer
// platform-tools adb is the one that supports wireless pairing. Probing
// for "sees devices" first, then falling back to "merely runs", picks
// the more useful binary without hardcoding either.
//
// Deliberately never calls `adb kill-server` — that would tear down
// whichever server currently holds the working USB binding.
async function resolveAdbBinary() {
  const attempts = [];
  let firstRunnable = null;

  for (const candidate of candidatePaths()) {
    if (candidate !== "adb" && !fs.existsSync(candidate)) {
      attempts.push({ candidate, reason: "path does not exist" });
      continue;
    }

    if (config.wirelessAdbAddr) {
      // Idempotent; re-establishes a dropped wireless link (phone slept,
      // Wi-Fi roamed) before we probe for devices.
      try {
        await adb.connect(candidate, config.wirelessAdbAddr);
      } catch (_) {
        // Non-fatal — the device probe below reports the real story.
      }
    }

    let list;
    try {
      list = await adb.devices(candidate);
    } catch (e) {
      attempts.push({ candidate, reason: e.message });
      continue;
    }

    if (!firstRunnable) firstRunnable = { candidate, list };
    // Any visible device (including "unauthorized"/"offline") proves this
    // binary can see the transport — the right signal for picking a
    // binary. Filtering to "device" here would skip a candidate whose
    // phone is merely waiting on the USB-debugging prompt, and the UI
    // wants to surface those states rather than hide them.
    if (list.length > 0) {
      return { adbBinary: candidate, devices: list, attempts };
    }
    attempts.push({ candidate, reason: "runs, but sees no devices" });
  }

  // No candidate saw anything — still return one that executes, so
  // listing can report "no devices" and pairing has a binary to use.
  if (firstRunnable) {
    return { adbBinary: firstRunnable.candidate, devices: firstRunnable.list, attempts };
  }

  const detail = attempts.map((a) => `  - ${a.candidate}: ${a.reason}`).join("\n");
  throw new Error(
    `Could not find a working adb binary.\n${detail}\n` +
      `Set ADB_PATH or ADB_FALLBACK_PATH in .env as needed.`
  );
}

function parseDeviceProps(raw) {
  const props = {};
  for (const m of raw.matchAll(/(\w+):(\S+)/g)) props[m[1]] = m[2];
  return props;
}

// A wireless serial is either an mDNS service name
// ("adb-R5CT21KPWMZ-7PM6f1._adb-tls-connect._tcp") or a plain host:port.
function isWirelessSerial(serial) {
  return serial.includes("_adb-tls") || /^[\d.]+:\d+$/.test(serial);
}

// Merges the two things adb can tell us about available phones:
//   1. `adb devices -l`   — currently connected/authorized devices
//   2. `adb mdns services` — wireless devices discoverable on the network,
//                            INCLUDING ones not currently connected
// Without (2), a paired-but-idle phone is invisible and unselectable.
async function listDevices(adbBinary) {
  const binary = adbBinary || (await resolveAdbBinary()).adbBinary;

  // Deliberately keeps every state, not just "device" — the Settings UI
  // should show "unauthorized" (check the prompt on your phone) and
  // "offline" entries rather than pretending those phones don't exist.
  const connected = await adb.devices(binary);
  const byKey = new Map();

  for (const d of connected) {
    const props = parseDeviceProps(d.raw);
    byKey.set(d.serial, {
      serial: d.serial,
      state: d.state,
      model: (props.model || "").replace(/_/g, " ") || null,
      connectionType: isWirelessSerial(d.serial) ? "wireless" : "usb",
      address: null,
      connected: d.state === "device",
    });
  }

  let services = [];
  try {
    services = await adb.mdnsServices(binary);
  } catch (_) {
    // mDNS discovery is best-effort; a failure just means we show fewer
    // options, not that listing should fail outright.
  }

  for (const svc of services) {
    if (svc.isPairing) continue; // pairing-mode ads aren't connectable targets
    // The mDNS name is the serial's prefix — match it to a connected
    // entry so we annotate rather than duplicate the same phone.
    const existing = [...byKey.values()].find((d) => d.serial.startsWith(svc.name));
    if (existing) {
      existing.address = svc.address;
      continue;
    }
    byKey.set(svc.name, {
      serial: svc.address, // connect by address for not-yet-connected devices
      state: "available",
      model: null,
      connectionType: "wireless",
      address: svc.address,
      connected: false,
      discoveredName: svc.name,
    });
  }

  return [...byKey.values()];
}

// Picks exactly one device — the original single-device behaviour, kept
// for CLI callers (scripts/check-adb.js) and auto-reconnect.
async function resolveAdb(explicitSerial) {
  // Reuses the device list resolveAdbBinary() already fetched rather than
  // shelling out again — avoids a TOCTOU gap where the device set changes
  // between the two calls.
  const { adbBinary, devices, attempts } = await resolveAdbBinary();
  const wanted = explicitSerial || config.deviceSerial;

  const ready = devices.filter((d) => d.state === "device");

  if (wanted) {
    const match = ready.find((d) => d.serial === wanted);
    if (!match) throw new Error(`Device ${wanted} not found or not ready.`);
    return { adbBinary, serial: match.serial, attempts };
  }

  if (ready.length === 0) throw new Error("No devices in 'device' state.");
  if (ready.length > 1) {
    throw new Error(
      `${ready.length} devices attached — set DEVICE_SERIAL or pick one in Settings.`
    );
  }
  return { adbBinary, serial: ready[0].serial, attempts };
}

// Pairing is the one operation you run precisely when NO device is
// visible yet, so resolveAdbBinary()'s "prefers a binary that sees a
// device" heuristic is the wrong signal here. Instead try every candidate
// and keep the first whose `adb pair` actually succeeds — note that older
// adb builds (e.g. AirDroid Cast's bundled 1.0.40) predate `pair`
// entirely and fail with "unknown command".
async function pairWithAnyCandidate(addr, code) {
  let lastErr;
  for (const candidate of candidatePaths()) {
    if (candidate !== "adb" && !fs.existsSync(candidate)) continue;
    try {
      const output = await adb.pair(candidate, addr, code);
      return { adbBinary: candidate, output };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Pairing failed on all adb candidates. Last error: ${lastErr && lastErr.message}`);
}

module.exports = {
  resolveAdb,
  resolveAdbBinary,
  listDevices,
  isWirelessSerial,
  pairWithAnyCandidate,
};
