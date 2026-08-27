"use strict";

// One-time wireless debugging pairing.
//
// Usage: node scripts/pair-wireless.js <ip:port> <6-digit-code>
//
// Get both from the phone: Settings > Developer options > Wireless
// debugging > "Pair device with pairing code". That screen's IP:port is
// DIFFERENT from (and only used for) this one-time pairing step — the
// main Wireless debugging screen shows a separate, stable IP:port to put
// in .env as WIRELESS_ADB_ADDR for every session afterward.

const { resolveAdb } = require("../src/server/adb/locate-adb");
const adb = require("../src/server/adb/adb");
const config = require("../src/server/config");

(async () => {
  const [addr, code] = process.argv.slice(2);
  if (!addr || !code) {
    console.error("Usage: node scripts/pair-wireless.js <ip:port> <6-digit-code>");
    process.exit(1);
  }

  // Pairing doesn't need a device already visible in `adb devices`, so we
  // don't use resolveAdb() here — just pick the first adb binary that
  // actually runs, trying the same candidate order for consistency.
  const candidates = [config.adbPath, "adb", config.adbFallbackPath].filter(Boolean);
  let lastErr;
  for (const candidate of candidates) {
    try {
      const output = await adb.pair(candidate, addr, code);
      console.log(output.trim());
      console.log(`\nPaired using ${candidate}.`);
      console.log(
        "Now set WIRELESS_ADB_ADDR in .env to the address shown on the phone's main " +
          "Wireless debugging screen (not the pairing address you just used), then run " +
          "npm run check-adb."
      );
      process.exit(0);
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(`Pairing failed on all candidates. Last error: ${lastErr && lastErr.message}`);
  process.exit(1);
})();
