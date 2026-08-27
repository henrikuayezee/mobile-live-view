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
  resetVideo,
};
