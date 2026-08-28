"use strict";

// Logic-only module for the three performance settings (VIDEO_BIT_RATE /
// MAX_FPS / MAX_SIZE from src/server/config.js): the preset table, the
// summary-sentence calculation, and the read/write API calls. No DOM —
// the full settings page (presets + sliders) and the panel's compact tab
// (presets only) render different markup from this.
import { api, postJson } from "./api-client.js";

export const PRESETS = {
  cable: {
    label: "Cable",
    hint: "Sharpest picture, barely any delay.",
    videoBitRate: 14_000_000,
    maxFps: 60,
    maxSize: 1600,
  },
  wifiGood: {
    label: "Good Wi-Fi",
    hint: "Sharp, a fraction of a second behind.",
    videoBitRate: 8_000_000,
    maxFps: 60,
    maxSize: 1600,
  },
  wifiWeak: {
    label: "Weak Wi-Fi",
    hint: "Softer picture that keeps up.",
    videoBitRate: 3_000_000,
    maxFps: 30,
    maxSize: 1080,
  },
  custom: {
    label: "Custom",
    hint: "Set the three below yourself.",
  },
};

export function fetchQualitySettings() {
  return api("/api/settings/quality");
}

export function saveQualitySettings({ videoBitRate, maxFps, maxSize }) {
  return postJson("/api/settings/quality", { videoBitRate, maxFps, maxSize });
}

// Which preset (if any) matches the current values exactly — used to
// highlight the right tile. No match means the user has moved a slider,
// which is exactly what should show as "Custom".
export function matchingPreset(values) {
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (key === "custom") continue;
    if (
      preset.videoBitRate === values.videoBitRate &&
      preset.maxFps === values.maxFps &&
      preset.maxSize === values.maxSize
    ) {
      return key;
    }
  }
  return "custom";
}

// A stand-in for a real latency measurement, per the design handoff:
// load = bitrate(Mbps) × (fps/60) × (maxSize/1600).
export function summarySentence({ videoBitRate, maxFps, maxSize }) {
  const load = (videoBitRate / 1_000_000) * (maxFps / 60) * (maxSize / 1600);
  if (load > 9) return "Very sharp, essentially no delay. Fine over a cable.";
  if (load > 5) return "Sharp, roughly a fifth of a second behind. Good on a solid Wi-Fi connection.";
  if (load > 2.5) return "Slightly soft, keeps up well on a weak connection.";
  return "Soft picture, minimal delay. Use when Wi-Fi is struggling.";
}
