"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { hwSerialFromName } = require("./adb/locate-adb");

// adb has no host-side "unpair", and a paired phone keeps advertising itself
// over mDNS, so forgetting is a persisted hide-list rather than a delete.
// Entries key on the phone's hardware serial (parsed from its mDNS name) and
// its IP — never ip:port, since Android picks a new port every session.
const FILE = path.join(config.vendorDir, "forgotten-devices.json");

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(config.vendorDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function hostOf(addr) {
  const m = /^([\d.]+):\d+$/.exec(addr || "");
  return m ? m[1] : null;
}

function identity(device) {
  return {
    hw: device.hwSerial || hwSerialFromName(device.discoveredName || device.serial),
    ip: hostOf(device.address) || hostOf(device.serial),
  };
}

function samePhone(a, b) {
  return Boolean((a.hw && a.hw === b.hw) || (a.ip && a.ip === b.ip));
}

// USB phones are never hidden: they're present whenever plugged in, so
// hiding one would just make a connected cable look broken.
function isForgotten(device, list = load()) {
  if (device.connectionType !== "wireless") return false;
  const id = identity(device);
  return list.some((entry) => samePhone(entry, id));
}

// A phone can be listed twice (once by ip:port, once by mDNS name), so this
// collects every wireless entry for the same phone and stores them as one
// record. Returns those entries.
function forget(target, devices) {
  const targetId = identity(target);
  const siblings = devices.filter(
    (d) => d.connectionType === "wireless" && samePhone(identity(d), targetId)
  );
  const ids = siblings.map(identity);
  const entry = {
    hw: (ids.find((id) => id.hw) || {}).hw || null,
    ip: (ids.find((id) => id.ip) || {}).ip || null,
  };
  save([...load().filter((e) => !samePhone(e, entry)), entry]);
  return siblings;
}

// Pairing a phone again is the natural way to bring it back.
function unforgetAddress(addr) {
  const ip = hostOf(addr);
  if (!ip) return;
  const list = load();
  const kept = list.filter((e) => e.ip !== ip);
  if (kept.length !== list.length) save(kept);
}

function count() {
  return load().length;
}

function clear() {
  save([]);
}

module.exports = { load, isForgotten, forget, unforgetAddress, count, clear };
