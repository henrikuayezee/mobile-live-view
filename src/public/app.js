import { ScrcpyDecoder } from "./decoder.js";
import { attachPointerInput } from "./input.js";
import { mountTitlebar } from "./titlebar.js";
import { createStateOverlay } from "./state-overlay.js";
import {
  fetchDevices,
  deviceCardState,
  deviceChip,
  deviceDetailLine,
  deviceButton,
  connectDevice,
  disconnectDevice,
} from "./device-list.js";
import {
  PRESETS,
  fetchQualitySettings,
  saveQualitySettings,
  matchingPreset,
  summarySentence,
} from "./quality-settings.js";

const canvas = document.getElementById("screen");
const stage = document.getElementById("stage");
const decoder = new ScrcpyDecoder(canvas);
let activeSocket = null;
let lastResolution = null; // { width, height } — for the "connected" device row detail line

const titlebar = mountTitlebar();

// --- Toast ---------------------------------------------------------------
// The design's rule is "never while an overlay is up" — but `idle` always
// shows an overlay (the "No phone connected yet" card), so a hard connect
// failure's error message would otherwise have nowhere to surface at all.
// Deliberate, documented exception: a toast shows for a genuine connect
// error regardless of overlay state, since the alternative is the error
// being silently lost. Every other toast use follows the rule as written.
let toastTimer = null;
function showToast(title, body, { danger = false } = {}) {
  let el = document.getElementById("mlv-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "mlv-toast";
    el.innerHTML = `<p id="mlv-toast-title"></p><p id="mlv-toast-body"></p>`;
    stage.append(el);
  }
  el.className = danger ? "danger" : "";
  el.querySelector("#mlv-toast-title").textContent = title;
  el.querySelector("#mlv-toast-body").textContent = body;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5200);
}

// --- State overlay ---------------------------------------------------------

// Set while showing the client-manufactured "permission" overlay (reached
// via ?permission=<serial>, not any server-side state — see below).
let permissionOverride = null;
// Set when the user clicks Cancel on the "attaching" overlay. There is no
// real cancellation plumbing on the server (connect() is one uninterruptible
// sequence of adb calls), so this is client-side only: remember which
// attempt was cancelled and silently discard its eventual status broadcast
// instead of re-showing an overlay for it.
let cancelledSerial = null;

const overlay = createStateOverlay((action) => {
  switch (action) {
    case "openSetup":
    case "chooseAnother":
      location.href = "settings.html";
      break;
    case "cancel":
      cancelledSerial = lastAppliedStatus.serial;
      applyStatus({ state: "idle", serial: null, model: null, connectionType: null, error: null });
      break;
    case "reconnect":
      connectDevice(lastAppliedStatus.serial, { reconnect: true }).catch((e) =>
        showToast("Couldn't reconnect", e.message, { danger: true })
      );
      break;
    case "useCable":
      location.href = "settings.html?open=usb";
      break;
  }
});
stage.append(overlay.element);

let lastAppliedStatus = { state: "idle" };

function applyStatus(status) {
  if (permissionOverride) {
    if (status.serial === permissionOverride.serial && status.state !== "idle") {
      // Something real finally happened for this exact device (e.g. it
      // got authorized and a connect actually started) — let it through.
      permissionOverride = null;
    } else {
      return; // keep showing the manufactured permission overlay
    }
  }
  if (cancelledSerial && status.serial === cancelledSerial && status.state !== "idle") {
    return; // discard the stale attempt's eventual broadcast
  }
  if (status.state === "idle" || status.serial !== cancelledSerial) {
    cancelledSerial = null;
  }

  lastAppliedStatus = status;
  titlebar.applyStatus(status);
  overlay.render(status);

  if (status.state !== "streaming") decoder.reset();

  if (status.error) {
    showToast("Couldn't connect", status.error, { danger: true });
  }
}

// --- Permission deep link ---------------------------------------------------
// device-list.js's "Show me how" action (for an unauthorized device) sends
// the user here instead of attempting a connect, since that would just
// hang. No server-side state exists for this — see applyStatus's guard
// above for how it survives the WS's real status push that follows.
(function checkPermissionDeepLink() {
  const params = new URLSearchParams(location.search);
  const serial = params.get("permission");
  if (!serial) return;
  permissionOverride = { serial, model: params.get("model") };
  applyStatus({
    state: "permission",
    serial,
    model: permissionOverride.model,
    connectionType: null,
    error: null,
  });
})();

// --- Video ------------------------------------------------------------------

const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;

