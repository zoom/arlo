/**
 * What Zoom's Dynamic Indicator says for Arlo: a short status in Zoom's own
 * meeting window, visible to everyone in the meeting, also when the panel is closed.
 *
 * It only reflects confirmed state: transcription that the server confirmed
 * (phase 'active') or a confirmed pause of it, never a request. One client
 * sets it, the one that started the stream, so open panels do not fight over it.
 *
 * indicatorState() is the whole rule: one state at a time, the first that
 * holds, each with a fixed text and a fixed style.
 *
 *   paused        this user's own stream is paused: this panel's phase is
 *                 'paused', or the server says so while this panel still
 *                 thinks it runs (`pausedOnServer`: paused with Zoom's own
 *                 controls, or another stream keeps the meeting running)
 *   waiting       this owner has a sheet of Arlo's open (`waiting`): something
 *                 Arlo was asked waits for their OK
 *   thinking      the server says Arlo is handling a request (`arlo.thinking`,
 *                 to owners), or a voice command of the classic dashboard runs
 *   did           for a few seconds after Arlo did something (`didTool`: the
 *                 tool of an action that ended as done), a sentence by tool
 *   transcribing  otherwise, in Zoom's own look
 *
 * Everyone in the meeting reads this, so no state carries anything of the
 * meeting: not who asked, not what was asked, not the step Arlo is at, not a
 * name. The table takes flags and a tool name and gives one of the sentences
 * below (INDICATOR_STRINGS); nothing else can be shown.
 *
 * Who sets the indicator and when it is removed do not depend on the state.
 */

/**
 * EVERYTHING HERE IS A GUESS about Zoom's API, which says only that the
 * colors are strings and `timer.start` is a number
 * (https://appssdk.zoom.us/types/ZoomSdkTypes.DynamicIndicatorOptions.html).
 * None of it was tried in a meeting. Correct it here and nowhere else.
 *
 *   colors               written as '#RRGGBB'. The indicator is drawn by Zoom,
 *                        not in this app's DOM, so the CSS variables of
 *                        index.css cannot be used: these are the same values,
 *                        copied (the token each one is, is named beside it).
 *                        Zoom's rule for the indicator: status cues and
 *                        timers, nothing bright or distracting, so the
 *                        backgrounds are the dark, quiet end of each color.
 *                        When Zoom refuses a call that has a style, the panel
 *                        sends text only from then on (hooks/useDynamicIndicator.js)
 *   timerStartPerMinute  `timer.start` is taken to be in seconds, so a minute
 *                        is 60 of them. If it is milliseconds: 60000; minutes: 1
 *   timerText            what the indicator says beside the countdown. Whether
 *                        a timer needs a text at all is not known
 *   timerEndGraceMs      how long after the countdown's end the panel waits
 *                        before it puts Arlo's status back, so the last second
 *                        and Zoom's notification are seen
 *   A text update is taken to cancel a running timer, so the panel that
 *   started one sends no status until it is over (lib/indicatorTimer.js).
 *   No limit on the text's length is documented; the longest sentence here
 *   has 37 characters.
 */
export const INDICATOR_GUESSES = Object.freeze({
  colors: Object.freeze({
    mutedText: '#A1A1AA', // --muted-foreground (dark)
    mutedBackground: '#27272A', // --muted (dark)
    mutedBorder: '#71717A', // --color-text-disabled (dark)
    accentText: '#FFFFFF', // --accent-foreground
    accentBackground: '#1E3A8A', // --color-accent-disabled (dark)
    accentBorder: '#60A5FA', // --accent (dark)
    successText: '#FFFFFF',
    successBackground: '#166534', // --color-success-dark
    successBorder: '#4ADE80', // --color-success (dark)
  }),
  timerStartPerMinute: 60,
  timerText: 'Timer',
  timerEndGraceMs: 1500,
});

const COLORS = INDICATOR_GUESSES.colors;

export const INDICATOR_TEXT = Object.freeze({
  transcribing: 'Arlo is transcribing',
  listening: 'Arlo is transcribing · Say "Hey Arlo"',
  thinking: 'Arlo is thinking…',
  waiting: 'Arlo is waiting for an OK',
  paused: 'Arlo is paused',
});

/**
 * What Arlo just did, by the tool of the action. Never who or what: "someone",
 * "a participant", "an issue". A tool that is not here has no such state (a
 * reaction is seen as it is; an answer or a summary is the asker's own; a
 * timer is on the indicator itself).
 */
export const DID_TEXT = Object.freeze({
  post_to_chat: 'Arlo posted to the chat',
  admit_from_waiting_room: 'Arlo let someone in',
  share_notes: 'Arlo shared the notes',
  invite_everyone: 'Arlo invited everyone to the notes',
  open_notes_for_everyone: 'Arlo opened the notes for everyone',
  mute_participant: 'Arlo muted a participant',
  open_issue: 'Arlo opened an issue',
});

const muted = { textColor: COLORS.mutedText, borderColor: COLORS.mutedBorder, backgroundColor: COLORS.mutedBackground };
const accent = { textColor: COLORS.accentText, borderColor: COLORS.accentBorder, backgroundColor: COLORS.accentBackground };
const success = { textColor: COLORS.successText, borderColor: COLORS.successBorder, backgroundColor: COLORS.successBackground };

/** The style of each state that has one: SetDynamicIndicatorStyleInput's four fields. Transcribing has none: Zoom's own look. */
export const INDICATOR_STYLES = Object.freeze({
  paused: Object.freeze({ ...muted, textStyle: 'italic' }),
  waiting: Object.freeze({ ...accent, textStyle: 'bold' }),
  thinking: Object.freeze({ ...accent }),
  did: Object.freeze({ ...success }),
});

/** Every text the indicator can show, the timer's included. */
export const INDICATOR_STRINGS = Object.freeze(new Set([
  ...Object.values(INDICATOR_TEXT), ...Object.values(DID_TEXT), INDICATOR_GUESSES.timerText,
]));

const didText = (tool) => (typeof tool === 'string' && Object.prototype.hasOwnProperty.call(DID_TEXT, tool) ? DID_TEXT[tool] : null);
/** Whether an action of this tool that was done is said on the indicator. */
export const hasDidText = (tool) => didText(tool) !== null;

/** The state to show: { key, text, style } (style null: Zoom's own look), or null for no indicator. */
export function indicatorState({
  phase, pausedOnServer = false, startedHere, guest, voiceEnabled, voiceProcessing, thinking = false, waiting = false, didTool = null,
} = {}) {
  if (startedHere !== true || guest === true) return null;
  if (phase === 'paused' || (phase === 'active' && pausedOnServer === true)) {
    return { key: 'paused', text: INDICATOR_TEXT.paused, style: INDICATOR_STYLES.paused };
  }
  if (phase !== 'active') return null;
  if (waiting === true) return { key: 'waiting', text: INDICATOR_TEXT.waiting, style: INDICATOR_STYLES.waiting };
  if (thinking === true || (voiceEnabled && voiceProcessing)) {
    return { key: 'thinking', text: INDICATOR_TEXT.thinking, style: INDICATOR_STYLES.thinking };
  }
  const did = didText(didTool);
  if (did !== null) return { key: 'did', text: did, style: INDICATOR_STYLES.did };
  return { key: 'transcribing', text: voiceEnabled ? INDICATOR_TEXT.listening : INDICATOR_TEXT.transcribing, style: null };
}

/** The text to show, or null for no indicator. */
export const indicatorText = (inputs) => indicatorState(inputs)?.text ?? null;
