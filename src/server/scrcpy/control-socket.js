"use strict";

// Thin wrapper around the already-connected control TCP socket owned by
// ScrcpySession. No handshake bytes on this socket (see DesktopConnection
// .java — only the first-opened socket, video, gets the dummy byte/device
// name); it's immediately ready for encoded control messages.
class ControlSocket {
  constructor(socket) {
    this.socket = socket;
  }

  send(buf) {
    this.socket.write(buf);
  }
}

module.exports = { ControlSocket };
