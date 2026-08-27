import { ScrcpyDecoder } from "./decoder.js";
import { attachPointerInput } from "./input.js";

const canvas = document.getElementById("screen");
const statusEl = document.getElementById("status");
const decoder = new ScrcpyDecoder(canvas);
let activeSocket = null;

// Must mirror src/server/ws/hub.js's encodeVideoMessage exactly:
//   byte 0    flags (bit0 = config, bit1 = keyFrame)
//   bytes 1-8 pts, u64 BE
//   remainder Annex-B H.264 payload
const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;

function parseVideoMessage(buf) {
  const view = new DataView(buf);
  const flags = view.getUint8(0);
  const pts = view.getBigUint64(1, false);
  return {
    config: (flags & FLAG_CONFIG) !== 0,
    keyFrame: (flags & FLAG_KEYFRAME) !== 0,
    pts: Number(pts),
    payload: new Uint8Array(buf, 9),
  };
}

// Any transition away from an active stream invalidates the decoder,
// which is configured for one specific device's bitstream.
function handleStatus(msg) {
  if (msg.state === "idle") {
    decoder.reset();
    statusEl.textContent = "No device connected — open Settings to pick one";
  } else if (msg.state === "connecting") {
    decoder.reset();
    statusEl.textContent = `Connecting to ${msg.serial || "device"}...`;
  } else if (msg.state === "error") {
    decoder.reset();
    statusEl.textContent = `Connection failed: ${msg.error || "unknown error"}`;
  } else if (msg.state === "streaming") {
    statusEl.textContent = "Streaming...";
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    statusEl.textContent = "Connected — waiting for video...";
    activeSocket = ws;
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.type === "session") {
        statusEl.textContent = `${msg.width}x${msg.height}`;
        window.__deviceSize = { width: msg.width, height: msg.height };
      } else if (msg.type === "status") {
        handleStatus(msg);
      }
      return;
    }
    decoder.handlePacket(parseVideoMessage(event.data));
  };

  ws.onclose = () => {
    if (activeSocket === ws) activeSocket = null;
    statusEl.textContent = "Disconnected — retrying...";
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}

connect();

function sendInput(msg) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(msg));
  }
}

attachPointerInput(canvas, sendInput);

// android/keycodes.h — mirrors src/server/scrcpy/constants.js KEYCODE.
const KEYCODE = { BACK: 4, HOME: 3, APP_SWITCH: 187 };
document.getElementById("nav-back").onclick = () => sendInput({ type: "key", keycode: KEYCODE.BACK });
document.getElementById("nav-home").onclick = () => sendInput({ type: "key", keycode: KEYCODE.HOME });
document.getElementById("nav-recents").onclick = () => sendInput({ type: "key", keycode: KEYCODE.APP_SWITCH });

// Fullscreen is the biggest single gain in apparent size: it reclaims the
// browser chrome and taskbar, which on a typical laptop is a fifth of the
// vertical space the (height-constrained) device image is competing for.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen().catch((e) => console.warn("Fullscreen refused:", e.message));
}

document.getElementById("fullscreen").onclick = toggleFullscreen;

document.addEventListener("keydown", (e) => {
  // Ignore while typing into a field, so "f" stays usable as text.
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "f" || e.key === "F") toggleFullscreen();
});
