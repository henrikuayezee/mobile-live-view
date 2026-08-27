"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../src/server/config");

const SHASUMS_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${config.SCRCPY_VERSION}/SHA256SUMS.txt`;

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

(async () => {
  const destPath = path.join(config.vendorDir, config.SCRCPY_SERVER_JAR);

  if (fs.existsSync(destPath)) {
    console.log(`Already present: ${destPath}`);
    process.exit(0);
  }

  fs.mkdirSync(config.vendorDir, { recursive: true });

  console.log(`Fetching checksums: ${SHASUMS_URL}`);
  const shasums = (await download(SHASUMS_URL)).toString("utf8");
  const wantName = `scrcpy-server-v${config.SCRCPY_VERSION}`;
  const line = shasums
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith(wantName));
  if (!line) {
    throw new Error(`Could not find "${wantName}" in SHA256SUMS.txt`);
  }
  const expectedHash = line.trim().split(/\s+/)[0];

  console.log(`Fetching server jar: ${config.SCRCPY_SERVER_JAR_URL}`);
  const jar = await download(config.SCRCPY_SERVER_JAR_URL);

  const actualHash = sha256(jar);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${wantName}: expected ${expectedHash}, got ${actualHash}`
    );
  }
  console.log(`Checksum OK: ${actualHash}`);

  fs.writeFileSync(destPath, jar);
  console.log(`Saved to: ${destPath}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
