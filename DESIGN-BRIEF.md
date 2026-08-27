# Mobile Live View — design brief

Context for designing the interface of an existing, working desktop application.
This describes what the product is, who uses it and what each screen has to do.
It deliberately does not describe how it should look.

## What the product is

A Windows desktop application that mirrors an Android phone onto the computer
and lets the person control it from there. The phone's screen appears live in
the app; clicking and dragging on that image drives the real device. Anything
done on screen happens on the physical phone, and the phone can be sitting on a
desk, in a drawer, or across the room.

It is built on the same underlying technology as scrcpy, and connects to the
phone either by USB cable or over Wi-Fi.

## Who uses it and why

Two distinct audiences, both of whom currently keep the app open for long
stretches alongside other work.

**People documenting or demonstrating a mobile app.** They step through a
mobile app screen by screen, capturing what each part does, often writing notes
or documentation on the same computer at the same time. They need to see the
phone clearly and switch between it and other windows constantly. Screenshots
of this app's window sometimes end up in the documentation they produce.

**People testing or supporting a mobile app.** They reproduce a problem, try a
build, or check behaviour on a specific device. They may have more than one
phone and switch between them during a session.

Neither audience is necessarily technically deep. They know what a phone is and
what an app is. Terms like "adb", "scrcpy", "mDNS" and "H.264" are
implementation details they should not have to learn.

## The essential constraint

A phone screen is tall and narrow. A computer monitor is wide and short. The
phone image is therefore always limited by the window's height, and there is
usually a large amount of unused width beside it. Every layout decision runs
into this. Making the phone image as large as possible matters, because people
are reading small text inside it.

## What the product does today

### Live view

The main screen. Shows the phone mirrored in real time. Clicking taps, dragging
swipes and scrolls, and clicking a text field brings up the phone's own
keyboard, which is then typed on by clicking its keys.

Alongside the phone image it currently offers:

- The phone's three hardware navigation keys: Back, Home, and Recent apps.
  These belong to the phone, not to this application.
- A fullscreen mode, which people use often because it makes the phone image
  meaningfully larger.
- A way to reach settings.
- A line of status text, currently showing the phone's screen resolution.

It also has states other than "working": no phone connected yet, connecting,
connection lost, and reconnecting. Today these are communicated only as a short
line of text, which is easy to miss.

### Settings

Where a phone is chosen and set up. It contains:

- A list of phones the computer can currently see. Each shows its model name,
  whether it is connected by USB or Wi-Fi, and its state: connected, available,
  offline, or awaiting permission on the phone itself. One phone at a time is
  the active one. Phones can be connected and disconnected from here, and the
  list can be refreshed.
- Three ways to connect a phone, of differing convenience:
  - **USB** — plug in a cable and accept a prompt on the phone. The most
    reliable, and unaffected by Wi-Fi problems.
  - **Wi-Fi via a scannable code** — the app displays a code, the person points
    their phone's camera at it, and the two connect. Nothing is typed.
  - **Wi-Fi via a typed code** — the phone displays an address and a six-digit
    number, which are typed into the app. A fallback for when the scannable
    code does not work on a particular network.

  Each of these requires the person to first find a specific screen in the
  phone's own settings, which is several levels deep and differently placed on
  different phones. The instructions are currently a paragraph of prose per
  method.
- The scannable-code flow has waiting, success, failure, and expiry states, and
  can take up to a few minutes while the person walks over to the phone.

### Adjustable behaviour, currently hidden

Three settings meaningfully change how the app performs, and are currently
editable only in a text configuration file, so in practice nobody changes them:

- Picture quality, traded against how far behind the live image runs.
- Frame smoothness, same trade.
- How much the phone image is scaled down before being sent, which is the
  single biggest factor in both.

The right value depends on the phone and the network, so people on a weak Wi-Fi
connection genuinely need to lower these, and people on a cable can raise them.

## Real conditions the design has to survive

These are not hypothetical. Each has happened repeatedly in use.

- **Wi-Fi connections drop without warning.** Android switches its wireless
  debugging off after the phone has been asleep for a while. The app keeps
  running and stays usable, but the phone silently disappears and has to be
  reconnected, sometimes repeatedly in one session.
- **A phone can be visible but not usable**, because a permission prompt is
  waiting on the phone itself, unnoticed, several feet away.
- **Connecting takes a few seconds**, and there are two distinct stages: the
  phone is attached, and then the picture actually starts.
- **Phones differ enormously.** One tested device is 720 pixels wide; another
  is 1440. The image's shape and size change when switching between them.
- **The person is often not holding the phone** while using this, so anything
  that requires touching the phone needs to say so clearly.

## Screens that exist today

1. **Live view** — the mirrored phone, its controls, and connection state.
2. **Settings** — device list, and the three connection methods.

Whether these remain two screens is open.

## Where it is heading

- Packaged as a proper installable Windows application, rather than something
  started from a terminal that opens a browser tab.
- Usable by someone who has never heard of the technology underneath.
