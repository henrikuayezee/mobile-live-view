"use strict";

const { EventEmitter } = require("events");
const {
  DEVICE_NAME_FIELD_LENGTH,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_PTS_MASK,
  SESSION_PACKET_MARKER,
} = require("./constants");

const STAGE = {
  DUMMY_BYTE: "dummy_byte",
  DEVICE_NAME: "device_name",
  CODEC_ID: "codec_id",
  SESSION_META: "session_meta",
  FRAME_HEADER: "frame_header",
  FRAME_PAYLOAD: "frame_payload",
};

// Parses the byte stream scrcpy-server writes on the video socket, per
// Streamer.java / DesktopConnection.java at the pinned v4.1 tag (with
// send_dummy_byte / send_device_meta / send_stream_meta / send_frame_meta
// all left at their default `true`):
//
//   1 byte    dummy byte (discarded)
//   64 bytes  device name (UTF-8, null-padded)
//   4 bytes   codec id (BE)
//   12 bytes  session meta: flags(4, BE) + width(4, BE) + height(4, BE)
//   then repeating 12-byte frame headers + payload:
//     8 bytes  ptsAndFlags (BE): bit63=0 always (session-only bit), bit62=config,
//              bit61=keyframe, remaining bits = pts (config packets: flags only, no pts)
//     4 bytes  payload size (BE)
//     N bytes  Annex-B H.264 payload
//
// Emits: "deviceName", "codec", "session" ({width,height}), "frame"
// ({config, keyFrame, pts, payload}), "error".
class VideoSocketParser extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.stage = STAGE.DUMMY_BYTE;
    this.pendingFrameHeader = null; // { config, keyFrame, pts, size }

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", () => this.emit("close"));
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._process();
  }

  _process() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const needed = this._bytesNeeded();
      if (this.buffer.length < needed) return;

      switch (this.stage) {
        case STAGE.DUMMY_BYTE: {
          this.buffer = this.buffer.subarray(1);
          this.stage = STAGE.DEVICE_NAME;
          break;
        }
        case STAGE.DEVICE_NAME: {
          const raw = this.buffer.subarray(0, DEVICE_NAME_FIELD_LENGTH);
          const nul = raw.indexOf(0);
          const name = raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
          this.buffer = this.buffer.subarray(DEVICE_NAME_FIELD_LENGTH);
          this.emit("deviceName", name);
          this.stage = STAGE.CODEC_ID;
          break;
        }
        case STAGE.CODEC_ID: {
          const codecId = this.buffer.readUInt32BE(0);
          this.buffer = this.buffer.subarray(4);
          this.emit("codec", { id: codecId, fourcc: fourccToString(codecId) });
          this.stage = STAGE.SESSION_META;
          break;
        }
        case STAGE.SESSION_META: {
          const flags = this.buffer.readUInt32BE(0);
          const width = this.buffer.readUInt32BE(4);
          const height = this.buffer.readUInt32BE(8);
          this.buffer = this.buffer.subarray(12);
          if ((flags & SESSION_PACKET_MARKER) === 0) {
            this.emit("error", new Error(`Expected session packet marker, got flags=0x${flags.toString(16)}`));
            return;
          }
          this.emit("session", { width, height });
          this.stage = STAGE.FRAME_HEADER;
          break;
        }
        case STAGE.FRAME_HEADER: {
          const ptsAndFlags = this.buffer.readBigUInt64BE(0);
          const size = this.buffer.readUInt32BE(8);
          this.buffer = this.buffer.subarray(12);

          const config = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
          const keyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
          const pts = config ? null : Number(ptsAndFlags & PACKET_PTS_MASK);

          this.pendingFrameHeader = { config, keyFrame, pts, size };
          this.stage = STAGE.FRAME_PAYLOAD;
          break;
        }
        case STAGE.FRAME_PAYLOAD: {
          const { size, ...meta } = this.pendingFrameHeader;
          const payload = Buffer.from(this.buffer.subarray(0, size)); // copy out of the shared buffer
          this.buffer = this.buffer.subarray(size);
          this.pendingFrameHeader = null;
          this.emit("frame", { ...meta, payload });
          this.stage = STAGE.FRAME_HEADER;
          break;
        }
        default:
          return;
      }
    }
  }

  _bytesNeeded() {
    switch (this.stage) {
      case STAGE.DUMMY_BYTE:
        return 1;
      case STAGE.DEVICE_NAME:
        return DEVICE_NAME_FIELD_LENGTH;
      case STAGE.CODEC_ID:
        return 4;
      case STAGE.SESSION_META:
        return 12;
      case STAGE.FRAME_HEADER:
        return 12;
      case STAGE.FRAME_PAYLOAD:
        return this.pendingFrameHeader.size;
      default:
        return Infinity;
    }
  }
}

function fourccToString(id) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(id >>> 0);
  return b.toString("ascii");
}

module.exports = { VideoSocketParser };
