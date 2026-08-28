"use strict";

import { api, postJson } from "./api-client.js";
import { mountTitlebar } from "./titlebar.js";
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

const titlebar = mountTitlebar();

// --- Titlebar status feed ---------------------------------------------------
// This page never shows video, so ?video=0 keeps the full H.264 bitstream
// from being sent here at all (see hub.js) — only status/session JSON,
// which is all the titlebar chip needs.
(function connectStatusSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?video=0`);
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return; // shouldn't happen with video=0, but be safe
    const msg = JSON.parse(event.data);
    if (msg.type === "status") titlebar.applyStatus(msg);
    else if (msg.type === "session") titlebar.applySession(msg);
  };
  ws.onclose = () => setTimeout(connectStatusSocket, 1500);
})();

// --- Your phones -------------------------------------------------------------

const listEl = document.getElementById("device-list");
const refreshBtn = document.getElementById("refresh");
let lastKnownResolution = null;

async function refreshDevices() {
  const originalLabel = refreshBtn.textContent;
  refreshBtn.textContent = "Looking…";
  refreshBtn.disabled = true;
  try {
    const [devices, status] = await Promise.all([fetchDevices(), api("/api/status")]);
    lastKnownResolution = status.resolution;
    renderDeviceList(devices);
  } catch (e) {
    listEl.innerHTML = `<li class="device-list-empty-full">${e.message}</li>`;
  } finally {
    setTimeout(() => {
      refreshBtn.textContent = originalLabel;
      refreshBtn.disabled = false;
    }, 1100); // matches the design's "Looking…" minimum duration
  }
}

function renderDeviceList(devices) {
  listEl.innerHTML = "";
  if (!devices.length) {
    listEl.innerHTML =
      '<li class="device-list-empty-full">No phones yet. Add one below.</li>';
    return;
  }
  for (const device of devices) listEl.append(buildDeviceCard(device));
}

function buildDeviceCard(device) {
  const state = deviceCardState(device);
  const li = document.createElement("li");
  li.className = `device-card state-${state}`;

  const glyph = document.createElement("div");
  glyph.className = "device-phone-glyph";
  glyph.style.color = state === "connected" ? "rgba(143,220,133,.75)" : "rgba(255,255,255,.3)";

  const main = document.createElement("div");
  main.className = "device-card-main";

  const heading = document.createElement("div");
  heading.className = "device-card-heading";
  const name = document.createElement("span");
  name.className = "device-card-name";
  name.textContent = device.model || device.discoveredName || device.serial;
  const transportChip = document.createElement("span");
  transportChip.className = "mlv-transport-chip";
  transportChip.textContent = device.connectionType === "usb" ? "USB" : "Wi-Fi";
  const chip = deviceChip(device);
  const stateChip = document.createElement("span");
  stateChip.className = "mlv-state-chip";
  stateChip.style.background = chip.bg;
  stateChip.style.color = chip.fg;
  stateChip.textContent = chip.label;
  heading.append(name, transportChip, stateChip);

  const detail = document.createElement("div");
  detail.className = "device-card-detail";
  detail.textContent = deviceDetailLine(device, device.isCurrent ? lastKnownResolution : null);

  main.append(heading, detail);

  const btn = document.createElement("button");
  const spec = deviceButton(device);
  btn.className = `mlv-btn ${spec.kind}`;
  btn.textContent = spec.label;
  btn.disabled = spec.disabled;
  btn.type = "button";
  btn.onclick = () => handleDeviceAction(device, spec.action, btn);

  li.append(glyph, main, btn);
  return li;
}

async function handleDeviceAction(device, action, btn) {
  if (action === "showPermission") {
    location.href = `index.html?permission=${encodeURIComponent(device.serial)}&model=${encodeURIComponent(device.model || "")}`;
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Working…";
  try {
    if (action === "connect") await connectDevice(device.serial);
    else if (action === "disconnect") await disconnectDevice();
    await refreshDevices();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert(e.message); // deliberately blunt — a full toast system on this page is out of scope
  }
}

refreshBtn.onclick = refreshDevices;
refreshDevices();

// --- Add a phone: expander cards ---------------------------------------------

const expanders = [...document.querySelectorAll(".expander")];

function openExpander(method) {
  for (const el of expanders) el.classList.toggle("open", el.dataset.method === method);
}

for (const el of expanders) {
  el.querySelector(".expander-header").addEventListener("click", () => {
    openExpander(el.classList.contains("open") ? null : el.dataset.method);
  });
}

// Opened by index.html's "lost" overlay ("Use a cable instead" button), or
// defaults to QR (least friction) per the design.
const requestedOpen = new URLSearchParams(location.search).get("open");
openExpander(requestedOpen === "usb" ? "usb" : "qr");

// --- QR pairing ----------------------------------------------------------
// "failed" is part of the design's state table and rendered here for
// visual completeness, but the current backend (qr-pairing.js) only ever
// distinguishes waiting/paired/timeout — it has no way yet to tell "still
// looking" apart from "found the phone but the handshake was rejected".
// So this UI can reach waiting/paired/expired for real; failed is wired
// but not currently reachable. Worth building real detection later.

const qrIdle = document.getElementById("qr-idle");
const qrActive = document.getElementById("qr-active");
const qrPlate = document.getElementById("qr-plate");
const qrImg = document.getElementById("qr-img");
const qrCover = document.getElementById("qr-cover");
const qrSpinner = document.getElementById("qr-spinner");
const qrTitle = document.getElementById("qr-title");
const qrBody = document.getElementById("qr-body");
const qrButtons = document.getElementById("qr-buttons");
let qrPollTimer = null;

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stopQrPolling() {
  if (qrPollTimer) clearInterval(qrPollTimer);
  qrPollTimer = null;
}

function renderQrState(s) {
  const state = s.state === "timeout" ? "expired" : s.state; // see comment above
  qrCover.hidden = state === "waiting";
  qrSpinner.hidden = state !== "waiting";
  qrButtons.innerHTML = "";

  function addButton(label, kind, onClick) {
    const b = document.createElement("button");
    b.className = `mlv-btn ${kind}`;
    b.textContent = label;
    b.type = "button";
    b.onclick = onClick;
    qrButtons.append(b);
  }

  if (state === "waiting") {
    qrTitle.textContent = "Waiting for the phone to scan";
    qrTitle.style.color = "#fff";
    qrBody.textContent = `Point the phone's camera at the code. This can take a couple of minutes if you are walking over to it — the code stays valid for that long. Waiting ${formatCountdown(s.expiresInMs)}.`;
    addButton("Cancel", "secondary", cancelQr);
  } else if (state === "paired") {
    qrCover.textContent = "Paired ✓";
    qrTitle.textContent = `Paired with ${s.pairedAddress || "the phone"}`;
    qrTitle.style.color = "var(--success-text)";
    qrBody.textContent =
      "The phone is now known to this computer. It can take a few seconds to show up in the list above — press Refresh if it is not there yet.";
    addButton("Show me the list", "primary", async () => {
      resetQr();
      await refreshDevices();
      listEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    addButton("Done", "secondary", resetQr);
    stopQrPolling();
  } else if (state === "failed") {
    qrCover.textContent = "Failed";
    qrTitle.textContent = "Pairing did not go through";
    qrTitle.style.color = "var(--danger)";
    qrBody.textContent =
      "The phone scanned the code but the two could not agree. This usually means the network blocks devices from finding each other. Typing the code works on those networks.";
    addButton("Try again", "primary", startQr);
    addButton("Type a code instead", "secondary", () => {
      resetQr();
      openExpander("code");
    });
    stopQrPolling();
  } else if (state === "expired") {
    qrCover.textContent = "Expired";
    qrTitle.textContent = "This code has expired";
    qrTitle.style.color = "var(--warning-text)";
    qrBody.textContent = "Codes are only good for a few minutes. Generate a fresh one and scan it straight away.";
    addButton("Show a new code", "primary", startQr);
    addButton("Cancel", "secondary", resetQr);
    stopQrPolling();
  } else {
    // cancelled, or anything else — just go back to idle.
    resetQr();
  }
}

function resetQr() {
  stopQrPolling();
  qrActive.hidden = true;
  qrIdle.hidden = false;
}

async function pollQr() {
  try {
    renderQrState(await api("/api/pair/qr/status"));
  } catch (e) {
    qrBody.textContent = `Error: ${e.message}`;
  }
}

async function startQr() {
  try {
    const s = await api("/api/pair/qr", { method: "POST" });
    qrImg.src = s.qr;
    qrIdle.hidden = true;
    qrActive.hidden = false;
    renderQrState(s);
    stopQrPolling();
    qrPollTimer = setInterval(pollQr, 1000);
  } catch (e) {
    alert(`Could not start pairing: ${e.message}`);
  }
}

async function cancelQr() {
  stopQrPolling();
  resetQr();
  try {
    await api("/api/pair/qr/cancel", { method: "POST" });
  } catch (_) {
    // Best-effort — the session times out on its own regardless.
  }
}

document.getElementById("qr-start").onclick = startQr;
window.addEventListener("beforeunload", () => {
  if (qrPollTimer) navigator.sendBeacon("/api/pair/qr/cancel");
});

// --- Typed-code pairing -------------------------------------------------

const pairResultEl = document.getElementById("pair-result");

document.getElementById("pair-btn").onclick = async (e) => {
  const addr = document.getElementById("pair-addr").value.trim();
  const code = document.getElementById("pair-code").value.trim();
  pairResultEl.className = "pair-result";
  if (!addr || !code) {
    pairResultEl.textContent = "Fill in both boxes — the address and the six-digit number are both shown on the phone.";
    pairResultEl.classList.add("error");
    return;
  }
  const btn = e.target;
  btn.disabled = true;
  try {
    await postJson("/api/pair", { addr, code });
    pairResultEl.textContent = "Paired. The phone is in the list above, ready to connect.";
    pairResultEl.classList.add("success");
    document.getElementById("pair-addr").value = "";
    document.getElementById("pair-code").value = "";
    await refreshDevices();
  } catch (err) {
    pairResultEl.textContent = `Pairing failed: ${err.message}`;
    pairResultEl.classList.add("error");
  } finally {
    btn.disabled = false;
  }
};

// --- Picture & speed -----------------------------------------------------

const presetGrid = document.getElementById("preset-grid");
const summaryEl = document.getElementById("quality-summary");
const advancedToggle = document.getElementById("advanced-toggle");
const slidersEl = document.getElementById("sliders");

const SLIDER_SPECS = [
  {
    key: "videoBitRate",
    label: "Picture detail",
    min: 2_000_000,
    max: 16_000_000,
    step: 1_000_000,
    format: (v) => `${Math.round(v / 1_000_000)} Mbps`,
    hint: "How much detail is sent each second. Higher looks better but runs further behind on a busy network.",
    ends: ["Softer, keeps up", "Sharper, more delay"],
  },
  {
    key: "maxFps",
    label: "Smoothness",
    min: 15,
    max: 60,
    step: 5,
    format: (v) => `${v} frames a second`,
    hint: "How often the picture updates. Below about 30 scrolling starts to look choppy.",
    ends: ["15", "60"],
  },
  {
    key: "maxSize",
    label: "Size sent from the phone",
    min: 720,
    max: 1600,
    step: 80,
    format: (v) => `${v} px tall`,
    hint: "The single biggest factor in both sharpness and delay. Lower this first if the picture lags.",
    ends: ["720", "1600"],
  },
];

let currentQuality = null;

async function loadQuality() {
  currentQuality = await fetchQualitySettings();
  renderPresets();
  renderSliders();
  renderSummary();
}

function renderSummary() {
  summaryEl.textContent = summarySentence(currentQuality);
}

function renderPresets() {
  presetGrid.innerHTML = "";
  const active = matchingPreset(currentQuality);
  for (const [key, preset] of Object.entries(PRESETS)) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "mlv-preset-tile" + (key === active ? " selected" : "");
    tile.innerHTML = `<span class="radio"></span><span class="label">${preset.label}</span><span class="hint">${preset.hint}</span>`;
    if (key !== "custom") {
      tile.onclick = async () => {
        currentQuality = { videoBitRate: preset.videoBitRate, maxFps: preset.maxFps, maxSize: preset.maxSize };
        await saveQualitySettings(currentQuality);
        renderPresets();
        renderSliders();
        renderSummary();
      };
    } else {
      tile.onclick = () => setAdvancedOpen(true);
    }
    presetGrid.append(tile);
  }
}

