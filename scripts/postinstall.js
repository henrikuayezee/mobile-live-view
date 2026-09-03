"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

// Best-effort: a fresh `npm install` should end up with a working adb and
// scrcpy server with zero extra steps (see locate-adb.js's vendorAdbPath
// fallback), but a flaky network here must never fail the install itself.
// `predist` runs these same scripts again before `npm run dist`, where a
// hard failure IS correct — you don't want to ship an installer missing
// its bundled binaries — so the scripts themselves still exit(1) on
// failure; only this wrapper swallows that.
const STEPS = ["fetch-adb.js", "fetch-scrcpy-server.js"];

for (const script of STEPS) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.warn(
      `\n[postinstall] ${script} did not complete (network hiccup?) — this is not fatal.\n` +
        `Run "npm run ${script.replace(/\.js$/, "")}" manually when you have a working connection.\n`
    );
  }
}
