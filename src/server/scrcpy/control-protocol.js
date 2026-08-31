"use strict";

const {
  CONTROL_MSG_TYPE,
  KEYEVENT_ACTION,
  MOTIONEVENT_ACTION,
  POINTER_ID_GENERIC_FINGER,
} = require("./constants");

// Byte layouts below are copied directly from app/src/control_msg.c
// (sc_control_msg_serialize) at the pinned scrcpy v4.1 tag — verified
// against source during implementation, not inferred from docs.

// 14 bytes: type(1) action(1) keycode(4 BE) repeat(4 BE) metastate(4 BE)
function injectKeycode({ action, keycode, repeat = 0, metastate = 0 }) {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(CONTROL_MSG_TYPE.INJECT_KEYCODE, 0);
  buf.writeUInt8(action, 1);
  buf.writeUInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeUInt32BE(metastate, 10);
  return buf;
}

function keyDown(keycode) {
  return injectKeycode({ action: KEYEVENT_ACTION.DOWN, keycode });
}
function keyUp(keycode) {
  return injectKeycode({ action: KEYEVENT_ACTION.UP, keycode });
}

// 1 + 4 + len bytes: type(1) length(4 BE) utf8-text(len, not null-terminated)
// Truncated to 300 chars server-side (SC_CONTROL_MSG_INJECT_TEXT_MAX_LENGTH);
// we truncate here too so length/byte-count stay consistent.
function injectText(text) {
  const textBuf = Buffer.from(String(text), "utf8").subarray(0, 300);
  const buf = Buffer.alloc(1 + 4 + textBuf.length);
  buf.writeUInt8(CONTROL_MSG_TYPE.INJECT_TEXT, 0);
  buf.writeUInt32BE(textBuf.length, 1);
  textBuf.copy(buf, 5);
  return buf;
}

// 32 bytes: type(1) action(1) pointerId(8 BE) x(4 BE) y(4 BE)
// screenWidth(2 BE) screenHeight(2 BE) pressure(2 BE fixed-point) actionButton(4 BE) buttons(4 BE)
//
// screenWidth/screenHeight MUST match the server's currently-reported video
// dimensions (from the last "session"/frame-header metadata received) or
// the server silently drops the event — never a value cached at page load.
function injectTouchEvent({
  action,
  x,
  y,
  screenWidth,
  screenHeight,
  pressure = action === MOTIONEVENT_ACTION.UP ? 0 : 1,
  pointerId = POINTER_ID_GENERIC_FINGER,
  actionButton = 0,
  buttons = 0,
}) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigUInt64BE(BigInt.asUintN(64, pointerId), 2);
  buf.writeUInt32BE(x, 10);
  buf.writeUInt32BE(y, 14);
  buf.writeUInt16BE(screenWidth, 18);
  buf.writeUInt16BE(screenHeight, 20);
  buf.writeUInt16BE(floatToU16Fp(pressure), 22);
  buf.writeUInt32BE(actionButton, 24);
  buf.writeUInt32BE(buttons, 28);
  return buf;
}

function touchDown(pos) {
  return injectTouchEvent({ action: MOTIONEVENT_ACTION.DOWN, ...pos });
}
function touchMove(pos) {
  return injectTouchEvent({ action: MOTIONEVENT_ACTION.MOVE, ...pos });
}
function touchUp(pos) {
  return injectTouchEvent({ action: MOTIONEVENT_ACTION.UP, ...pos });
}

// 21 bytes: type(1) x(4 BE) y(4 BE) screenWidth(2 BE) screenHeight(2 BE)
// hscroll(2 BE signed fixed-point) vscroll(2 BE signed fixed-point) buttons(4 BE)
//
// hscroll/vscroll here follow control_msg.c's own contract exactly: raw
// values in roughly [-16, 16] (scrcpy's desktop client passes SDL's mouse
// wheel "click count" straight through, unscaled), normalized to [-1, 1]
// and converted to fixed-point below - not pre-normalized by the caller,
// so this stays a faithful byte-for-byte port rather than an invented
// contract. input.js's job is only "how many wheel-clicks-worth does
// this many browser pixels feel like", which has no canonical answer to
// look up in scrcpy's source (it never sees continuous trackpad deltas,
// only discrete OS wheel-click events).
//
// Sign convention: Android's AXIS_VSCROLL/AXIS_HSCROLL follow SDL's
// mouse-wheel convention (positive = up / away from the user), which is
// the OPPOSITE of DOM WheelEvent's deltaY/deltaX (positive = content
// moves up, i.e. scrolling down toward the user) - confirmed by reading
// scrcpy's own input_manager.c, which forwards SDL's event->y into
// vscroll with no sign flip. input.js negates both axes to correct for
// this before calling here.
function injectScrollEvent({ x, y, screenWidth, screenHeight, hscroll = 0, vscroll = 0, buttons = 0 }) {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT, 0);
  buf.writeUInt32BE(x, 1);
  buf.writeUInt32BE(y, 5);
  buf.writeUInt16BE(screenWidth, 9);
  buf.writeUInt16BE(screenHeight, 11);
  buf.writeInt16BE(floatToI16Fp(clamp(hscroll / 16, -1, 1)), 13);
  buf.writeInt16BE(floatToI16Fp(clamp(vscroll / 16, -1, 1)), 15);
  buf.writeUInt32BE(buttons, 17);
  return buf;
}

// util/binary.h sc_float_to_i16fp: f in [-1,1] -> round(f * 2^15), clamped.
function floatToI16Fp(f) {
  const i = Math.round(f * 0x8000);
  if (i >= 0x7fff) return 0x7fff;
  if (i <= -0x8000) return -0x8000;
  return i;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 1 byte: just the type. Forces a fresh config+keyframe pair - the only
// SAFE way to recover a client that has fallen behind. Dropping frames
// arbitrarily is not safe: P-frames decode relative to the frame before
// them, so skipping one corrupts every frame after it until the next
// keyframe, which this stream otherwise only sends once, at startup.
function resetVideo() {
  return Buffer.from([CONTROL_MSG_TYPE.RESET_VIDEO]);
}

// util/binary.h sc_float_to_u16fp: f in [0,1] -> round(f * 2^16), clamped.
function floatToU16Fp(f) {
  const u = Math.round(f * 0x10000);
  return u >= 0xffff ? 0xffff : u;
}

module.exports = {
  injectKeycode,
  keyDown,
  keyUp,
  injectText,
  injectTouchEvent,
  touchDown,
  touchMove,
  touchUp,
  injectScrollEvent,
  resetVideo,
};