function setAdvancedOpen(open) {
  slidersEl.hidden = !open;
  advancedToggle.textContent = open ? "Hide the three settings" : "Set the three settings myself";
}
advancedToggle.onclick = () => setAdvancedOpen(slidersEl.hidden);

function renderSliders() {
  slidersEl.innerHTML = "";
  for (const spec of SLIDER_SPECS) {
    const row = document.createElement("div");
    row.className = "mlv-slider-row";

    const head = document.createElement("div");
    head.className = "mlv-slider-row-head";
    const label = document.createElement("span");
    label.className = "mlv-slider-label";
    label.textContent = spec.label;
    const value = document.createElement("span");
    value.className = "mlv-slider-value";
    value.textContent = spec.format(currentQuality[spec.key]);
    head.append(label, value);

    const hint = document.createElement("p");
    hint.className = "mlv-slider-hint";
    hint.textContent = spec.hint;

    const input = document.createElement("input");
    input.type = "range";
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
    input.value = currentQuality[spec.key];

    const ends = document.createElement("div");
    ends.className = "mlv-slider-endlabels";
    ends.innerHTML = `<span>${spec.ends[0]}</span><span>${spec.ends[1]}</span>`;

    input.addEventListener("input", () => {
      value.textContent = spec.format(Number(input.value));
    });
    input.addEventListener("change", async () => {
      currentQuality = { ...currentQuality, [spec.key]: Number(input.value) };
      await saveQualitySettings(currentQuality);
      renderPresets(); // moving a slider away from a preset's exact values shows "Custom" as selected
      renderSummary();
    });

    row.append(head, hint, input, ends);
    slidersEl.append(row);
  }
}

loadQuality();
