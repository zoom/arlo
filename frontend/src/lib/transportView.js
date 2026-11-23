import {
  DENIED_MESSAGE, EXPIRED_MESSAGE, CONNECT_FAILED_MESSAGE, FAULT_MESSAGE, STALLED_MESSAGE, REQUEST_STATUS_OUTCOME,
} from './rtmsMachine';

/**
 * The machine's messages are written for the classic dashboard ("Start
 * transcription here"). The single-action Arlo screens have no Start button
 * and no "transcription": the action there is "Bring Arlo into this meeting",
 * "Ask the host to bring Arlo in" or "Bring Arlo back". This says the same
 * things for those screens. A message that is not listed (Zoom's own reason
 * for refusing a request, for one) is shown as it is.
 */
const ARLO_WORDING = new Map([
  [DENIED_MESSAGE, 'Arlo did not join. The host may have declined the request.'],
  [EXPIRED_MESSAGE, 'No answer from the host (Zoom cancels a request after 60 seconds). Try again.'],
  [CONNECT_FAILED_MESSAGE, 'Arlo could not connect to the meeting\'s transcript. Try again.'],
  [FAULT_MESSAGE, 'Arlo left because of a connection problem.'],
  [STALLED_MESSAGE, 'Zoom allows Arlo, but it has not joined yet. Try again.'],
  [REQUEST_STATUS_OUTCOME[1].message, 'Zoom declined the request to bring Arlo in.'],
  [REQUEST_STATUS_OUTCOME[2].message, 'Arlo can\'t join because the app owner is not in the meeting.'],
  [REQUEST_STATUS_OUTCOME[3].message, 'The host declined the request to bring Arlo in.'],
  [REQUEST_STATUS_OUTCOME[4].message, 'Arlo can\'t join: live transcripts are not enabled for this app\'s account (license expired or feature turned off).'],
  [REQUEST_STATUS_OUTCOME[5].message, 'Arlo can\'t join: no RTMS concurrency limit is set for this app\'s account.'],
  [REQUEST_STATUS_OUTCOME[6].message, 'Zoom\'s transcript server failed. Try again.'],
]);

/**
 * What the transcription bar shows for a given state: one place that decides
 * the label, the indicator, the buttons and the message, so the bar renders
 * the same everywhere it appears.
 *
 * state:     'not-started' | 'requesting' | 'starting' | 'waiting' | 'live' | 'paused'
 * indicator: 'none' | 'spinner' | 'live' | 'paused'
 * actions:   any of 'start' | 'pause' | 'resume' | 'stop', in display order
 *
 * wording:   'arlo' for the single-action Arlo screens (the message only; they
 *            write their own labels). Left out, the classic dashboard's wording.
 */
export function getTransportView({
  phase, active, paused, hasContent, waitingLong, secondsLeft, error, guest, wording,
}) {
  const state = paused
    ? 'paused'
    : active
      ? (hasContent ? 'live' : 'waiting')
      : phase === 'requested'
        ? 'requesting'
        : phase === 'starting' ? 'starting' : 'not-started';

  // Guests watch; only people who can control transcription see why a control failed.
  const said = wording === 'arlo' && error ? (ARLO_WORDING.get(error.message) || error.message) : error?.message;
  const message = !guest && error ? said : null;
  const view = { state, indicator: 'none', label: '', hint: null, message, actions: [], startLabel: 'Start Transcription' };

  switch (state) {
    case 'paused':
      view.indicator = 'paused';
      view.label = 'Paused';
      view.actions = ['resume', 'stop'];
      break;
    case 'live':
    case 'waiting':
      view.indicator = 'live';
      view.label = phase === 'interrupted'
        ? 'Reconnecting…'
        : (state === 'live' ? 'Transcribing' : 'Waiting for transcript...');
      view.actions = ['pause', 'stop'];
      break;
    case 'requesting':
      view.indicator = 'spinner';
      if (waitingLong) {
        view.label = `Waiting for host approval…${secondsLeft !== null && secondsLeft !== undefined ? ` ${secondsLeft}s` : ''}`;
        // Zoom does not tell the app when the host allows it, so the user can start again.
        view.hint = 'Has the host allowed Arlo?';
        view.actions = ['start'];
      } else {
        view.label = 'Requesting transcription…';
      }
      break;
    case 'starting':
      view.indicator = 'spinner';
      view.label = 'Starting transcription…';
      break;
    default:
      view.label = guest ? 'Waiting for host to start transcription...' : 'Transcription not started';
      view.actions = ['start'];
      // After a denial, an expiry or a stall the app can't tell whether the host has
      // allowed Arlo since, so it is a plain Start. A failure is "Try again".
      if (phase === 'failed') view.startLabel = 'Try again';
      // The stream ended because of a connection problem, not because someone stopped it
      if (phase === 'stopped' && error?.code === 'stream_fault') view.startLabel = 'Restart Transcription';
  }

  if (guest) {
    view.actions = [];
    view.hint = null;
  }
  return view;
}
