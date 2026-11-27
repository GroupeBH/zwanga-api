'use strict';

// A terminal acknowledgement is a refused write. Independently recover committed
// state through the real authenticated gateway before stopping a synthetic client.
async function recoverTrackingState(socket, payload, timeoutMs) {
  const response = await socket.timeout(timeoutMs).emitWithAck('get_tracking_state',
    { tripId: payload.tripId, ...(payload.bookingId ? { bookingId: payload.bookingId } : {}) });
  const s = response?.state;
  if (response?.success !== true || s?.tripId !== payload.tripId ||
      (payload.bookingId ? s.bookingId !== payload.bookingId || s.bookingStatus !== 'completed' || !s.droppedOff
        : s.tripStatus !== 'completed')) throw new Error('Terminal tracking state not confirmed');
  return s;
}
module.exports = { recoverTrackingState };
