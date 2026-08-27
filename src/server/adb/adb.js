"use strict";

const { execFile, spawn } = require("child_process");

const EXEC_TIMEOUT_MS = 10000;

function run(adbBinary, args, extraOpts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      adbBinary,
      args,
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true, ...extraOpts },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error(`adb ${args.join(" ")} timed out`));
          return;
        }
        // adb often writes informational lines ("daemon started successfully")
        // to stderr even on success, so we don't reject purely on stderr
        // content — only on a nonzero/failed exec.
        resolve({ stdout: stdout || "", stderr: stderr || "", err: err || null });
      }
    );
  });
}

// Parses `adb devices -l` output into [{ serial, state, ...props }].
function parseDevicesOutput(stdout) {
  const lines = stdout.split(/\r?\n/).slice(1); // drop "List of devices attached"
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    devices.push({ serial, state, raw: trimmed });
  }
  return devices;
}

async function devices(adbBinary) {
  const { stdout, err } = await run(adbBinary, ["devices", "-l"]);
  if (err) return [];
  return parseDevicesOutput(stdout);
}

// Lists wireless-debugging services advertised on the local network via
// mDNS. Unlike `adb devices`, this also surfaces devices that are paired
// and reachable but NOT currently connected, which is what makes a
// "pick any of my phones" UI possible. Output lines look like:
//   adb-R5CT21KPWMZ-7PM6f1  _adb-tls-connect._tcp  192.168.0.82:43399
async function mdnsServices(adbBinary) {
  const { stdout, err } = await run(adbBinary, ["mdns", "services"]);
  if (err) return [];
  const services = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [name, type, address] = parts;
    if (!/^_adb/.test(type)) continue;
    services.push({ name, type, address, isPairing: type.includes("pairing") });
  }
  return services;
}

function withSerial(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

// Idempotent: safe to call every run to (re)establish a wireless
// debugging connection, even if already connected.
async function connect(adbBinary, addr) {
  return run(adbBinary, ["connect", addr]);
}

async function pair(adbBinary, addr, code) {
  const { stdout, stderr, err } = await run(adbBinary, ["pair", addr, code]);
  if (err) throw new Error(`adb pair failed: ${stderr || err.message}`);
  return stdout;
}

async function push(adbBinary, serial, localPath, remotePath) {
  const { err, stderr } = await run(
    adbBinary,
    withSerial(serial, ["push", localPath, remotePath]),
    { timeout: 30000 }
  );
  if (err) throw new Error(`adb push failed: ${stderr || err.message}`);
}

async function forward(adbBinary, serial, localPort, remoteSocketName) {
  const { err, stderr } = await run(
    adbBinary,
    withSerial(serial, ["forward", `tcp:${localPort}`, `localabstract:${remoteSocketName}`])
  );
  if (err) throw new Error(`adb forward failed: ${stderr || err.message}`);
}

async function removeForward(adbBinary, serial, localPort) {
  // Best-effort cleanup; do not throw if there was nothing to remove.
  await run(adbBinary, withSerial(serial, ["forward", "--remove", `tcp:${localPort}`]));
}

// Spawns a long-running `adb shell <...>` process (used for the on-device
// scrcpy server). Returns the ChildProcess so the caller owns its lifecycle.
function spawnShell(adbBinary, serial, shellArgs) {
  const args = withSerial(serial, ["shell", ...shellArgs]);
  return spawn(adbBinary, args, { windowsHide: true });
}

module.exports = {
  run,
  devices,
  mdnsServices,
  connect,
  pair,
  push,
  forward,
  removeForward,
  spawnShell,
};