function parseVideoMessage(buf) {
  const view = new DataView(buf);
  const flags = view.getUint8(0);
  const pts = view.getBigUint64(1, false);
  return {
    config: (flags & FLAG_CONFIG) !== 0,
    keyFrame: (flags & FLAG_KEYFRAME) !== 0,
    pts: Number(pts),
    payload: new Uint8Array(buf, 9),
  };
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    activeSocket = ws;
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.type === "session") {
        lastResolution = { width: msg.width, height: msg.height };
        titlebar.applySession(lastResolution);
      } else if (msg.type === "status") {
        applyStatus(msg);
      }
      return;
    }
    decoder.handlePacket(parseVideoMessage(event.data));
  };

  ws.onclose = () => {
    if (activeSocket === ws) activeSocket = null;
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}
connect();

function sendInput(msg) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(msg));
  }
}
attachPointerInput(canvas, sendInput);

// android/keycodes.h — mirrors src/server/scrcpy/constants.js KEYCODE.
const KEYCODE = { BACK: 4, HOME: 3, APP_SWITCH: 187 };
document.getElementById("nav-back").onclick = () => sendInput({ type: "key", keycode: KEYCODE.BACK });
document.getElementById("nav-home").onclick = () => sendInput({ type: "key", keycode: KEYCODE.HOME });
document.getElementById("nav-recents").onclick = () => sendInput({ type: "key", keycode: KEYCODE.APP_SWITCH });

// --- Fullscreen ---------------------------------------------------------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen().catch((e) => console.warn("Fullscreen refused:", e.message));
}
document.getElementById("fullscreen").onclick = toggleFullscreen;

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "f" || e.key === "F") toggleFullscreen();
});

// --- Rail collapse ---------------------------------------------------------
// Separate from fullscreen (which already hides the titlebar but not the
// rail) — a manual way to reclaim the rail's width without leaving the
// window. Same "thin clickable strip" pattern as the titlebar's collapse.

const RAIL_COLLAPSE_KEY = "mlv-rail-collapsed";
const rail = document.getElementById("mlv-rail");
const railCollapseBtn = document.getElementById("rail-collapse");

function setRailCollapsed(collapsed) {
  rail.classList.toggle("collapsed", collapsed);
  railCollapseBtn.title = collapsed ? "Show sidebar" : "Hide sidebar";
  railCollapseBtn.innerHTML = collapsed ? "&#9666;" : "&#9656;";
  if (collapsed) closePanel(); // its toggle buttons live inside the rail
  try {
    localStorage.setItem(RAIL_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch (_) {
    // Private browsing / storage blocked — collapse still works, just
    // doesn't persist across reloads.
  }
}

railCollapseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setRailCollapsed(!rail.classList.contains("collapsed"));
});
rail.addEventListener("click", () => {
  if (rail.classList.contains("collapsed")) setRailCollapsed(false);
});

try {
  if (localStorage.getItem(RAIL_COLLAPSE_KEY) === "1") setRailCollapsed(true);
} catch (_) {
  // Default to expanded.
}

// --- Slide-out panel (variant B: Phones / Picture & Speed) ------------------

const panel = document.getElementById("mlv-panel");
const panelTitle = document.getElementById("mlv-panel-title");
const panelBody = document.getElementById("mlv-panel-body");
const toggleDevicesBtn = document.getElementById("toggle-devices");
const toggleQualityBtn = document.getElementById("toggle-quality");
let panelTab = null; // "devices" | "quality" | null

function closePanel() {
  panelTab = null;
  panel.hidden = true;
  toggleDevicesBtn.classList.remove("active");
  toggleQualityBtn.classList.remove("active");
}

async function openPanel(tab) {
  if (panelTab === tab) return closePanel(); // clicking an open tab closes it
  panelTab = tab;
  panel.hidden = false;
  toggleDevicesBtn.classList.toggle("active", tab === "devices");
  toggleQualityBtn.classList.toggle("active", tab === "quality");
  panelTitle.textContent = tab === "devices" ? "Phones" : "Picture & Speed";
  panelBody.innerHTML = "";
  if (tab === "devices") await renderDevicesTab();
  else await renderQualityTab();
}

async function renderDevicesTab() {
  try {
    const devices = await fetchDevices();
    // Cleared here, not just once by openPanel(): this function is also
    // called again after a connect/disconnect action completes, and
    // without this each call would append another copy on top of the last.
    panelBody.innerHTML = "";
    if (!devices.length) {
      panelBody.innerHTML = '<p class="device-list-empty">No phones yet.</p>';
    } else {
      for (const device of devices) {
        panelBody.append(buildDeviceRow(device));
      }
    }
    const link = document.createElement("a");
    link.className = "mlv-panel-link";
    link.href = "settings.html";
    link.textContent = "Add a phone →";
    panelBody.append(link);
  } catch (e) {
    panelBody.innerHTML = `<p class="device-list-empty">${e.message}</p>`;
  }
}

