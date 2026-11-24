/**
 * Zoom's Collaborate mode, as far as Arlo uses it: the owner opens Arlo's
 * notes for everyone in the meeting. Zoom then opens the app for everyone who
 * has it, and shows the owner's app view as a screen share to people who
 * cannot join (no app, a browser client, account restrictions).
 *
 * None of this could be tried against a real Zoom client when it was written.
 * Everything that is taken from the reference and not seen working is in
 * COLLABORATE_GUESSES, the one place to correct after a real meeting:
 *
 *   runningContext   'inCollaborate': RunningContext "The app is running in
 *                    Collaborate mode." Not known: whether the panel that was
 *                    open changes to it in place (then onRunningContextChange
 *                    or onCollaborateChange tells), or Zoom loads the app
 *                    anew in the meeting window (then getRunningContext
 *                    answers it at start). Both are handled
 *                    (contexts/ZoomSdkContext.jsx). 'inCollaborateSidecar'
 *                    ("running in sidecar webview instance") is not taken
 *                    for it.
 *   asMeeting        Collaborate happens inside a meeting, so everything in
 *                    the panel that asks "are we in a meeting" is told
 *                    'inMeeting' while Zoom says 'inCollaborate', and the
 *                    meeting's id is read the same way (getMeetingUUID,
 *                    getMeetingContext). Not known: whether those two answer
 *                    in Collaborate.
 *   shareScreen      StartCollaborateOptions { shareScreen?: boolean },
 *                    default true: people who cannot join see the
 *                    initiator's app view. Passed as true all the same, so
 *                    the fallback does not hang on a default.
 *   alreadyStarted   error 10084 "The app is in collaborate mode." from
 *                    startCollaborate: read as "it is open for everyone".
 *                    Not known: whether the code arrives as `error.code`, as
 *                    a number or as text; both are read.
 *
 * Also from the reference, and not guessed around: startCollaborate is for
 * host, co-host and participant, not for guests (desktop 5.10.0, a
 * participant from 5.12.6); 10089 "This app cannot support collaborate mode."
 * (the feature is not switched on for the app in Marketplace) and 10090
 * "Collaboration isn't supported in webinar and breakout meeting." are plain
 * refusals. onCollaborateChange "fires on start, end, join, and leave" and
 * carries no state to rely on, so the running context is read again on it.
 */
export const COLLABORATE_GUESSES = Object.freeze({
  runningContext: 'inCollaborate',
  asMeeting: 'inMeeting',
  shareScreen: true,
  alreadyStarted: 10084,
});

/** Whether Zoom says this app instance runs in Collaborate mode. */
export const isInCollaborate = (runningContext) => runningContext === COLLABORATE_GUESSES.runningContext;

/**
 * The running context as the rest of the panel reads it: Collaborate is in a
 * meeting. Every other value is as Zoom gave it.
 */
export const meetingRunningContext = (runningContext) => (
  isInCollaborate(runningContext) ? COLLABORATE_GUESSES.asMeeting : runningContext
);

/** The context out of getRunningContext's answer ({ context } or the bare value), or null. */
export function readRunningContext(answer) {
  const value = answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer.context : answer;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Start Collaborate with the screen-share fallback. true when Zoom took it,
 * or says the app is in Collaborate already; false for every other outcome.
 * Never rejects, and logs nothing.
 */
export async function startCollaborateForEveryone(zoomSdk) {
  if (typeof zoomSdk?.startCollaborate !== 'function') return false;
  try {
    await zoomSdk.startCollaborate({ shareScreen: COLLABORATE_GUESSES.shareScreen });
    return true;
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : null;
    return String(code) === String(COLLABORATE_GUESSES.alreadyStarted);
  }
}
