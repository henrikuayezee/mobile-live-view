"use strict";

// Logic-only module for device data: fetching, state→chip derivation, and
// connect/disconnect actions. NOT a DOM component — the full settings-page
// card and the compact panel row render genuinely different markup (per
// the design handoff), so each call site builds its own DOM from this.
import { api, postJson } from "./api-client.js";

export function fetchDevices() {
  return api("/api/devices").then((r) => r.devices);
}

export function fetchDeviceListing() {
  return api("/api/devices");
}

// Only Wi-Fi phones: a cabled phone reappears the moment it's listed again.
export function canForget(device) {
  return device.connectionType === "wireless";
}

export function forgetDevice(serial) {
  return postJson("/api/devices/forget", { serial });
}

export function restoreForgottenDevices() {
  return postJson("/api/devices/forgotten/clear", {});
}

// Maps locate-adb.js's raw adb states (device/unauthorized/offline/
// available) plus isCurrent to the design's 4 card states, per the
// mapping given in the handoff: device+isCurrent → connected,
// unauthorized → permission, offline → offline, else → available.
export function deviceCardState(device) {
  if (device.isCurrent) return "connected";
  if (device.state === "unauthorized") return "permission";
  if (device.state === "offline") return "offline";
  return "available";
}

const CHIP = {
  connected: { label: "Connected", bg: "rgba(108,203,95,.18)", fg: "#8fdc85" },
  available: { label: "Available", bg: "rgba(255,255,255,.08)", fg: "rgba(255,255,255,.7)" },
  permission: { label: "Needs permission", bg: "rgba(252,225,0,.16)", fg: "#f2d75a" },
  offline: { label: "Not reachable", bg: "rgba(255,255,255,.08)", fg: "rgba(255,255,255,.55)" },
};

export function deviceChip(device) {
  return CHIP[deviceCardState(device)];
}

const TRANSPORT_LABEL = { usb: "USB", wireless: "Wi-Fi" };

// `liveResolution` is the currently-streaming device's real resolution
// (from GET /api/status) — a not-yet-connected device's resolution is
// genuinely unknown (adb device listing / mDNS don't report it), so it's
// only ever shown for the one device actually streaming right now, not
// fabricated for the others.
export function deviceDetailLine(device, liveResolution) {
  const transport = TRANSPORT_LABEL[device.connectionType] || device.connectionType;
  switch (deviceCardState(device)) {
    case "connected": {
      const res = liveResolution ? ` · ${liveResolution.width} × ${liveResolution.height}` : "";
      return `Showing in the live view${res}`;
    }
    case "available":
      return `Ready to connect over ${transport}`;
    case "permission":
      return "Pick up the phone and tap Allow on the prompt waiting there.";
    case "offline":
      return "Last seen over Wi-Fi. Wireless debugging is probably off — wake the phone and switch it back on.";
    default:
      return "";
  }
}

// The action a click on this card's button should take. `permission`
// deliberately has no connect action at all — per the design, clicking it
// navigates straight to the Live view's permission overlay instead of
// calling POST /api/devices/connect, since attempting a connect on an
// unauthorized device would just hang.
export function deviceButton(device) {
  switch (deviceCardState(device)) {
    case "connected":
      return { label: "Disconnect", kind: "secondary", action: "disconnect", disabled: false };
    case "available":
      return { label: "Connect", kind: "primary", action: "connect", disabled: false };
    case "permission":
      return { label: "Show me how", kind: "primary", action: "showPermission", disabled: false };
    case "offline":
      return { label: "Connect", kind: "primary", action: "connect", disabled: true };
    default:
      return { label: "Connect", kind: "primary", action: "connect", disabled: true };
  }
}

export function connectDevice(serial, { reconnect = false } = {}) {
  return postJson("/api/devices/connect", { serial, reconnect });
}

export function disconnectDevice() {
  return postJson("/api/devices/disconnect", {});
}
