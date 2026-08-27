"use strict";

const { ScrcpySession } = require("../src/server/scrcpy/session");

let frameCount = 0;

(async () => {
  const session = new ScrcpySession();

  console.log("Starting scrcpy session (push jar, forward, spawn server, connect sockets)...");
  await session.start();
  console.log("Connected. Adb binary:", session.adbBinary, "Serial:", session.serial);

  session.video.on("deviceName", (name) => console.log("Device name:", JSON.stringify(name)));
  session.video.on("codec", (codec) =>
    console.log(`Codec id: 0x${codec.id.toString(16)} ("${codec.fourcc}")`)
  );
  session.video.on("session", ({ width, height }) => console.log(`Resolution: ${width}x${height}`));
  session.video.on("error", (err) => console.error("Video parser error:", err));
  session.video.on("frame", ({ config, keyFrame, pts, payload }) => {
    frameCount++;
    if (frameCount <= 5 || frameCount % 30 === 0) {
      const kind = config ? "CONFIG" : keyFrame ? "KEYFRAME" : "frame";
      console.log(`[${frameCount}] ${kind} size=${payload.length} pts=${pts}`);
    }
  });

  process.on("SIGINT", async () => {
    console.log(`\nStopping. Total frames received: ${frameCount}`);
    await session.stop();
    process.exit(0);
  });

  console.log("Streaming raw bytes for 15s (Ctrl+C to stop early)...");
  setTimeout(async () => {
    console.log(`\nDone. Total frames received: ${frameCount}`);
    await session.stop();
    process.exit(frameCount > 0 ? 0 : 1);
  }, 15000);
})().catch((e) => {
  console.error("Phase 1 failed:", e);
  process.exit(1);
});
