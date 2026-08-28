"use strict";

// The full-stage connection-state overlay (index.html / Live view only).
// Pure rendering: given a status object, show the right title/body/steps/
// buttons. Button clicks call back out via onAction(name) — this module
// has no knowledge of adb, WebSockets, or navigation.
//
// Copy is verbatim from the design handoff's "Exact copy per state" table.
// `lost` and `permission` use the warning/error glyph, not the spinner —
// see css/overlay.css.

const DEVICE = (s) => s.model || "the phone";

const STATES = {
  idle: {
    icon: "none",
    title: () => "No phone connected yet",
    body: () =>
      "Pick a phone in setup, or plug one in with a cable. Nothing will appear here until one is connected.",
    steps: null,
    buttons: [{ label: "Open setup", kind: "primary", action: "openSetup" }],
  },
  attaching: {
    icon: "spinner",
    title: (s) => `Connecting to ${DEVICE(s)}`,
    body: () =>
      "This takes a few seconds. Two things happen: the phone is attached, then the picture starts.",
    steps: () => [
      { label: "Attaching the phone", status: "current" },
      { label: "Starting the picture", status: "pending" },
    ],
    buttons: [{ label: "Cancel", kind: "secondary", action: "cancel" }],
  },
  starting: {
    icon: "spinner",
    title: () => "Starting the picture",
    body: (s) => `${DEVICE(s)} is attached. The live picture is about to appear.`,
    steps: () => [
      { label: "Phone attached", status: "done" },
      { label: "Starting the picture", status: "current" },
    ],
    buttons: [],
  },
  reconnecting: {
    icon: "spinner",
    title: (s) => `Reconnecting to ${DEVICE(s)}`,
    body: () => "Attaching the phone again over Wi-Fi.",
    steps: null,
    buttons: [],
  },
  lost: {
    icon: "error",
    title: () => "Connection lost",
    body: () =>
      "The phone stopped responding. Android switches wireless debugging off after the phone has been asleep for a while, so this can happen more than once in a session.",
    steps: () => [
      { label: "Wake the phone", status: "pending" },
      { label: "Check Wireless debugging is still on", status: "pending" },
    ],
    buttons: [
      { label: "Reconnect", kind: "primary", action: "reconnect" },
      { label: "Use a cable instead", kind: "secondary", action: "useCable" },
    ],
  },
  permission: {
    icon: "warning",
    title: () => "Look at the phone",
    body: (s) =>
      `${DEVICE(s)} is asking permission before it can be shown here. The prompt is on the phone itself, not on this screen.`,
    steps: (s) => [
      { label: `Pick up ${DEVICE(s)}`, status: "pending" },
      { label: 'Tap Allow on "Allow USB debugging?"', status: "pending" },
      { label: 'Tick "Always allow from this computer" so it is not asked again', status: "pending" },
    ],
    buttons: [{ label: "Choose another phone", kind: "secondary", action: "chooseAnother" }],
  },
};

export function createStateOverlay(onAction) {
  const el = document.createElement("div");
  el.id = "mlv-overlay";
  el.innerHTML = `
    <div id="mlv-overlay-card">
      <div id="mlv-overlay-icon"></div>
      <h2 id="mlv-overlay-title"></h2>
      <p id="mlv-overlay-body"></p>
      <ul id="mlv-overlay-steps" hidden></ul>
      <div id="mlv-overlay-buttons"></div>
    </div>
  `;

  const iconEl = el.querySelector("#mlv-overlay-icon");
  const titleEl = el.querySelector("#mlv-overlay-title");
  const bodyEl = el.querySelector("#mlv-overlay-body");
  const stepsEl = el.querySelector("#mlv-overlay-steps");
  const buttonsEl = el.querySelector("#mlv-overlay-buttons");

  function renderIcon(kind) {
    iconEl.innerHTML = "";
    if (kind === "spinner") {
      const spinner = document.createElement("div");
      spinner.className = "mlv-spinner";
      iconEl.append(spinner);
    } else if (kind === "warning" || kind === "error") {
      const glyph = document.createElement("div");
      glyph.className = `mlv-glyph-circle ${kind}`;
      glyph.textContent = "!";
      iconEl.append(glyph);
    }
  }

  function renderSteps(steps) {
    stepsEl.innerHTML = "";
    if (!steps || !steps.length) {
      stepsEl.hidden = true;
      return;
    }
    stepsEl.hidden = false;
    steps.forEach((step, i) => {
      const li = document.createElement("li");
      li.className = step.status;
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = step.status === "done" ? "✓" : String(i + 1);
      const label = document.createElement("span");
      label.className = "step-label";
      label.textContent = step.label;
      li.append(num, label);
      stepsEl.append(li);
    });
  }

  function renderButtons(buttons) {
    buttonsEl.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = b.kind;
      btn.textContent = b.label;
      btn.type = "button";
      btn.addEventListener("click", () => onAction(b.action));
      buttonsEl.append(btn);
    }
  }

  // status: { state, serial, model, connectionType, error }
  function render(status) {
    if (status.state === "streaming") {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const def = STATES[status.state] || STATES.idle;
    renderIcon(def.icon);
    titleEl.textContent = def.title(status);
    bodyEl.textContent = def.body(status);
    renderSteps(def.steps ? def.steps(status) : null);
    renderButtons(def.buttons);
  }

  return { element: el, render };
}
