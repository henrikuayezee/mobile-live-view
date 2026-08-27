"use strict";

// All values below were confirmed against the actual scrcpy v4.1 source
// (not just docs/paraphrase) during implementation:
//   server/src/main/java/com/genymobile/scrcpy/device/{DesktopConnection,Streamer}.java
//   app/src/control_msg.{c,h}, app/src/android/input.h

const DEVICE_NAME_FIELD_LENGTH = 64;

// Streamer.java PACKET_FLAG_* — top 3 bits of the 8-byte pts/flags field
// in each 12-byte frame header.
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
// Clears bits 63 (session marker, never set on frame packets), 62 (config
// flag), and 61 (key-frame flag), leaving only the actual pts value.
const PACKET_PTS_MASK = (1n << 61n) - 1n;

// Streamer.writeSessionMeta: flags int has bit 31 (top bit) always set to
// mark it as a session packet, distinguishing it from a frame header whose
// first byte's top bit is always 0 (frames never carry PACKET_FLAG_SESSION).
const SESSION_PACKET_MARKER = 0x80000000;

// control_msg.h enum sc_control_msg_type (values are the array index, i.e.
// declaration order).
const CONTROL_MSG_TYPE = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  // Index 17 in scrcpy's enum (after UHID_CREATE/INPUT/DESTROY=12-14,
  // OPEN_HARD_KEYBOARD_SETTINGS=15, START_APP=16). No payload - just the
  // type byte. Forces the on-device encoder to emit a fresh config+
  // keyframe pair, which is how a client safely resyncs after falling
  // behind, instead of dropping frames mid-GOP and corrupting the
  // decoder's reference chain.
  RESET_VIDEO: 17,
};

// android/input.h
const KEYEVENT_ACTION = { DOWN: 0, UP: 1 };
const MOTIONEVENT_ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };

// android/keycodes.h — standard AOSP keycode values, stable across versions.
const KEYCODE = {
  BACK: 4,
  HOME: 3,
  APP_SWITCH: 187,
  ENTER: 66,
  DEL: 67,
};

// control_msg.h SC_POINTER_ID_* — reserved sentinel pointer ids, defined as
// (uint64_t)(-1), (uint64_t)(-2), (uint64_t)(-3). GENERIC_FINGER is the
// correct choice for a single synthetic touch driven from mouse/pointer
// browser events (as opposed to SC_POINTER_ID_MOUSE, which routes through
// a different, real-mouse-cursor code path server-side).
const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen; // -2 as u64

module.exports = {
  DEVICE_NAME_FIELD_LENGTH,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_PTS_MASK,
  SESSION_PACKET_MARKER,
  CONTROL_MSG_TYPE,
  KEYEVENT_ACTION,
  MOTIONEVENT_ACTION,
  KEYCODE,
  POINTER_ID_GENERIC_FINGER,
};
