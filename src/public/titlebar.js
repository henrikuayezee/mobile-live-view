"use strict";

// Custom title bar, mounted at the top of both index.html and settings.html.
// Pure DOM component: the page feeds it status/session data from whatever
// WebSocket it already has (index.html's existing video socket; settings.html
// opens its own status-only ?video=0 connection) — this module has no
// networking of its own.

const CHIP_STATES = {
  idle: { dot: "rgba(255,255,255,.35)", pulse: false, label: () => "No phone connected" },
  attaching: { dot: "#fce100", pulse: true, label: () => "Finding the phone…" },
  starting: { dot: "#fce100", pulse: true, label: () => "Starting the picture…" },
  reconnecting: { dot: "#fce100", pulse: true, label: () => "Reconnecting…" },
  streaming: { dot: "#6ccb5f", pulse: false, label: (s) => `${s.model || "Device"} — live` },
  lost: { dot: "#ff99a4", pulse: false, label: () => "Connection lost" },
  permission: { dot: "#fce100", pulse: true, label: () => "Waiting on the phone" },
};

const TRANSPORT_LABEL = { usb: "USB", wireless: "Wi-Fi" };
const COLLAPSE_STORAGE_KEY = "mlv-titlebar-collapsed";

export function createTitlebar() {
  const el = document.createElement("div");
  el.id = "mlv-titlebar";
  el.innerHTML = `
    <div id="mlv-titlebar-mark">
      <div class="glyph"></div>
      <span class="name">Mobile Live View</span>
    </div>
    <div id="mlv-chip">
      <span class="dot"></span>
      <span class="label"></span>
    </div>
    <span id="mlv-titlebar-meta"></span>
    <div id="mlv-titlebar-spacer"></div>
    <button id="mlv-titlebar-collapse" title="Hide title bar" type="button">&#9650;</button>
    <div id="mlv-titlebar-controls">
      <button class="min" title="Minimize" type="button">&#9472;</button>
      <button class="max" title="Maximize" type="button">&#9633;</button>
      <button class="close" title="Close" type="button">&#10005;</button>
    </div>
  `;

  const dot = el.querySelector("#mlv-chip .dot");
  const label = el.querySelector("#mlv-chip .label");
  const meta = el.querySelector("#mlv-titlebar-meta");
  const collapseBtn = el.querySelector("#mlv-titlebar-collapse");

  let lastStatus = { state: "idle" };
  let lastSession = null;

  function render() {
    const config = CHIP_STATES[lastStatus.state] || CHIP_STATES.idle;
    dot.style.background = config.dot;
    dot.classList.toggle("pulse", config.pulse);
    label.textContent = config.label(lastStatus);

    if (lastStatus.state === "streaming" && lastSession) {
      const transport = TRANSPORT_LABEL[lastStatus.connectionType] || "";
      meta.textContent = `${lastSession.width} × ${lastSession.height}${transport ? " · " + transport : ""}`;
      meta.style.display = "";
    } else {
      meta.style.display = "none";
    }
  }

  // Collapsed to a thin 6px strip rather than removed entirely, so there
  // is always something visible to click to bring it back — a fully
  // hidden bar with no handle would be a dead end. Preference is
  // per-browser (localStorage), not per-tab, so it holds across reloads.
  function setCollapsed(collapsed) {
    el.classList.toggle("collapsed", collapsed);
    collapseBtn.title = collapsed ? "Show title bar" : "Hide title bar";
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    } catch (_) {
      // Private browsing / storage blocked — collapse still works, just
      // doesn't persist across reloads.
    }
  }

  collapseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setCollapsed(!el.classList.contains("collapsed"));
  });
  // Clicking anywhere on the collapsed (thin) strip re-expands it, not
  // just the tiny chevron button.
  el.addEventListener("click", () => {
    if (el.classList.contains("collapsed")) setCollapsed(false);
  });

  try {
    if (localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1") setCollapsed(true);
  } catch (_) {
    // Same as above — default to expanded.
  }

  // Not yet wired to a real OS window — see css/titlebar.css's file header.
  // Packaging (Electron or similar) is what gives these buttons something
  // real to control.
  for (const btn of el.querySelectorAll("#mlv-titlebar-controls button")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      console.log(`Window control "${btn.className}" clicked — not wired until this is packaged.`);
    });
  }

  render();

  return {
    element: el,
    applyStatus(status) {
      lastStatus = status;
      render();
    },
    applySession(session) {
      lastSession = session;
      render();
    },
  };
}

// Convenience for pages that just want the bar mounted at the top of
// <body> with no further interaction of their own beyond feeding updates.
export function mountTitlebar() {
  const titlebar = createTitlebar();
  document.body.insertBefore(titlebar.element, document.body.firstChild);
  return titlebar;
}
