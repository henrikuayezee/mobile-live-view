"use strict";

const net = require("net");
const path = require("path");
const adb = require("../adb/adb");
const { resolveAdb, resolveAdbBinary } = require("../adb/locate-adb");
const config = require("../config");
const { VideoSocketParser } = require("./video-socket");

const SCID = "00000000"; // fixed; fine for a single-user local tool, no concurrent-instance collisions expected
const SOCKET_NAME = `scrcpy_${SCID}`;
const CONNECT_RETRY_MS = 200;
const CONNECT_TIMEOUT_MS = 8000;

const CONNECT_GRACE_MS = 200;

// A raw TCP "connect" against an adb-forwarded port only proves the local
// forward listener accepted us — NOT that it successfully proxied through
// to a live accept() on the device's LocalServerSocket. Observed on this
// device/adb combo: if the Java server hasn't reached
// `new LocalServerSocket(...)` yet, adb forward still completes our TCP
// handshake, then immediately closes it once the backend connection it
// attempts fails ("Connection refused" on localabstract, visible in
// logcat). So "connect" alone is not trustworthy — wait out a short grace
// period and only trust the socket if it hasn't closed/errored by then.
function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let graceTimer = null;

    const onFail = (err) => {
      clearTimeout(graceTimer);
      reject(err || new Error("socket closed before grace period elapsed"));
    };

    socket.once("error", onFail);
    socket.once("close", () => onFail());
    socket.once("connect", () => {
      graceTimer = setTimeout(() => {
        socket.removeListener("error", onFail);
        socket.removeListener("close", onFail);
        resolve(socket);
      }, CONNECT_GRACE_MS);
    });
  });
}

