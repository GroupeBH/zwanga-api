'use strict';

// Read-only observation for the parent IPC channel; no auth/session mutation.
function registeredSocketReady(socket, sessions, room) {
  return Boolean(socket?.data?.userId && sessions.has(socket) && (!room || socket.rooms.has(room)));
}
module.exports = { registeredSocketReady };
