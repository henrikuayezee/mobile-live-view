# Mobile Live View

See and control an Android phone from your Windows PC: its screen live in a
window, with clicks, scrolling and typing sent back to the phone. Works over
Wi-Fi or a USB cable.

## Install

1. Download **`Mobile-Live-View-Setup-<version>.exe`** from the
   [latest release](../../releases/latest).
2. Run it. Windows will probably show **"Windows protected your PC"**, because
   the installer isn't code-signed. Click **More info → Run anyway**.
3. Open **Mobile Live View** from the Start menu.

Nothing else needs installing; everything the app needs is inside the
installer.

## Connect a phone

The phone needs **Developer options** turned on, once:
**Settings → About phone → Software information**, then tap **Build number**
seven times. (On some phones Build number is directly under About phone.)

Then click **Setup** (☰, bottom of the sidebar) in the app and pick one of:

- **By scanning a code (Wi-Fi, easiest).** The phone and PC must be on the same
  Wi-Fi network. On the phone, open **Developer options → Wireless debugging →
  Pair device with QR code**, click **Show the code** in the app, and point the
  phone at it.
- **With a cable (most reliable).** On the phone turn on **Developer options →
  USB debugging**, plug it in, and tap **Allow** on the prompt the phone shows.
- **By typing a code.** A fallback for networks where scanning doesn't work:
  use **Pair device with pairing code** on the phone and type what it shows
  into the app.

Pairing only happens once. After that the app reconnects to the phone by
itself. Android turns Wireless debugging off when the phone sleeps for a while,
so if the phone disappears from the list, switch it back on.

## Use it

- **Click or drag** on the phone's screen to tap and swipe.
- **Scroll** with your mouse wheel or touchpad.
- **Type** with the phone's own on-screen keyboard.
- The sidebar's **◀ ● ■** are Back, Home and Recent apps.
- **↻ Refresh** fixes a frozen or glitchy picture without reconnecting.
- **▢ Compact view** hides the sidebar and title bar and shrinks the window
  to fit the phone exactly. Point at the thin strip at the top to get the
  minimize/maximize/close buttons back.
- **↗ Open in browser** opens the same live view in your web browser
  (Chrome or Edge). The app minimizes itself and must stay open, since it's
  what the browser connects to. Once the app is running you can also just go
  to http://localhost:8000.
- **Phones** (📱) switches between paired phones. **Picture & speed** (⚙)
  trades sharpness for less delay. Pick "Weak Wi-Fi" if the picture lags.

One phone is shown at a time.

---

## For developers

### Run from source

Requires Node.js. `npm install` also downloads adb and the scrcpy server into
`vendor/` (if that fails offline, run `npm run fetch-adb` and
`npm run fetch-scrcpy-server` later).

- **In a browser:** double-click `launch.bat`, or `npm start` and open
  http://localhost:8000. A machine that only uses this route can run
  `npm install --omit=dev` to skip Electron (100 MB+).
- **As the desktop app:** `npm run electron`.
- **Build the installer:** `npm run dist`. Output goes to `dist/`. Building
  needs Windows Developer Mode turned on (electron-builder extracts files that
  contain symlinks).

The desktop app is a thin Electron shell (`electron/main.js`) that runs the
same server as `npm start` and shows it in a window.

### Configuration

Optional. Copy `.env.example` to `.env`:

- `ADB_PATH` / `ADB_FALLBACK_PATH`: use a specific adb. Normally unnecessary;
  the app finds a working one, falling back to the copy in `vendor/`.
- `WEB_PORT`: default 8000.
- `DEVICE_SERIAL`: always use this phone instead of the last one used.
- `VIDEO_BIT_RATE`, `MAX_FPS`, `MAX_SIZE`: stream quality defaults. The
  Picture & speed settings in the app override these.

### HTTP API

Everything the UI does is also available over HTTP, for scripts or tools like
Claude Code:

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
| `/api/refresh` | POST | — |
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

### Credits

Screen streaming uses the on-device server from
[scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0). The installer
bundles Google's Android platform-tools `adb`.
