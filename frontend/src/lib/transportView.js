/**
 * What the transcription bar shows for a given state: one place that decides
 * the label, the indicator, the buttons and the message, so the bar renders
 * the same everywhere it appears.
 *
 * state:     'not-started' | 'requesting' | 'starting' | 'waiting' | 'live' | 'paused'
 * indicator: 'none' | 'spinner' | 'live' | 'paused'
 * actions:   any of 'start' | 'pause' | 'resume' | 'stop', in display order
 */
export function getTransportView({
  phase, active, paused, hasContent, waitingLong, secondsLeft, error, guest,
}) {
  const state = paused
    ? 'paused'
    : active
      ? (hasContent ? 'live' : 'waiting')
      : phase === 'requested'
        ? 'requesting'
        : phase === 'starting' ? 'starting' : 'not-started';

  // Guests watch; only people who can control transcription see why a control failed.
  const message = !guest && error ? error.message : null;
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
  }

  if (guest) {
    view.actions = [];
    view.hint = null;
  }
  return view;
}
