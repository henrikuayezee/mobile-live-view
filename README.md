# Mobile Live View

View and control an Android phone from your browser. Streams the device screen
live (H.264 via scrcpy's on-device server, decoded in-browser with WebCodecs)
and sends taps, swipes, typing, and hardware keys back to it.

## Running it

Double-click **`launch.bat`**. It installs dependencies and downloads the
scrcpy server component on first run, then starts the server and opens your
browser automatically.

The server runs in a minimized window titled "Mobile Live View Server" —
**close that window to stop it**. If it ever fails to start, that window
stays open with the error visible instead of closing instantly.

(`server.bat` is the helper `launch.bat` starts; you don't run it directly.)

Running it a second time won't start a duplicate; it just opens the browser
onto the instance that's already running.

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
  candidates and picks one that can actually see a device, so this is usually
  unnecessary.
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