// Retries connecting until the on-device server is actually listening
// (it takes a moment to start after the shell command is spawned).
async function connectWithRetry(port, deadline) {
  for (;;) {
    try {
      return await connectOnce(port);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
}

// Orchestrates one scrcpy-server session: push jar, forward, spawn the
// on-device server, then open two sequential TCP connections through the
// same forwarded port. Per DesktopConnection.java, the device's
// LocalServerSocket.accept()s connections in a fixed order — video first,
// then control (audio is disabled here, so it's skipped entirely) — so the
// two host-side connections MUST be opened strictly in that order, not
// concurrently, or they'll be matched to the wrong device-side role.
class ScrcpySession {
  constructor() {
    this.adbBinary = null;
    this.serial = null;
    this.serverProcess = null;
    this.videoSocket = null;
    this.controlSocket = null;
    this.video = null; // VideoSocketParser
    this.stopped = false;
    // Physical panel size, which is NOT the same as the encoded stream
    // size once max_size downscales it. Screenshots and uiautomator both
    // report device pixels, so this is the coordinate space callers work
    // in; the stream size is an internal detail.
    this.deviceResolution = null;
  }

  // explicitSerial pins this session to one device (used by
  // DeviceManager); omitting it keeps the original auto-pick behaviour
  // for CLI callers, which requires exactly one connected device.
  async start(explicitSerial) {
    let adbBinary;
    let serial;
    if (explicitSerial) {
      ({ adbBinary } = await resolveAdbBinary());
      serial = explicitSerial;
    } else {
      ({ adbBinary, serial } = await resolveAdb());
    }
    this.adbBinary = adbBinary;
    this.serial = serial;
    this.deviceResolution = await readDeviceResolution(adbBinary, serial);

    // Self-healing: a prior run that crashed/was killed uncleanly can leave
    // an orphaned on-device server still bound to our socket name, which
    // would silently swallow our new connections (they'd complete a TCP
    // handshake against adb's forward but never get accept()-ed by a live
    // Java LocalServerSocket, so no data would ever arrive). Clear both
    // sides before starting.
    await adb.run(adbBinary, ["-s", serial, "forward", "--remove-all"]);
    await adb.run(adbBinary, [
      "-s",
      serial,
      "shell",
      "pkill",
      "-f",
      "com.genymobile.scrcpy.Server",
    ]);

    const jarLocal = path.join(config.vendorDir, config.SCRCPY_SERVER_JAR);
    await adb.push(adbBinary, serial, jarLocal, config.onDeviceServerPath);
    await adb.forward(adbBinary, serial, config.scrcpyForwardPort, SOCKET_NAME);

    const args = [
      `CLASSPATH=${config.onDeviceServerPath}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      config.SCRCPY_VERSION,
      `scid=${SCID}`,
      "log_level=info",
      "audio=false",
      "tunnel_forward=true",
      `video_bit_rate=${config.videoBitRate}`,
    ];
    // Both are omitted entirely when unset so scrcpy keeps its own
    // defaults (uncapped fps, full device resolution).
    if (config.maxFps) args.push(`max_fps=${config.maxFps}`);
    if (config.maxSize) args.push(`max_size=${config.maxSize}`);
    console.log(`Spawning: adb -s ${serial} shell ${args.join(" ")}`);
    this.serverProcess = adb.spawnShell(adbBinary, serial, args);
    this.serverProcess.stdout.on("data", (d) => process.stdout.write(`[server stdout] ${d}`));
    this.serverProcess.stderr.on("data", (d) => process.stdout.write(`[server stderr] ${d}`));
    this.serverProcess.on("exit", (code, signal) => {
      console.log(`[server process] exited: code=${code} signal=${signal}`);
    });

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    // Order matters — see class doc comment.
    this.videoSocket = await connectWithRetry(config.scrcpyForwardPort, deadline);
    this.controlSocket = await connectWithRetry(config.scrcpyForwardPort, deadline);

    // Without this, a write to an already-destroyed control socket emits
    // an 'error' with no listener, which in Node throws in the event loop
    // and takes down the whole process. Easy to hit once sessions are
    // torn down repeatedly at runtime (device switching), not just at exit.
    this.controlSocket.on("error", (err) => {
      console.warn("Control socket error (ignored):", err.message);
    });

    // Nothing may await between constructing the parser and the caller
    // attaching its listeners: the socket is already delivering data, and
    // any event emitted in that window is lost (the session packet, which
    // carries the stream dimensions, arrives almost immediately).
    this.video = new VideoSocketParser(this.videoSocket);
    this.stopped = false;
    return this;
  }

  writeControl(buf) {
    if (this.stopped || !this.controlSocket || this.controlSocket.destroyed) return false;
    this.controlSocket.write(buf);
    return true;
  }

  async stop() {
    this.stopped = true;
    // Detach video listeners explicitly rather than relying on GC: socket
    // 'close' fires asynchronously, and a late frame event from this dying
    // session could otherwise repopulate the hub's just-cleared caches
    // with the previous device's data mid-switch.
    if (this.video) this.video.removeAllListeners();
    if (this.videoSocket) this.videoSocket.destroy();
    if (this.controlSocket) this.controlSocket.destroy();
    if (this.serverProcess) this.serverProcess.kill();
    if (this.adbBinary && this.serial) {
      await adb.removeForward(this.adbBinary, this.serial, config.scrcpyForwardPort);
      // Killing the local `adb shell` client does not reliably kill the
      // remote app_process it started — explicitly kill it on-device too,
      // so the next run doesn't inherit an orphaned server (see start()).
      await adb.run(this.adbBinary, [
        "-s",
        this.serial,
        "shell",
        "pkill",
        "-f",
        "com.genymobile.scrcpy.Server",
      ]);
    }
  }
}

// "Physical size: 1440x3088", with an "Override size:" line taking
// precedence when the display has been resized.
async function readDeviceResolution(adbBinary, serial) {
  try {
    const { stdout } = await adb.run(adbBinary, ["-s", serial, "shell", "wm", "size"]);
    const override = stdout.match(/Override size:\s*(\d+)x(\d+)/);
    const physical = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
    const m = override || physical;
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  } catch (_) {
    // Falls back to the stream size at the call site.
  }
  return null;
}

module.exports = { ScrcpySession };
