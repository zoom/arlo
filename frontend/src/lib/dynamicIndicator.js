/**
 * What Zoom's Dynamic Indicator says for Arlo: a short status in Zoom's own
 * meeting window, visible to everyone in the meeting, also when the panel is closed.
 *
 * It only reflects confirmed state: transcription that the server confirmed
 * (phase 'active') or a confirmed pause of it, never a request. One client
 * sets it, the one that started the stream, so open panels do not fight over it.
 *
 * Paused is about this user's own stream: this panel's phase is 'paused', or
 * the server says the stream is paused while this panel still thinks it runs
 * (`pausedOnServer`: it was paused with Zoom's own controls, or another
 * stream keeps the meeting running).
 *
 * Basic version: text only. Colors, style and timers come with the design work.
 */
export const INDICATOR_TEXT = Object.freeze({
  transcribing: 'Arlo is transcribing',
  listening: 'Arlo is transcribing · Say "Hey Arlo"',
  thinking: 'Arlo is thinking…',
  paused: 'Arlo is paused',
});

/** The text to show, or null for no indicator. */
export function indicatorText({
  phase, pausedOnServer = false, startedHere, guest, voiceEnabled, voiceProcessing,
}) {
  if (startedHere !== true || guest === true) return null;
  if (phase === 'paused' || (phase === 'active' && pausedOnServer === true)) return INDICATOR_TEXT.paused;
  if (phase !== 'active') return null;
  if (voiceEnabled && voiceProcessing) return INDICATOR_TEXT.thinking;
  return voiceEnabled ? INDICATOR_TEXT.listening : INDICATOR_TEXT.transcribing;
}
