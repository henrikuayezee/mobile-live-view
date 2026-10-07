"use strict";

// Draws the mouse position over the phone as real page content instead of
// relying on the OS cursor. Call apps (Teams, Meet, Zoom) often don't
// capture the OS cursor at all when sharing a single window, and when they
// do, a thin crosshair is lost to video compression — so on a call, the
// audience couldn't see where on the phone the presenter was pointing.
// A ripple on each press also shows them where a tap landed.
export function attachPointerIndicator(canvas) {
  const frame = canvas.parentElement;

  const dot = document.createElement("div");
  dot.id = "pointer-dot";
  dot.hidden = true;
  frame.append(dot);

  function place(el, e) {
    const rect = frame.getBoundingClientRect();
    el.style.left = `${e.clientX - rect.left}px`;
    el.style.top = `${e.clientY - rect.top}px`;
  }

  canvas.addEventListener("pointerenter", (e) => {
    place(dot, e);
    dot.hidden = false;
  });
  canvas.addEventListener("pointerleave", () => {
    dot.hidden = true;
    dot.classList.remove("pressed");
  });
  canvas.addEventListener("pointermove", (e) => {
    place(dot, e);
    dot.hidden = false;
  });

  canvas.addEventListener("pointerdown", (e) => {
    dot.classList.add("pressed");
    const ripple = document.createElement("div");
    ripple.className = "pointer-ripple";
    place(ripple, e);
    ripple.addEventListener("animationend", () => ripple.remove());
    frame.append(ripple);
  });
  const release = () => dot.classList.remove("pressed");
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
}
