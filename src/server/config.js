"use strict";

const fs = require("fs");
const path = require("path");

// Minimal .env loader so we don't need a "dotenv" dependency for a handful
// of KEY=VALUE lines. Does not overwrite variables already set in the
// environment.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, "..", "..", ".env"));

// Client version string handed to the on-device scrcpy server. Must match
// the pinned server jar exactly, or the server refuses the connection.
const SCRCPY_VERSION = "4.1";
const SCRCPY_SERVER_JAR = `scrcpy-server-v${SCRCPY_VERSION}.jar`;
const SCRCPY_SERVER_JAR_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

// Overridden by electron/main.js in the packaged app, which points this at
// a writable per-user directory (Electron's userData) instead of the
// install directory — vendor/last-device.json and vendor/quality-settings.json
// are written at runtime, and an installed app's own directory may not be
// writable. Falls back to the source-relative path for plain `node
// src/server/index.js` / `npm start`, unchanged from before.
const vendorDir = process.env.MLV_VENDOR_DIR || path.join(__dirname, "..", "..", "vendor");
const QUALITY_SETTINGS_FILE = path.join(vendorDir, "quality-settings.json");

// Quality settings (videoBitRate/maxFps/maxSize) can't be changed on a
// running stream — scrcpy's control protocol has no "change encoder
// settings" message, only ones that work within the config an encoder was
// already spawned with (confirmed against the pinned protocol this app
// implements, see scrcpy/constants.js). So a change here only takes effect
// on the NEXT connect, not the current one, and needs to survive a
// restart in the meantime — hence persisting to a file rather than just
// mutating the in-memory object.
function loadQualitySettings() {
  try {
    return JSON.parse(fs.readFileSync(QUALITY_SETTINGS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveQualitySettings({ videoBitRate, maxFps, maxSize }) {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(
    QUALITY_SETTINGS_FILE,
    JSON.stringify({ videoBitRate, maxFps, maxSize }, null, 2)
  );
}

const persistedQuality = loadQualitySettings();

module.exports = {
  adbPath: process.env.ADB_PATH || "",
  // Deliberately empty by default. A second adb binary of a DIFFERENT
  // version does not coexist with the first: running it kills the
  // other's daemon ("server version doesn't match; killing...") and
  // drops any live device. Probing one speculatively can therefore
  // destroy a working session, so a fallback is only used when
  // explicitly configured via ADB_FALLBACK_PATH.
  adbFallbackPath: process.env.ADB_FALLBACK_PATH || "",
  // Set by electron/main.js in the packaged app to its bundled adb.exe —
  // see locate-adb.js's candidatePaths(). Empty for plain `npm start`.
  bundledAdbPath: process.env.MLV_BUNDLED_ADB_PATH || "",
  deviceSerial: process.env.DEVICE_SERIAL || "",
  wirelessAdbAddr: process.env.WIRELESS_ADB_ADDR || "",

  // Bits/sec for the encoder. Paired with maxSize below: capping the
  // resolution means these bits are spread over far fewer pixels, so this
  // is sharper per pixel than scrcpy's default despite being the same
  // number. Raise for more detail, lower if the stream lags.
  //
  // Precedence: persisted vendor/quality-settings.json (set via the
  // Settings UI) wins over .env, which wins over the hardcoded default.
  // Numeric throughout (0/empty = uncapped) rather than the old
  // string-or-empty style, since the Settings UI's sliders need real
  // numbers — session.js's `if (config.maxFps)` truthy check still treats
  // 0 the same as the old "".
  videoBitRate: persistedQuality.videoBitRate ?? parseInt(process.env.VIDEO_BIT_RATE || "8000000", 10),
  // The phone happily encodes >100 fps, but a monitor renders at 60 and
  // every extra frame is bandwidth and decode work spent on something
  // nobody sees. Capping here roughly halves the data under heavy motion.
  maxFps: persistedQuality.maxFps ?? parseInt(process.env.MAX_FPS || "60", 10),
  // Longest-edge cap before encoding. A phone panel is far taller than any
  // monitor can show - streaming its full height means encoding and
  // decoding several times more pixels than are ever displayed, which
  // costs latency for no visible gain. 1600 still exceeds what fits on a
  // 1080p screen. Set to 0 to stream at full device resolution.
  maxSize: persistedQuality.maxSize ?? parseInt(process.env.MAX_SIZE || "1600", 10),

  saveQualitySettings,

  scrcpyForwardPort: parseInt(process.env.SCRCPY_FORWARD_PORT || "27183", 10),
  scrcpyControlPort: parseInt(process.env.SCRCPY_CONTROL_PORT || "27184", 10),
  webPort: parseInt(process.env.WEB_PORT || "8000", 10),

  SCRCPY_VERSION,
  SCRCPY_SERVER_JAR,
  SCRCPY_SERVER_JAR_URL,
  vendorDir,
  onDeviceServerPath: "/data/local/tmp/scrcpy-server.jar",
};
