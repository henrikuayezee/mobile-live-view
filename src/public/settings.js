"use strict";

const listEl = document.getElementById("device-list");
const statusEl = document.getElementById("current-status");
const pairResultEl = document.getElementById("pair-result");

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function stateLabel(device) {
  if (device.isCurrent) return "connected";
  if (device.state === "unauthorized") return "unauthorized - check your phone";
  if (device.state === "offline") return "offline";
  if (device.state === "available") return "available (not connected)";
  return device.state;
}

async function refresh() {
  listEl.innerHTML = "";
  statusEl.textContent = "Loading...";
  try {
    const [{ devices }, status] = await Promise.all([
      api("/api/devices"),
      api("/api/status"),
    ]);

    statusEl.textContent = status.connected
      ? `Connected to ${status.serial}${status.ready ? "" : " (starting stream...)"}`
      : "No device connected";

    if (!devices.length) {
      listEl.innerHTML =
        '<li class="empty">No devices found. Connect one over USB, or pair a wireless device below.</li>';
      return;
    }

    for (const device of devices) {
      const li = document.createElement("li");
      li.className = "device" + (device.isCurrent ? " current" : "");

      const info = document.createElement("div");
      info.className = "device-info";
      const name = document.createElement("div");
      name.className = "device-name";
      name.textContent = device.model || device.discoveredName || device.serial;
      const meta = document.createElement("div");
      meta.className = "device-meta";
      meta.textContent = `${device.connectionType} - ${stateLabel(device)}`;
      info.append(name, meta);

      const button = document.createElement("button");
      if (device.isCurrent) {
        button.textContent = "Disconnect";
        button.className = "secondary";
        button.onclick = () => act(button, () => api("/api/devices/disconnect", { method: "POST" }));
      } else {
        button.textContent = "Connect";
        button.disabled = device.state !== "device" && device.state !== "available";
        button.onclick = () =>
          act(button, () =>
            api("/api/devices/connect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serial: device.serial }),
            })
          );
      }

      li.append(info, button);
      listEl.append(li);
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

// Disables the button while the request is in flight - connecting takes a
// few seconds, and the server rejects overlapping device operations.
async function act(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  try {
    await fn();
    await refresh();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    button.disabled = false;
    button.textContent = original;
  }
}

document.getElementById("refresh").onclick = refresh;

// --- Manual code pairing ---

document.getElementById("pair-btn").onclick = async (e) => {
  const addr = document.getElementById("pair-addr").value.trim();
  const code = document.getElementById("pair-code").value.trim();
  if (!addr || !code) {
    pairResultEl.textContent = "Enter both the pairing address and the code.";
    return;
  }
  const button = e.target;
  button.disabled = true;
  pairResultEl.textContent = "Pairing...";
  try {
    const { output } = await api("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr, code }),
    });
    pairResultEl.textContent = output || "Paired successfully.";
    document.getElementById("pair-addr").value = "";
    document.getElementById("pair-code").value = "";
    await refresh();
  } catch (err) {
    pairResultEl.textContent = `Pairing failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
};

// --- QR pairing ---
// The server polls mDNS for the phone's pairing advertisement and pairs
// automatically; this just shows the code and reflects that progress.

const qrStartBtn = document.getElementById("qr-start");
const qrBox = document.getElementById("qr-box");
const qrImg = document.getElementById("qr-img");
const qrStatus = document.getElementById("qr-status");
let qrPollTimer = null;

function stopQrPolling() {
  if (qrPollTimer) clearInterval(qrPollTimer);
  qrPollTimer = null;
}

let qrTicks = 0;

async function pollQrStatus() {
  try {
    const s = await api("/api/pair/qr/status");
    qrTicks++;
    qrStatus.textContent = s.message || s.state;

    // If nothing pairing-related shows up after a while, the bottleneck is
    // mDNS discovery rather than the pairing step itself. Say so, instead
    // of leaving the user staring at "waiting".
    if (s.state === "waiting" && qrTicks > 12) {
      const anyPairing = (s.discovered || []).some((d) => d.includes("pairing"));
      if (!anyPairing) {
        qrStatus.textContent =
          "Still waiting. If the phone's scanner is open and nothing happens, " +
          "mDNS discovery may be blocked on this network - use the code method below instead.";
      }
    }

    if (s.state === "paired") {
      stopQrPolling();
      qrStatus.textContent = `${s.message} You can now connect it above.`;
      qrStartBtn.disabled = false;
      await refresh();
    } else if (["timeout", "failed", "cancelled", "none"].includes(s.state)) {
      stopQrPolling();
      qrStartBtn.disabled = false;
    }
  } catch (e) {
    qrStatus.textContent = `Error: ${e.message}`;
  }
}

qrStartBtn.onclick = async () => {
  qrStartBtn.disabled = true;
  qrStatus.textContent = "Generating code...";
  try {
    const s = await api("/api/pair/qr", { method: "POST" });
    qrImg.src = s.qr;
    qrBox.hidden = false;
    qrStatus.textContent = s.message;
    stopQrPolling();
    qrTicks = 0;
    qrPollTimer = setInterval(pollQrStatus, 1200);
  } catch (e) {
    qrStatus.textContent = `Could not start pairing: ${e.message}`;
    qrStartBtn.disabled = false;
  }
};

document.getElementById("qr-cancel").onclick = async () => {
  stopQrPolling();
  qrBox.hidden = true;
  qrStartBtn.disabled = false;
  try {
    await api("/api/pair/qr/cancel", { method: "POST" });
  } catch (_) {
    // Cancelling is best-effort; the session times out on its own anyway.
  }
};

// Don't leave the server polling mDNS after the page goes away.
window.addEventListener("beforeunload", () => {
  if (qrPollTimer) navigator.sendBeacon("/api/pair/qr/cancel");
});

refresh();
