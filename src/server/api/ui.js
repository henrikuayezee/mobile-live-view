"use strict";

const adb = require("../adb/adb");

const REMOTE_DUMP_PATH = "/sdcard/window_dump.xml";

// uiautomator refuses to dump while the screen is mid-animation, so a
// couple of quick retries make this far more reliable in practice than a
// single attempt right after a tap.
async function dumpXml(session, attempts = 3) {
  let lastErr = "unknown error";
  for (let i = 0; i < attempts; i++) {
    const dump = await adb.run(session.adbBinary, [
      "-s",
      session.serial,
      "shell",
      "uiautomator",
      "dump",
      REMOTE_DUMP_PATH,
    ], { timeout: 20000 });

    const combined = `${dump.stdout}${dump.stderr}`;
    if (combined.includes("UI hierchary dumped") || combined.includes("UI hierarchy dumped")) {
      const cat = await adb.run(
        session.adbBinary,
        ["-s", session.serial, "exec-out", "cat", REMOTE_DUMP_PATH],
        { encoding: "buffer", maxBuffer: 1024 * 1024 * 20, timeout: 20000 }
      );
      if (!cat.err) return cat.stdout.toString("utf8");
      lastErr = String(cat.stderr || cat.err.message);
    } else {
      lastErr = combined.trim() || "uiautomator produced no output";
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`uiautomator dump failed: ${lastErr}`);
}

function attr(node, name) {
  const m = node.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : "";
}

// Flattens the hierarchy into just the things worth aiming at, each with a
// precomputed centre point — so callers never do bounds arithmetic (the
// single easiest way to tap the wrong thing).
function parseElements(xml, { interactiveOnly = true } = {}) {
  const nodes = xml.match(/<node\b[^>]*\/?>/g) || [];
  const out = [];

  for (const node of nodes) {
    const bounds = attr(node, "bounds");
    const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!m) continue;
    const [x1, y1, x2, y2] = m.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue; // zero-area, never tappable

    const text = attr(node, "text");
    const desc = attr(node, "content-desc");
    const clickable = attr(node, "clickable") === "true";
    const label = text || desc;

    // Keep anything clickable, plus anything carrying a visible label:
    // Compose often puts the label on a child of the clickable parent, so
    // label-only nodes are how you find a control by its name.
    if (interactiveOnly && !clickable && !label) continue;

    out.push({
      text,
      contentDesc: desc,
      label,
      class: attr(node, "class"),
      resourceId: attr(node, "resource-id"),
      clickable,
      enabled: attr(node, "enabled") === "true",
      selected: attr(node, "selected") === "true",
      checked: attr(node, "checked") === "true",
      scrollable: attr(node, "scrollable") === "true",
      bounds: { x1, y1, x2, y2 },
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
      width: x2 - x1,
      height: y2 - y1,
    });
  }
  return out;
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Ranked so an exact label beats a substring, and a genuinely clickable
// node beats a bare label; ties go to the smallest element, which is the
// specific control rather than a container that happens to contain it.
function findElements(elements, query, { exact = false } = {}) {
  const q = norm(query);
  if (!q) return [];

  const scored = [];
  for (const el of elements) {
    const t = norm(el.text);
    const d = norm(el.contentDesc);
    let score = null;

    if (t === q || d === q) score = 0;
    else if (!exact && (t.includes(q) || d.includes(q))) score = 1;

    if (score === null) continue;
    scored.push({ el, score: score * 10 + (el.clickable ? 0 : 1) });
  }

  scored.sort((a, b) => a.score - b.score || a.el.width * a.el.height - b.el.width * b.el.height);
  return scored.map((s) => s.el);
}

// A label is often a non-clickable child of the real touch target, so the
// smallest clickable ancestor is what should actually be tapped.
function resolveTapTarget(elements, el) {
  if (el.clickable) return el;
  const containers = elements.filter(
    (c) =>
      c.clickable &&
      c.bounds.x1 <= el.bounds.x1 &&
      c.bounds.y1 <= el.bounds.y1 &&
      c.bounds.x2 >= el.bounds.x2 &&
      c.bounds.y2 >= el.bounds.y2
  );
  if (!containers.length) return el; // fall back to the label's own centre
  containers.sort((a, b) => a.width * a.height - b.width * b.height);
  return containers[0];
}

module.exports = { dumpXml, parseElements, findElements, resolveTapTarget };
