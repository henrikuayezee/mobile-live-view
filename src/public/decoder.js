"use strict";

// Wraps the browser's native WebCodecs VideoDecoder to play the raw
// Annex-B H.264 stream scrcpy-server emits, via the WS relay in hub.js.
//
// Two things this needs to get right, both empirically resolved against
// a real device during Phase 1/2 of this build (see plan doc):
//  1. `avc: { format: 'annexb' }` in the decoder config lets Chrome parse
//     SPS/PPS in-band, so we don't need to hand-build an avcC description.
//  2. A bare config packet (SPS/PPS only, no coded picture) is not itself
//     decodable — cache it and prepend its bytes to the very next keyframe
//     chunk instead of calling decode() on it directly.
export class ScrcpyDecoder {
  // onNeedKeyframe: called when the decoder has lost its reference chain
  // and can only recover from a fresh keyframe (app.js forwards it to the
  // server, which holds this client and asks the device for one).
  constructor(canvas, { onNeedKeyframe = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.decoder = null;
    this.configured = false;
    this.pendingConfigBytes = null;
    this.codecString = null;
    this.onNeedKeyframe = onNeedKeyframe;
    // A fresh decoder must start on a keyframe; a delta fed into it first
    // errors and closes it.
    this.awaitingKeyFrame = true;
  }

  // The decoder's reference frames are gone (decode error, or it was closed
  // underneath us). Feeding it more delta frames would either keep erroring
  // or decode against the wrong picture, so drop deltas until a keyframe
  // arrives and ask for one.
  _lostSync(reason) {
    console.warn(`Video decoder lost sync (${reason}) — waiting for a fresh keyframe.`);
    this.configured = false;
    this.awaitingKeyFrame = true;
    // Repeat requests are harmless: the server ignores them while it's
    // already holding this client for a keyframe.
    if (this.onNeedKeyframe) this.onNeedKeyframe();
  }

  // Tears everything down so the next device's config packet configures a
  // fresh decoder. Must be called on any device switch: a VideoDecoder is
  // bound to one stream's parameters, and the cached codec string would
  // otherwise be reused for a different phone's bitstream.
  reset() {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch (_) {
        // Already closing/closed — nothing to do.
      }
    }
    this.decoder = null;
    this.configured = false;
    this.codecString = null;
    this.pendingConfigBytes = null;
    this.awaitingKeyFrame = true;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // packet: { config, keyFrame, pts, payload: Uint8Array }
  handlePacket(packet) {
    if (packet.config) {
      this.pendingConfigBytes = packet.payload;
      // Always recompute: a different device has a different H.264
      // profile/level, and reusing a cached codec string across a switch
      // configures the decoder for the wrong bitstream.
      this.codecString = codecStringFromAnnexB(packet.payload) || this.codecString;
      return;
    }

    if (this.awaitingKeyFrame && !packet.keyFrame) return;

    if (!this.configured || !this.decoder || this.decoder.state === "closed") {
      if (!this.codecString) return; // haven't seen a config packet yet; drop until we have one
      this._configure();
    }

    let data = packet.payload;
    if (packet.keyFrame && this.pendingConfigBytes) {
      data = concatBytes(this.pendingConfigBytes, packet.payload);
      this.pendingConfigBytes = null;
    }

    // Frames are never dropped here. A P-frame decodes relative to the
    // frame before it, so skipping one corrupts every frame after it
    // (visible as smeared, doubled-looking video) until the next keyframe
    // — which this stream otherwise only sends once, at startup. The
    // server (hub.js) is where backpressure is handled safely, by holding
    // a lagging client at its last keyframe and requesting a fresh one,
    // never by skipping frames out of an established reference chain.
    const chunk = new EncodedVideoChunk({
      type: packet.keyFrame ? "key" : "delta",
      timestamp: packet.pts,
      data,
    });
    try {
      this.decoder.decode(chunk);
      if (packet.keyFrame) this.awaitingKeyFrame = false;
    } catch (e) {
      this._lostSync(`decode() threw: ${e.message}`);
    }
  }

  _configure() {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch (_) {
        // Already closing — nothing to do.
      }
    }
    const decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      // Asynchronous decode failures land here, not in decode()'s try/catch,
      // and leave the decoder closed. Ignore errors from a decoder we've
      // already replaced.
      error: (e) => {
        if (this.decoder === decoder) this._lostSync(`VideoDecoder error: ${e.message}`);
      },
    });
    this.decoder = decoder;
    this.decoder.configure({
      codec: this.codecString,
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
      // Without this the decoder buffers frames to allow for reordering,
      // which adds steady latency to a live stream that has no B-frames
      // to reorder in the first place.
      optimizeForLatency: true,
    });
    this.configured = true;
  }

  _onFrame(frame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      // The phone-frame wrapper (see index.html/live-view.css) sizes
      // itself from this — CSS aspect-ratio lets the browser pick
      // whichever of height:100%/max-width:100% actually binds, correctly
      // handling both a tall narrow window (height-bound) and a short
      // wide one (width-bound) without extra layout math here. Reaches up
      // to the immediate parent rather than a hardcoded id, since decoder.js
      // shouldn't otherwise know about page structure.
      const frameEl = this.canvas.parentElement;
      if (frameEl) frameEl.style.aspectRatio = `${frame.displayWidth} / ${frame.displayHeight}`;
    }
    this.ctx.drawImage(frame, 0, 0);
    frame.close();
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Finds the first SPS NAL unit (nal_unit_type 7) in an Annex-B byte stream
// and builds a "avc1.PPCCLL" codec string from its first 3 payload bytes
// (profile_idc, constraint_flags, level_idc) — the standard fixed offsets,
// no full SPS parse required.
function codecStringFromAnnexB(bytes) {
  let i = 0;
  while (i < bytes.length - 4) {
    const isStart3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const isStart4 =
      bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!isStart3 && !isStart4) {
      i++;
      continue;
    }
    const nalStart = i + (isStart4 ? 4 : 3);
    const nalType = bytes[nalStart] & 0x1f;
    if (nalType === 7 && nalStart + 3 < bytes.length) {
      const profile = bytes[nalStart + 1];
      const constraints = bytes[nalStart + 2];
      const level = bytes[nalStart + 3];
      const hex = (n) => n.toString(16).padStart(2, "0");
      return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
    }
    i = nalStart;
  }
  return null;
}
