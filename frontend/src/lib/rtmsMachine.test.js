import {
  initialRtmsState,
  rtmsReducer,
  isRtmsActive,
  isRtmsPaused,
  isRtmsBusy,
  statusFromWs,
  statusFromRtmsStatusList,
  statusFromPoll,
  shouldAutoRestart,
  canStartRtms,
} from './rtmsMachine';

const run = (events, from = initialRtmsState) => events.reduce(rtmsReducer, from);

const request = (action) => ({ type: 'REQUEST', action });
const accepted = (action, confirmsState = false) => ({ type: 'REQUEST_ACCEPTED', action, confirmsState });
const failed = (action, code, message) => ({ type: 'REQUEST_FAILED', action, code, message });
// 'server' = the backend that receives the stream; 'sdk' = the Zoom client's own status
const status = (value, source = 'server') => ({ type: 'STATUS', status: value, source });

describe('starting', () => {
  test('a start request is not an active transcription', () => {
    const state = run([request('start'), accepted('start')]);
    expect(state.phase).toBe('requested');
    expect(isRtmsActive(state)).toBe(false);
    expect(isRtmsBusy(state)).toBe(true);
  });

  test('becomes active only when the server confirms the stream started', () => {
    const state = run([request('start'), accepted('start'), status('started')]);
    expect(state.phase).toBe('active');
    expect(isRtmsActive(state)).toBe(true);
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('the backend webhook status also confirms a start (REST-started streams, other clients)', () => {
    const state = run([request('start'), status(statusFromWs('rtms_started'), 'server')]);
    expect(state.phase).toBe('active');
  });

  test('a transcript line confirms a start', () => {
    expect(run([request('start'), { type: 'TRANSCRIPT' }]).phase).toBe('active');
  });

  test('even without status events on this client, an accepted start stays requested', () => {
    expect(run([request('start'), accepted('start', true)]).phase).toBe('requested');
  });

  test('"connecting" from Zoom shows as requested on clients that did not click Start', () => {
    const state = run([status('connecting')]);
    expect(state.phase).toBe('requested');
    expect(isRtmsBusy(state)).toBe(true);
  });

  test('Zoom reporting "stopped" while a start is pending means it was denied', () => {
    const state = run([request('start'), accepted('start'), status('stopped', 'sdk')]);
    expect(state.phase).toBe('denied');
    expect(state.error.message).toMatch(/host/i);
    expect(isRtmsActive(state)).toBe(false);
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('a late webhook "stopped" from the previous stream does not deny a new start', () => {
    const state = run([request('start'), status('stopped', 'server')]);
    expect(state.phase).toBe('requested');
  });

  test('a start error is surfaced with its code, not swallowed', () => {
    const state = run([request('start'), failed('start', '10301', 'RTMS is not enabled')]);
    expect(state.phase).toBe('failed');
    expect(state.error).toEqual({ action: 'start', code: '10301', message: 'RTMS is not enabled' });
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('error 10308 (Zoom says already running) waits for the server like any client claim', () => {
    expect(run([request('start'), failed('start', '10308', 'already started')]).phase).toBe('starting');
    expect(run([request('start'), failed('start', 10308, 'already started')]).phase).toBe('starting');
  });

  test('retry after a denied or failed start clears the error', () => {
    const denied = run([request('start'), status('stopped', 'sdk')]);
    const retried = rtmsReducer(denied, request('start'));
    expect(retried.phase).toBe('requested');
    expect(retried.error).toBeNull();
  });

  test('after the timeout a pending start says it is still waiting, and stays requested', () => {
    const state = run([request('start'), accepted('start'), { type: 'TIMEOUT' }]);
    expect(state.phase).toBe('requested');
    expect(state.waitingLong).toBe(true);
    expect(run([status('started')], state).waitingLong).toBe(false);
  });
});

describe('pause, resume, stop', () => {
  const active = run([request('start'), status('started')]);

  test('an accepted pause is not paused until Zoom confirms', () => {
    const pending = run([request('pause'), accepted('pause')], active);
    expect(pending.phase).toBe('active');
    expect(isRtmsPaused(pending)).toBe(false);
    expect(isRtmsBusy(pending)).toBe(true);

    const paused = rtmsReducer(pending, status('paused'));
    expect(isRtmsPaused(paused)).toBe(true);
    expect(isRtmsActive(paused)).toBe(true); // stream still exists while paused
    expect(isRtmsBusy(paused)).toBe(false);
  });

  test('"resumed" returns a paused stream to active', () => {
    const state = run([status('paused'), request('resume'), accepted('resume'), status('resumed')], active);
    expect(state.phase).toBe('active');
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('an accepted stop is not stopped until Zoom confirms', () => {
    const pending = run([request('stop'), accepted('stop')], active);
    expect(isRtmsActive(pending)).toBe(true);
    const stopped = rtmsReducer(pending, status('stopped'));
    expect(stopped.phase).toBe('stopped');
    expect(isRtmsActive(stopped)).toBe(false);
    expect(stopped.error).toBeNull();
  });

  test('a failed pause keeps the stream active and reports why', () => {
    const state = run([request('pause'), failed('pause', '10309', 'not allowed')], active);
    expect(state.phase).toBe('active');
    expect(state.error).toEqual({ action: 'pause', code: '10309', message: 'not allowed' });
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('clients without status events fall back to the accepted request', () => {
    expect(run([request('pause'), accepted('pause', true)], active).phase).toBe('paused');
    expect(run([status('paused'), request('resume'), accepted('resume', true)], active).phase).toBe('active');
    expect(run([request('stop'), accepted('stop', true)], active).phase).toBe('stopped');
  });

  test('an unconfirmed pause/stop times out with an error instead of hanging', () => {
    const state = run([request('stop'), accepted('stop'), { type: 'TIMEOUT' }], active);
    expect(state.phase).toBe('active');
    expect(isRtmsBusy(state)).toBe(false);
    expect(state.error.action).toBe('stop');
  });

  test('late transcript lines do not un-pause or restart', () => {
    const paused = rtmsReducer(active, status('paused'));
    expect(rtmsReducer(paused, { type: 'TRANSCRIPT' }).phase).toBe('paused');
  });

  test('transcript lines on an active stream do not change state (no re-render per line)', () => {
    expect(rtmsReducer(active, { type: 'TRANSCRIPT' })).toBe(active);
  });
});

describe('interruptions and reset', () => {
  const active = run([status('started')]);

  test('an interrupted stream is shown as interrupted, then active again when it returns', () => {
    const interrupted = rtmsReducer(active, status(statusFromWs('rtms_interrupted'), 'server'));
    expect(interrupted.phase).toBe('interrupted');
    expect(isRtmsActive(interrupted)).toBe(true);
    expect(rtmsReducer(interrupted, status('started', 'server')).phase).toBe('active');
  });

  test('an interruption with no stream is ignored', () => {
    expect(run([status('interrupted', 'server')]).phase).toBe('idle');
  });

  test('"stopped" with nothing running stays idle', () => {
    expect(run([status('stopped')]).phase).toBe('idle');
  });

  test('leaving the meeting resets everything', () => {
    expect(rtmsReducer(active, { type: 'RESET' })).toEqual(initialRtmsState);
  });

  test('unknown events and statuses are ignored', () => {
    expect(rtmsReducer(active, { type: 'NOPE' })).toBe(active);
    expect(rtmsReducer(active, status(null))).toBe(active);
    expect(rtmsReducer(active, status('bogus'))).toBe(active);
  });
});

describe('status mapping', () => {
  test('maps backend WebSocket statuses', () => {
    expect(statusFromWs('rtms_started')).toBe('started');
    expect(statusFromWs('rtms_stopped')).toBe('stopped');
    expect(statusFromWs('rtms_paused')).toBe('paused');
    expect(statusFromWs('rtms_resumed')).toBe('resumed');
    expect(statusFromWs('rtms_interrupted')).toBe('interrupted');
    expect(statusFromWs('media_interrupted')).toBeNull();
    expect(statusFromWs(undefined)).toBeNull();
  });

  test('seeds from getRTMSStatus: a running session wins over finished ones', () => {
    const session = (s) => ({ rtmsSessionId: 'x', displayName: 'Arlo', status: s, timestamp: 1 });
    expect(statusFromRtmsStatusList([session('stopped'), session('started')])).toBe('started');
    expect(statusFromRtmsStatusList([session('paused'), session('stopped')])).toBe('paused');
    expect(statusFromRtmsStatusList([session('connecting')])).toBe('connecting');
    expect(statusFromRtmsStatusList([session('stopped')])).toBeNull();
    expect(statusFromRtmsStatusList([])).toBeNull();
    expect(statusFromRtmsStatusList(undefined)).toBeNull();
  });
});

describe('requests the host never answers, or denies', () => {
  const requested = run([request('start'), accepted('start')]);
  const requestStatus = (code) => ({ type: 'REQUEST_STATUS', status: code });

  test('a request expires instead of spinning forever, and can be requested again', () => {
    const expired = run([{ type: 'TIMEOUT' }, { type: 'EXPIRE' }], requested);
    expect(expired.phase).toBe('expired');
    expect(isRtmsBusy(expired)).toBe(false);
    expect(isRtmsActive(expired)).toBe(false);
    expect(expired.error.action).toBe('start');
    expect(expired.error.message).toMatch(/60 seconds/);

    const again = rtmsReducer(expired, request('start'));
    expect(again.phase).toBe('requested');
    expect(again.error).toBeNull();
  });

  test('expiry only applies to a pending request', () => {
    const active = run([status('started')], requested);
    expect(rtmsReducer(active, { type: 'EXPIRE' })).toBe(active);
    expect(rtmsReducer(initialRtmsState, { type: 'EXPIRE' })).toBe(initialRtmsState);
  });

  test('a start confirmed after the request expired still becomes active', () => {
    expect(run([{ type: 'EXPIRE' }, status('started', 'server')], requested).phase).toBe('active');
  });

  test('Zoom reporting "host denied" (request status 3) shows as denied by the host', () => {
    const state = rtmsReducer(requested, requestStatus(3));
    expect(state.phase).toBe('denied');
    expect(state.error.message).toMatch(/host declined/i);
    expect(state.error.code).toBe(3);
    expect(isRtmsBusy(state)).toBe(false);
  });

  test('a denial that arrives after the local expiry replaces the generic message', () => {
    const state = run([{ type: 'EXPIRE' }, requestStatus(3)], requested);
    expect(state.phase).toBe('denied');
    expect(state.error.message).toMatch(/host declined/i);
  });

  test.each([[1, 'denied'], [2, 'failed'], [4, 'failed'], [5, 'failed'], [6, 'failed']])(
    'request status %i ends the request as %s with a reason',
    (code, phase) => {
      const state = rtmsReducer(requested, requestStatus(code));
      expect(state.phase).toBe(phase);
      expect(state.error.message.length).toBeGreaterThan(10);
    },
  );

  test('server maintenance notices (7, 8) and unknown codes do not change state', () => {
    expect(rtmsReducer(requested, requestStatus(7))).toBe(requested);
    expect(rtmsReducer(requested, requestStatus(8))).toBe(requested);
    expect(rtmsReducer(requested, requestStatus(42))).toBe(requested);
  });

  test('a denial for someone else\'s request does not stop a running stream', () => {
    const active = run([status('started')], requested);
    expect(rtmsReducer(active, requestStatus(3))).toBe(active);
    expect(rtmsReducer(initialRtmsState, requestStatus(3))).toBe(initialRtmsState);
  });

  test('a server failure (6) ends a running stream as failed', () => {
    const active = run([status('started')], requested);
    expect(rtmsReducer(active, requestStatus(6)).phase).toBe('failed');
  });
});

describe('the Zoom client says "started" but no stream has reached the server', () => {
  // Seen in a meeting: host denies, later allows the app. The client status flips,
  // but nothing streams until someone actually starts it.
  const sdkStarted = status('started', 'sdk');

  test('a client-only "started" is starting, not active', () => {
    const state = run([sdkStarted]);
    expect(state.phase).toBe('starting');
    expect(isRtmsActive(state)).toBe(false);
    expect(isRtmsBusy(state)).toBe(true);
  });

  test('the same holds after a request, a denial or an expiry', () => {
    expect(run([request('start'), accepted('start'), sdkStarted]).phase).toBe('starting');
    expect(run([request('start'), { type: 'EXPIRE' }, sdkStarted]).phase).toBe('starting');
    expect(run([request('start'), { type: 'REQUEST_STATUS', status: 3 }, sdkStarted]).phase).toBe('starting');
  });

  test('the server status or a transcript line makes it active', () => {
    expect(run([sdkStarted, status('started', 'server')]).phase).toBe('active');
    expect(run([sdkStarted, { type: 'TRANSCRIPT' }]).phase).toBe('active');
  });

  test('if the stream never arrives, the Start button comes back with an explanation', () => {
    const stalled = run([sdkStarted, { type: 'STALL' }]);
    expect(stalled.phase).toBe('stalled');
    expect(isRtmsActive(stalled)).toBe(false);
    expect(isRtmsBusy(stalled)).toBe(false);
    expect(stalled.error.action).toBe('start');
    expect(stalled.error.message).toMatch(/has not started/i);

    expect(rtmsReducer(stalled, request('start')).phase).toBe('requested');
    expect(rtmsReducer(stalled, status('started', 'server')).phase).toBe('active');
  });

  test('STALL only applies while starting', () => {
    const active = run([status('started', 'server')]);
    expect(rtmsReducer(active, { type: 'STALL' })).toBe(active);
    expect(rtmsReducer(initialRtmsState, { type: 'STALL' })).toBe(initialRtmsState);
  });

  test('a client "started" does not downgrade a stream the server confirmed', () => {
    const active = run([status('started', 'server')]);
    expect(rtmsReducer(active, sdkStarted)).toBe(active);
  });

  test('a client "resumed" returns a paused stream to active (it was confirmed before)', () => {
    const paused = run([status('started', 'server'), status('paused', 'sdk')]);
    expect(rtmsReducer(paused, status('resumed', 'sdk')).phase).toBe('active');
  });

  test('a client "stopped" while starting or stalled returns to not started, without an error', () => {
    const fromStarting = run([sdkStarted, status('stopped', 'sdk')]);
    expect(fromStarting.phase).toBe('stopped');
    expect(fromStarting.error).toBeNull();
    expect(run([sdkStarted, { type: 'STALL' }, status('stopped', 'sdk')]).phase).toBe('stopped');
  });
});

describe('polling getRTMSStatus (the client sends no event when the host denies or later allows)', () => {
  const session = (s) => ({ rtmsSessionId: 'x', displayName: 'Arlo', status: s, timestamp: 1 });

  test('reports a session that is started or paused', () => {
    expect(statusFromPoll([session('stopped'), session('started')])).toBe('started');
    expect(statusFromPoll([session('paused')])).toBe('paused');
  });

  test('ignores connecting and stopped: a stale session must not restart or deny a request', () => {
    expect(statusFromPoll([session('connecting')])).toBeNull();
    expect(statusFromPoll([session('stopped')])).toBeNull();
    expect(statusFromPoll([])).toBeNull();
    expect(statusFromPoll(undefined)).toBeNull();
  });

  test('a polled "started" after an expired request brings the app out of the dead end', () => {
    const expired = run([request('start'), { type: 'EXPIRE' }]);
    const next = rtmsReducer(expired, status(statusFromPoll([session('started')]), 'sdk'));
    expect(next.phase).toBe('starting');
  });
});

describe('allowed by the host but not started (a refresh fixes it, so the app does that itself)', () => {
  // Seen in a meeting: after the host allows Arlo, reloading the panel starts
  // transcription, because the reload simply calls startRTMS again.
  const stuck = { phase: 'starting', wantsTranscription: true, alreadyRetried: false };

  test('asks Zoom to start again when the client says started but no stream arrived', () => {
    expect(shouldAutoRestart(stuck)).toBe(true);
  });

  test('only once per attempt, so a stream that never arrives cannot loop', () => {
    expect(shouldAutoRestart({ ...stuck, alreadyRetried: true })).toBe(false);
  });

  test('never for someone who did not ask for transcription', () => {
    expect(shouldAutoRestart({ ...stuck, wantsTranscription: false })).toBe(false);
  });

  test.each(['idle', 'requested', 'expired', 'denied', 'failed', 'stalled', 'stopped', 'active', 'paused'])(
    'never from %s (an expired or denied request must not re-prompt the host on its own)',
    (phase) => {
      expect(shouldAutoRestart({ ...stuck, phase })).toBe(false);
    },
  );
});

describe('Start stays available while waiting on the host', () => {
  // Seen in a meeting: the host denied, then allowed Arlo while the countdown was
  // still running. The client told the app nothing, so only the user can act.
  const requested = run([request('start'), accepted('start')]);
  const waiting = rtmsReducer(requested, { type: 'TIMEOUT' });

  test('a fresh request cannot be doubled by a second click', () => {
    expect(canStartRtms(requested)).toBe(false);
  });

  test('once it is clearly waiting on the host, the user may start again', () => {
    expect(canStartRtms(waiting)).toBe(true);
    const again = rtmsReducer(waiting, request('start'));
    expect(again.phase).toBe('requested');
    expect(again.waitingLong).toBe(false);
  });

  test('start is available when nothing is running and nothing is pending', () => {
    for (const phase of ['idle', 'stopped', 'denied', 'failed', 'expired', 'stalled']) {
      expect(canStartRtms({ ...initialRtmsState, phase })).toBe(true);
    }
  });

  test('start is not available while running, starting, or with another request pending', () => {
    for (const phase of ['active', 'paused', 'interrupted', 'starting']) {
      expect(canStartRtms({ ...initialRtmsState, phase })).toBe(false);
    }
    expect(canStartRtms({ ...initialRtmsState, phase: 'stopped', pending: 'stop' })).toBe(false);
  });
});

describe('Arlo could not connect to the stream Zoom started', () => {
  // Seen in the logs: rtms_started webhook, then the join was refused (status 16)
  // and Zoom stopped the stream a minute later.
  const failedStatus = status(statusFromWs('rtms_failed'), 'server');

  test('maps the backend status', () => {
    expect(statusFromWs('rtms_failed')).toBe('failed');
  });

  test.each(['requested', 'starting', 'active', 'expired'])('from %s it ends as failed with a reason and Start available', (phase) => {
    const state = rtmsReducer({ ...initialRtmsState, phase, pending: phase === 'requested' ? 'start' : null }, failedStatus);
    expect(state.phase).toBe('failed');
    expect(state.error.action).toBe('start');
    expect(state.error.message).toMatch(/could not connect/i);
    expect(isRtmsActive(state)).toBe(false);
    expect(canStartRtms(state)).toBe(true);
  });
});
