/**
 * RTMS (live transcription) state machine.
 *
 * Rule: a request is not a state. `callZoomApi('startRTMS')` resolving only
 * means Zoom accepted the request; the host can still decline it. The phase
 * changes only on a confirmed signal:
 *   - backend WebSocket `meeting.status` from the webhook  (source 'server')
 *   - a transcript line arriving
 *   - Zoom client `onRTMSStatusChange` / `getRTMSStatus`  (source 'sdk')
 *
 * Only the server (it receives the stream) or a transcript line proves the
 * stream is running. The Zoom client reports "started" as soon as the host
 * allows the app, before anything streams, so a client "started" is only
 * `starting`; if the stream does not follow, it becomes `stalled` and the
 * Start button returns.
 *
 * Phases:
 *   idle → requested → starting → active
 *   requested → denied | failed | expired,  starting → stalled
 *   active ⇄ paused, active → interrupted → active, active|paused → stopped
 *
 * `pending` is the request this client is waiting on ('start' | 'stop' |
 * 'pause' | 'resume'), `error` is { action, code, message } for the UI.
 */

export const initialRtmsState = Object.freeze({
  phase: 'idle',
  pending: null,
  error: null,
  waitingLong: false,
});

const ALREADY_RUNNING = '10308';
const NOT_RUNNING_PHASES = new Set(['idle', 'stopped', 'denied', 'failed', 'expired', 'stalled']);
const RUNNING_PHASES = new Set(['active', 'paused', 'interrupted']);

// What an accepted request implies on clients that get no status events.
const ASSUMED_PHASE = { stop: 'stopped', pause: 'paused', resume: 'active' };

const DENIED_MESSAGE = 'Transcription did not start. The host may have declined the request.';
const UNCONFIRMED_MESSAGE = 'Zoom did not confirm the request. Try again.';
const EXPIRED_MESSAGE = 'No answer from the host. Zoom cancels a request after 60 seconds.';

// Zoom `rtms.request_status` webhook codes that end a request. 7 and 8 are
// server maintenance notices, not outcomes, so they are not listed.
const REQUEST_STATUS_OUTCOME = {
  1: { phase: 'denied', message: 'Zoom denied the transcription request.' },
  2: { phase: 'failed', message: 'Transcription can\'t start because the app owner is not in the meeting.' },
  3: { phase: 'denied', message: 'The host declined the transcription request.' },
  4: { phase: 'failed', message: 'Transcription is not enabled for this app\'s account (license expired or feature turned off).' },
  5: { phase: 'failed', message: 'No RTMS concurrency limit is set for this app\'s account.' },
  6: { phase: 'failed', message: 'Zoom\'s transcription server failed. Request again.' },
};
const SERVER_FAILED = 6;
const STALLED_MESSAGE = 'Zoom allows transcription, but the stream has not started. Start it here, or use the Start button Zoom shows for Arlo.';

export const isRtmsActive = (state) => RUNNING_PHASES.has(state.phase);
export const isRtmsPaused = (state) => state.phase === 'paused';
export const isRtmsBusy = (state) => (
  state.pending !== null || state.phase === 'requested' || state.phase === 'starting'
);

const settled = (phase, error = null) => ({ phase, pending: null, error, waitingLong: false });

function onStatus(state, status, source) {
  switch (status) {
    case 'connecting':
      return NOT_RUNNING_PHASES.has(state.phase)
        ? { ...settled('requested'), pending: state.pending }
        : state;
    case 'started':
    case 'resumed': {
      // From the client this is a claim, not proof, unless the stream was
      // already confirmed (running, or paused and now resumed).
      const proven = source !== 'sdk' || RUNNING_PHASES.has(state.phase);
      if (!proven) return state.phase === 'starting' ? state : settled('starting');
      return state.phase === 'active' && state.pending === null && !state.error
        ? state
        : settled('active');
    }
    case 'paused':
      return settled('paused');
    case 'stopped':
      if (state.phase === 'requested') {
        // Only the Zoom client knows the request died. A webhook "stopped"
        // here is the previous stream ending late, not a denial.
        return source === 'sdk'
          ? settled('denied', { action: 'start', code: null, message: DENIED_MESSAGE })
          : state;
      }
      return RUNNING_PHASES.has(state.phase) || state.phase === 'starting' || state.phase === 'stalled'
        ? settled('stopped')
        : state;
    case 'interrupted':
      return RUNNING_PHASES.has(state.phase) ? { ...state, phase: 'interrupted' } : state;
    default:
      return state;
  }
}

