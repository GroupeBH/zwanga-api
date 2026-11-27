'use strict';

async function replayDelayedGps(row, timeoutMs) {
  if (!row.expected) throw new Error('A recent accepted position is required');
  const payload = { ...row.expected, recordedAt: new Date(Date.parse(row.expected.recordedAt) - 10000).toISOString() };
  for (const [socket, event, data] of [
    [row.driverSocket, 'driver_location_update', payload],
    [row.passengerSocket, 'passenger_location_update', { ...payload, bookingId: row.bookingId }],
  ]) {
    const ack = await socket.timeout(timeoutMs).emitWithAck(event, data);
    if (ack?.success !== true || ack.status !== 'superseded' || ack.tripId !== row.tripId ||
        ack.bookingId !== data.bookingId || ack.recordedAt !== data.recordedAt)
      throw new Error('Delayed GPS was not safely superseded');
  }
  return { replayed: 2, superseded: 2 };
}
module.exports = { replayDelayedGps };
