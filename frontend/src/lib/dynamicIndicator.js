/**
 * What Zoom's Dynamic Indicator says for Arlo: a short status in Zoom's own
 * meeting window, visible to everyone in the meeting, also when the panel is closed.
 *
 * It only reflects confirmed state: transcription that the server confirmed
 * (phase 'active'), never a request. One client sets it, the one that started
 * the stream, so open panels do not fight over it.
 *
 * Basic version: text only. Colors, style and timers come with the design work.
 */
export const INDICATOR_TEXT = Object.freeze({
  transcribing: 'Arlo is transcribing',
  listening: 'Arlo is transcribing · Say "Hey Arlo"',
  thinking: 'Arlo is thinking…',
});

/** The text to show, or null for no indicator. */
export function indicatorText({ phase, startedHere, guest, voiceEnabled, voiceProcessing }) {
  if (phase !== 'active' || startedHere !== true || guest === true) return null;
  if (voiceEnabled && voiceProcessing) return INDICATOR_TEXT.thinking;
  return voiceEnabled ? INDICATOR_TEXT.listening : INDICATOR_TEXT.transcribing;
}
