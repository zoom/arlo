/**
 * Is this socket message for my meeting?
 *
 * The server can deliver another meeting's messages on a panel's socket (it
 * registers an owner's sockets under their other meeting too), and every
 * message it sends about a meeting carries `data.meetingId`
 * (backend/src/services/websocket.js). Every socket listener in the panel
 * asks here, with the meeting id the server verified for this panel
 * (MeetingContext `verifiedMeetingId`), never the id read from the Zoom SDK.
 *
 * Without a verified id nothing is for this panel.
 */
export function isForMeeting(message, meetingId) {
  if (typeof meetingId !== 'string' || meetingId.length === 0) return false;
  const data = message?.data;
  return data !== null && typeof data === 'object' && data.meetingId === meetingId;
}

/**
 * The parsed message of a socket `message` event when it is for `meetingId`;
 * null for anything else (not JSON, no data, another meeting, no verified id).
 */
export function readMeetingMessage(event, meetingId) {
  let message;
  try {
    message = JSON.parse(event?.data);
  } catch {
    return null;
  }
  if (message === null || typeof message !== 'object') return null;
  return isForMeeting(message, meetingId) ? message : null;
}
