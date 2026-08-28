"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("../src/server/config");

// Bundled into the packaged app so it works on a machine with no adb
// installed at all — see locate-adb.js's candidatePaths() and
// electron/main.js. Same three files scrcpy's own official Windows
// releases bundle, for the same reason (adb.exe needs its two companion
// DLLs for USB access on Windows).
const ZIP_URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const PLATFORM_TOOLS_DIR = path.join(config.vendorDir, "platform-tools");
const WANTED_FILES = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"];

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  const destAdb = path.join(PLATFORM_TOOLS_DIR, "adb.exe");
  if (fs.existsSync(destAdb)) {
    console.log(`Already present: ${destAdb}`);
    process.exit(0);
  }

  fs.mkdirSync(config.vendorDir, { recursive: true });
  const zipPath = path.join(config.vendorDir, "platform-tools.zip");
  const extractDir = path.join(config.vendorDir, "_platform-tools-extract");

  console.log(`Fetching: ${ZIP_URL}`);
  const zip = await download(ZIP_URL);
  if (zip.length === 0) throw new Error("Downloaded zip is empty.");
  fs.writeFileSync(zipPath, zip);

  // Google does not publish a checksum sidecar for this zip (unlike
  // scrcpy's SHA256SUMS.txt), so this can only sanity-check the result,
  // not cryptographically verify it.
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  console.log("Extracting...");
  // argv array, not a shell string — this repo's own path contains a
  // space ("Mobile Features"), which a shell-string invocation would mangle.
  execFileSync("tar", ["-xf", zipPath, "-C", extractDir]);

  fs.mkdirSync(PLATFORM_TOOLS_DIR, { recursive: true });
  const extractedToolsDir = path.join(extractDir, "platform-tools");
  for (const name of WANTED_FILES) {
    const src = path.join(extractedToolsDir, name);
    if (!fs.existsSync(src)) throw new Error(`Expected file missing from archive: ${name}`);
    fs.copyFileSync(src, path.join(PLATFORM_TOOLS_DIR, name));
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  if (!fs.existsSync(destAdb)) throw new Error(`adb.exe missing after extract: ${destAdb}`);
  console.log(`Saved to: ${PLATFORM_TOOLS_DIR}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