export function rtmsReducer(state, event) {
  switch (event.type) {
    case 'REQUEST':
      if (event.action === 'start') {
        return { phase: 'requested', pending: 'start', error: null, waitingLong: false };
      }
      return { ...state, pending: event.action, error: null };

    case 'REQUEST_ACCEPTED': {
      const assumed = event.confirmsState ? ASSUMED_PHASE[event.action] : null;
      // A start is never assumed: the webhook or the first transcript line confirms it.
      return assumed ? settled(assumed) : state;
    }

    case 'REQUEST_FAILED': {
      if (event.action === 'start' && String(event.code) === ALREADY_RUNNING) {
        // Zoom says a stream exists; the server confirms whether it reaches us
        return settled('starting');
      }
      const error = {
        action: event.action,
        code: event.code ?? null,
        message: event.message || 'Zoom rejected the request.',
      };
      return event.action === 'start'
        ? settled('failed', error)
        : { ...state, pending: null, error };
    }

    case 'STATUS':
      return onStatus(state, event.status, event.source);

    case 'TRANSCRIPT':
      // Text is flowing, so the stream is up. Late lines after a pause don't count.
      return state.phase === 'paused' || state.phase === 'active' ? state : settled('active');

    case 'TIMEOUT':
      if (state.phase === 'requested') return { ...state, waitingLong: true };
      if (state.pending) {
        return {
          ...state,
          pending: null,
          error: { action: state.pending, code: null, message: UNCONFIRMED_MESSAGE },
        };
      }
      return state;

    case 'STALL':
      return state.phase === 'starting'
        ? settled('stalled', { action: 'start', code: 'stalled', message: STALLED_MESSAGE })
        : state;

    case 'EXPIRE':
      return state.phase === 'requested'
        ? settled('expired', { action: 'start', code: 'timeout', message: EXPIRED_MESSAGE })
        : state;

    case 'REQUEST_STATUS': {
      const outcome = REQUEST_STATUS_OUTCOME[event.status];
      if (!outcome) return state;
      // The webhook goes to everyone in the meeting: it only ends a request this
      // client is showing (or just gave up on), or a stream whose server died.
      const endsRequest = state.phase === 'requested' || state.phase === 'expired';
      const endsStream = event.status === SERVER_FAILED && RUNNING_PHASES.has(state.phase);
      return endsRequest || endsStream
        ? settled(outcome.phase, { action: 'start', code: event.status, message: outcome.message })
        : state;
    }

    case 'RESET':
      return initialRtmsState;

    default:
      return state;
  }
}

const WS_STATUS = {
  rtms_started: 'started',
  rtms_stopped: 'stopped',
  rtms_paused: 'paused',
  rtms_resumed: 'resumed',
  rtms_interrupted: 'interrupted',
};

/** Backend `meeting.status` value → machine status (null = not a stream state). */
export const statusFromWs = (wsStatus) => WS_STATUS[wsStatus] || null;

/** `getRTMSStatus().rtmsStatus` → the status to seed with (null = nothing running). */
export function statusFromRtmsStatusList(list) {
  if (!Array.isArray(list)) return null;
  const statuses = new Set(list.map((session) => session?.status));
  return ['started', 'paused', 'connecting'].find((s) => statuses.has(s)) || null;
}
