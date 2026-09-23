# Mobile Live View

View and control an Android phone from your browser. Streams the device screen
live (H.264 via scrcpy's on-device server, decoded in-browser with WebCodecs)
and sends taps, swipes, typing, and hardware keys back to it.

## Running it

Two ways to run the exact same app — same server, same UI code, just a
different shell around it. There's no separate "browser version" to keep in
sync; picking one doesn't require anything from the other.

**In a browser** — double-click **`launch.bat`**. It installs dependencies
and downloads the scrcpy server component on first run, then starts the
server and opens your browser automatically.

The server runs in a minimized window titled "Mobile Live View Server" —
**close that window to stop it**. If it ever fails to start, that window
stays open with the error visible instead of closing instantly.

(`server.bat` is the helper `launch.bat` starts; you don't run it directly.)

Running it a second time won't start a duplicate; it just opens the browser
onto the instance that's already running.

On a machine that will only ever use the browser route, skip installing
Electron's devDependencies (a 100MB+ download it doesn't need) by running
`npm install --omit=dev` instead of a plain `npm install` before the first
`launch.bat` run — everything above behaves identically either way.

**As a native Windows app** — `npm install` (full install, no `--omit=dev`),
then `npm run electron` to run it unpackaged, or `npm run dist` to build an
installable `.exe` (adds a real title bar with working window controls, and
a "compact view" button that snaps the window to the phone with no black
gutter around it — neither makes sense in a browser tab, which is why
they're Electron-only). See `electron/main.js` for how it forks the same
server this file describes.

## Connecting a phone

The app reconnects to the last device you used, if it's available. Otherwise
open **⚙ Settings** to pick one.

**Over USB:** enable Developer options → USB debugging, plug the phone in, and
accept the debugging prompt on the phone. It appears in Settings.

**Over Wi-Fi (no cable), easiest:** in Settings click **Show pairing QR code**,
then on the phone go to Developer options → Wireless debugging → "Pair device
with QR code" and scan it. The app discovers the phone and pairs automatically;
there is nothing to type.

**Over Wi-Fi, manual:** on the phone use "Pair device with pairing code"
instead, and enter the address and 6-digit code it shows into the pairing form
in Settings. Note that screen shows a *different* port from the main Wireless
debugging screen — use whichever is displayed alongside the code you are typing.

Pairing is a one-time step; afterwards the phone is discovered automatically
whenever it is on the same network. Android switches wireless debugging off
after the phone sleeps for a while, so if the device disappears from Settings,
re-enable it on the phone.

**Removing a phone:** click **Remove** on a Wi-Fi phone in Settings. It is
disconnected, hidden from the list, and no longer auto-reconnected; pairing it
again brings it back. The pairing itself is stored on the phone, so to stop it
connecting to this computer entirely, also remove the computer on the phone
under Wireless debugging → Paired devices. Phones on a USB cable can't be
removed — unplug them instead.

## Using it

- **Tap / drag** directly on the screen image.
- **◀ ● ▢** buttons in the side rail are Back, Home, and Recent apps.
- **Fullscreen** (the button, or press `F`) gives the biggest picture: the
  device image is limited by window *height*, so reclaiming the browser chrome
  and taskbar matters more than screen width.

## HTTP API

The same actions are available over HTTP, for scripting or driving the device
from tools like Claude Code:

| Endpoint | Method | Body |
|---|---|---|
| `/api/status` | GET | — |
| `/api/devices` | GET | — |
| `/api/devices/connect` | POST | `{"serial": "..."}` |
| `/api/devices/disconnect` | POST | — |
| `/api/devices/forget` | POST | `{"serial": "..."}` (Wi-Fi phones only) |
| `/api/devices/forgotten/clear` | POST | — |
| `/api/pair` | POST | `{"addr": "ip:port", "code": "123456"}` |
| `/api/pair/qr` | POST | — (returns a QR data URL) |
| `/api/pair/qr/status` | GET | — |
| `/api/pair/qr/cancel` | POST | — |
| `/api/device-info` | GET | — |
| `/api/screenshot` | GET | — (returns PNG) |
| `/api/tap` | POST | `{"x": 100, "y": 200}` |
| `/api/swipe` | POST | `{"x1":…, "y1":…, "x2":…, "y2":…, "durationMs":300}` |
| `/api/text` | POST | `{"text": "hello"}` |
| `/api/key` | POST | `{"keycode": 3}` |

Coordinates are in device pixels; `/api/device-info` reports the resolution.
Common keycodes: 3 = Home, 4 = Back, 66 = Enter, 67 = Backspace, 187 = Recents.

```bash
curl -X POST http://localhost:8000/api/tap \
  -H "Content-Type: application/json" -d '{"x":720,"y":1500}'
```

## Configuration

Optional — copy `.env.example` to `.env` to override defaults:

- `ADB_PATH` / `ADB_FALLBACK_PATH` — which adb binary to use. The app probes
  candidates and picks one that can actually see a device, falling all the
  way back to the copy `npm install` fetched into `vendor/` automatically —
  so this is only needed to point at a *specific* adb (e.g. one tied to a
  particular USB driver), not just to get one working at all.
- `WEB_PORT` — defaults to 8000.
- `DEVICE_SERIAL` — pin to one device instead of remembering the last used.
- `VIDEO_BIT_RATE` — encoder bitrate, default 16000000 (16 Mbps). scrcpy's own
  default is 8 Mbps, which looks soft on a high-resolution phone. Lower it if
  the stream lags over Wi-Fi.
- `MAX_FPS` / `MAX_SIZE` — cap frame rate, or downscale before encoding, to
  reduce bandwidth on a slow link.

## Requirements

Node.js (from nodejs.org) and a Chromium-based browser (Chrome or Edge) for
WebCodecs support.

adb does NOT need to be pre-installed for the browser route either: `npm
install`'s postinstall step fetches a copy of adb and the scrcpy server into
`vendor/` automatically, and the app finds it there with no `ADB_PATH` or
`.env` needed (see Configuration above). This repeats on every fresh clone —
moving to another computer just means `git clone` + `npm install` again, not
a manual adb install. If that fetch fails (offline install, flaky network),
it's a warning, not a failed install — run `npm run fetch-adb` and `npm run
fetch-scrcpy-server` by hand once you're online, or set `ADB_PATH` to an adb
you already have.

The Windows app doesn't need any of that either — it bundles its own adb and
the scrcpy server inside the installer, so a clean machine with no Node, no
Android SDK, and no adb works out of the box.
