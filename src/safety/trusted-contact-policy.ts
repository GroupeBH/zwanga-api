/** Product decision, 2026-10-06: manual sharing replaces automated relative messages.
 * Stored contacts are retained; SOS alerts and authentication OTP are not disabled.
 */
export function trustedContactMessagesEnabled(): boolean { return false; }
