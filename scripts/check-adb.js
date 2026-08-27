"use strict";

const { resolveAdb } = require("../src/server/adb/locate-adb");

(async () => {
  try {
    const { adbBinary, serial, attempts } = await resolveAdb();
    console.log("Resolved adb binary:", adbBinary);
    console.log("Target device serial:", serial);
    if (attempts.length) {
      console.log("\nSkipped candidates:");
      for (const a of attempts) console.log(`  - ${a.candidate}: ${a.reason}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
