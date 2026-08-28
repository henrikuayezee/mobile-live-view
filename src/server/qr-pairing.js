"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const adb = require("./adb/adb");
const { resolveAdbBinary } = require("./adb/locate-adb");

// Android's "Pair device with QR code" flow:
//   1. We show a QR encoding  WIFI:T:ADB;S:<name>;P:<password>;;
//   2. The phone scans it and starts advertising an mDNS pairing service
//      (_adb-tls-pairing._tcp) whose service name is the <name> we chose.
//   3. We spot that service via `adb mdns services`, and pair against its
//      host:port using the <password> we generated.
// The user never types anything.

const POLL_INTERVAL_MS = 1000;
const SESSION_TIMEOUT_MS = 3 * 60 * 1000; // QR advertisements are short-lived

// Base64url without padding: safe inside the QR's semicolon-delimited
// format, which would otherwise break on "=" or ";".
function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

class QrPairingSession {
  constructor() {
    this.name = `mlv-${randomToken(4)}`;
    this.password = randomToken(9);
    this.state = "waiting"; // waiting | paired | failed | cancelled | timeout
    this.message = "Waiting for the phone to scan the code...";
    this.pairedAddress = null;
    this.startedAt = Date.now();
    this._timer = null;
    // Resolved once, not per tick: probing adb candidates spawns several
    // subprocesses, which at a 1s interval made discovery lag badly.
    this._adbBinary = null;
    this._seenServices = [];
  }

  qrPayload() {
    return `WIFI:T:ADB;S:${this.name};P:${this.password};;`;
  }

  async qrDataUrl() {
    return QRCode.toDataURL(this.qrPayload(), {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    });
  }

  start() {
    const tick = async () => {
      if (this.state !== "waiting") return;

      if (Date.now() - this.startedAt > SESSION_TIMEOUT_MS) {
        this.state = "timeout";
        this.message = "Pairing timed out. Generate a new code and try again.";
        return;
      }

      try {
        if (!this._adbBinary) {
          this._adbBinary = (await resolveAdbBinary()).adbBinary;
        }
        const services = await adb.mdnsServices(this._adbBinary);
        this._seenServices = services.map((s) => `${s.name} ${s.type} ${s.address}`);

        const pairing = services.filter((s) => s.isPairing);
        if (pairing.length) {
          console.log("[qr-pair] pairing services visible:", pairing.map((p) => p.name).join(", "));
        }

        // Prefer our exact service name, but fall back to ANY pairing
        // advertisement: some Android builds advertise a name that does
        // not echo back the one encoded in the QR, in which case an exact
        // match would never fire.
        const match =
          services.find((s) => s.isPairing && s.name === this.name) || pairing[0];

        if (match) {
          this.message = "Phone found, pairing...";
          try {
            await adb.pair(this._adbBinary, match.address, this.password);
            this.state = "paired";
            this.pairedAddress = match.address;
            this.message = `Paired with ${match.address}.`;
            return;
          } catch (e) {
            // The advertisement can appear a moment before the phone is
            // ready to accept the pairing, so a single failure isn't
            // fatal — keep polling until the session times out.
            this.message = `Pairing attempt failed, retrying... (${e.message})`;
          }
        }
      } catch (e) {
        this.message = `Discovery error, retrying... (${e.message})`;
      }

      this._timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    this._timer = setTimeout(tick, POLL_INTERVAL_MS);
    return this;
  }

  cancel() {
    if (this._timer) clearTimeout(this._timer);
    if (this.state === "waiting") {
      this.state = "cancelled";
      this.message = "Pairing cancelled.";
    }
  }

  status() {
    return {
      state: this.state,
      message: this.message,
      pairedAddress: this.pairedAddress,
      expiresInMs: Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - this.startedAt)),
      // Surfaced for troubleshooting: if this stays empty while the phone
      // is showing its QR scanner, mDNS discovery is the problem, not the
      // pairing step.
      discovered: this._seenServices,
    };
  }
}

// Only one pairing session at a time — two concurrent QR codes would race
// over the same mDNS namespace and confuse which password to use.
let active = null;

async function startSession() {
  if (active) active.cancel();
  active = new QrPairingSession().start();
  return { qr: await active.qrDataUrl(), ...active.status() };
}

function getStatus() {
  if (!active) return { state: "none", message: "No pairing in progress." };
  return active.status();
}

function cancelSession() {
  if (active) active.cancel();
  active = null;
}

module.exports = { startSession, getStatus, cancelSession };
