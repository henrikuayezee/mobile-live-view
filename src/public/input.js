"use strict";

// Captures pointer gestures on the canvas and reports them in
// device-pixel space over the given WebSocket, using the canvas's
// bounding box vs its intrinsic drawing-buffer size (which decoder.js
// keeps set to the actual device resolution) to convert coordinates —
// this stays correct regardless of how CSS has scaled the canvas down to
// fit the viewport, with no explicit object-fit math needed since the
// canvas has no letterboxing (its CSS box is exactly the scaled content).
export function attachPointerInput(canvas, sendInput) {
  function toDeviceCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.round(relX * canvas.width),
      y: Math.round(relY * canvas.height),
    };
  }

  let activePointerId = null;
  let lastPointerUpAt = 0;

  canvas.addEventListener("pointerdown", (e) => {
    if (activePointerId !== null) return; // one touch at a time for v1
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    sendInput({ type: "touch", action: "down", ...toDeviceCoords(e) });
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    sendInput({ type: "touch", action: "move", ...toDeviceCoords(e) });
    e.preventDefault();
  });

  function end(e) {
    if (e.pointerId !== activePointerId) return;
    sendInput({ type: "touch", action: "up", ...toDeviceCoords(e) });
    activePointerId = null;
    lastPointerUpAt = Date.now();
  }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // Fallback for automated clicks. Some automation dispatches a bare
  // "click" without the pointerdown/up pair above, which would otherwise
  // do nothing at all. A real user click always follows a pointerup, so
  // ignore any click that trails one closely - without this guard a
  // genuine click would register as two taps.
  canvas.addEventListener("click", (e) => {
    if (Date.now() - lastPointerUpAt < 500) return;
    const pos = toDeviceCoords(e);
    sendInput({ type: "touch", action: "down", ...pos });
    sendInput({ type: "touch", action: "up", ...pos });
  });

  // Canvas has no native meaning for a touch drag; prevent the browser's
  // own scroll/gesture handling from fighting our pointer capture.
  canvas.style.touchAction = "none";
}