function buildDeviceRow(device) {
  const row = document.createElement("div");
  row.className = `device-row state-${deviceCardState(device)}`;

  const dot = document.createElement("span");
  dot.className = "device-row-dot";

  const main = document.createElement("div");
  main.className = "device-row-main";
  const name = document.createElement("div");
  name.className = "device-row-name";
  name.textContent = device.model || device.discoveredName || device.serial;
  const sub = document.createElement("div");
  sub.className = "device-row-sub";
  sub.textContent = deviceDetailLine(device, device.isCurrent ? lastResolution : null);
  main.append(name, sub);

  const btn = document.createElement("button");
  const spec = deviceButton(device);
  btn.className = `mlv-btn ${spec.kind}`;
  btn.textContent = spec.label;
  btn.disabled = spec.disabled;
  btn.type = "button";
  btn.onclick = () => handleDeviceAction(device, spec.action, btn);

  row.append(dot, main, btn);
  return row;
}

async function handleDeviceAction(device, action, btn) {
  if (action === "showPermission") {
    location.href = `index.html?permission=${encodeURIComponent(device.serial)}&model=${encodeURIComponent(device.model || "")}`;
    return;
  }
  btn.disabled = true;
  try {
    if (action === "connect") await connectDevice(device.serial);
    else if (action === "disconnect") await disconnectDevice();
    await renderDevicesTab();
  } catch (e) {
    showToast("Action failed", e.message, { danger: true });
    btn.disabled = false;
  }
}

async function renderQualityTab() {
  try {
    const current = await fetchQualitySettings();
    const active = matchingPreset(current);

    // Same reason as renderDevicesTab(): this runs again after saving a
    // preset, and without clearing first each click stacks another copy
    // of the grid/summary/link on top of the previous one.
    panelBody.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "mlv-preset-grid";
    for (const [key, preset] of Object.entries(PRESETS)) {
      if (key === "custom") continue; // no sliders in the compact panel tab
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "mlv-preset-tile" + (key === active ? " selected" : "");
      tile.innerHTML = `<span class="radio"></span><span class="label">${preset.label}</span><span class="hint">${preset.hint}</span>`;
      tile.onclick = async () => {
        try {
          await saveQualitySettings(preset);
          await renderQualityTab();
        } catch (e) {
          showToast("Couldn't save", e.message, { danger: true });
        }
      };
      grid.append(tile);
    }
    panelBody.append(grid);

    const summary = document.createElement("div");
    summary.className = "mlv-panel-summary";
    summary.textContent = summarySentence(current);
    panelBody.append(summary);

    const link = document.createElement("a");
    link.className = "mlv-panel-link";
    link.href = "settings.html";
    link.textContent = "Fine-tune in setup →";
    panelBody.append(link);
  } catch (e) {
    panelBody.innerHTML = `<p class="device-list-empty">${e.message}</p>`;
  }
}

toggleDevicesBtn.onclick = () => openPanel("devices");
toggleQualityBtn.onclick = () => openPanel("quality");
document.getElementById("mlv-panel-close").onclick = closePanel;

// --- Compact view -----------------------------------------------------------
// Collapses the title bar + rail to their thin strips and, inside the
// packaged Electron app, also shrinks the real OS window to exactly the
// phone's own pixel size — see electron/main.js's mlv:enter-compact/
// exit-compact. CSS alone only gets half of "no black gutter around the
// phone": the window itself has to actually get smaller too, which only
// the app (not a browser tab) can do to itself. In a plain browser tab
// this still collapses the chrome, it just can't resize the tab.

let compactMode = false;
const compactBtn = document.getElementById("compact-view");

function setCompactMode(on) {
  if (on === compactMode) return;
  if (on && !lastResolution) {
    showToast("Nothing to snap to", "Connect a phone first — there's no picture yet to size the window around.");
    return;
  }
  compactMode = on;
  compactBtn.classList.toggle("active", on);
  titlebar.setCollapsed(on);
  setRailCollapsed(on);
  if (on) window.mlvWindow?.enterCompact(lastResolution.width, lastResolution.height);
  else window.mlvWindow?.exitCompact();
}

compactBtn.addEventListener("click", (e) => {
  // Without this, the click bubbles up to rail's own "expand if
  // collapsed" listener below — which just collapsed the rail as a side
  // effect of turning compact mode ON, and would immediately re-expand
  // it again on the very same click.
  e.stopPropagation();
  setCompactMode(!compactMode);
});

// Manually reopening either strip while compact should also restore the
// window, not just the chrome — otherwise the rail/title bar pop back to
// full size inside a window that's still shrunk to fit only the phone,
// squeezing everything. Both listeners fire after the existing
// "collapsed strip click expands it" listeners above/in titlebar.js
// (same element, registered earlier), so by the time these run, the
// collapse state already reflects the just-completed expand.
rail.addEventListener("click", () => {
  if (compactMode && !rail.classList.contains("collapsed")) setCompactMode(false);
});
titlebar.element.addEventListener("click", () => {
  if (compactMode && !titlebar.isCollapsed()) setCompactMode(false);
});
