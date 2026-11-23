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
  shouldRestartAfterFault,
  FAULT_RESTART_LIMIT,
  STREAM_FAULT,
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
    // media-only drop: the rtms service keeps its session and reconnects
    expect(statusFromWs('media_interrupted')).toBe('interrupted');
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

describe('a stream that drops and comes back', () => {
  const active = run([status('started', 'server')]);

  test('a media interruption shows as reconnecting and the next transcript line clears it', () => {
    const interrupted = rtmsReducer(active, status(statusFromWs('media_interrupted'), 'server'));
    expect(interrupted.phase).toBe('interrupted');
    expect(isRtmsActive(interrupted)).toBe(true);
    expect(rtmsReducer(interrupted, { type: 'TRANSCRIPT' }).phase).toBe('active');
  });

  test('an interruption that ends in a stop is stopped', () => {
    const interrupted = rtmsReducer(active, status('interrupted', 'server'));
    expect(rtmsReducer(interrupted, status('stopped', 'server')).phase).toBe('stopped');
  });
});

describe('a stream Zoom ended because of a connection problem', () => {
  const active = run([status('started', 'server')]);
  const faultStop = { type: 'STATUS', status: 'stopped', source: 'server', fault: true };

  test('is stopped, says why, and can be started again', () => {
    const state = rtmsReducer(active, faultStop);
    expect(state.phase).toBe('stopped');
    expect(state.error).toEqual({
      action: 'start', code: 'stream_fault', message: 'Transcription stopped because of a connection problem.',
    });
    expect(isRtmsActive(state)).toBe(false);
    expect(canStartRtms(state)).toBe(true);
  });

  test('also while the stream was shown as reconnecting', () => {
    const interrupted = rtmsReducer(active, status('interrupted', 'server'));
    expect(rtmsReducer(interrupted, faultStop).error.code).toBe('stream_fault');
  });

  test('an ordinary stop carries no error', () => {
    expect(rtmsReducer(active, status('stopped', 'server')).error).toBeNull();
    expect(rtmsReducer(active, { ...faultStop, fault: false }).error).toBeNull();
  });

  test('the reason is kept when the Zoom client reports the stop before the server does', () => {
    const stoppedByClient = rtmsReducer(active, status('stopped', 'sdk'));
    expect(stoppedByClient.error).toBeNull();
    expect(rtmsReducer(stoppedByClient, faultStop).error.code).toBe('stream_fault');
    // and the client's report after the server's does not erase it
    expect(run([faultStop, status('stopped', 'sdk')], active).error.code).toBe('stream_fault');
  });

  test('only the server can say a stop was a fault', () => {
    expect(rtmsReducer(active, { ...faultStop, source: 'sdk' }).error).toBeNull();
  });

  test('a late fault stop does not end a new request or touch an idle panel', () => {
    const requested = run([request('start')]);
    expect(rtmsReducer(requested, faultStop)).toBe(requested);
    expect(rtmsReducer(initialRtmsState, faultStop)).toBe(initialRtmsState);
  });

  test('starting again clears the message', () => {
    const state = run([faultStop, request('start')], active);
    expect(state.phase).toBe('requested');
    expect(state.error).toBeNull();
  });

  test('is restarted without a click only by the client that started it, a few times per meeting', () => {
    const fault = { phase: 'stopped', errorCode: 'stream_fault', startedHere: true, restarts: 0, guest: false };
    expect(shouldRestartAfterFault(fault)).toBe(true);
    expect(shouldRestartAfterFault({ ...fault, startedHere: false })).toBe(false);
    expect(shouldRestartAfterFault({ ...fault, guest: true })).toBe(false);
    expect(shouldRestartAfterFault({ ...fault, errorCode: null })).toBe(false);
    expect(shouldRestartAfterFault({ ...fault, phase: 'requested' })).toBe(false);
    expect(shouldRestartAfterFault({ ...fault, restarts: FAULT_RESTART_LIMIT - 1 })).toBe(true);
    expect(shouldRestartAfterFault({ ...fault, restarts: FAULT_RESTART_LIMIT })).toBe(false);
  });
});

describe('a pause or resume Zoom does not confirm, when the server already says what was asked for', () => {
  const live = rtmsReducer(initialRtmsState, { type: 'STATUS', status: 'started', source: 'server' });
  const paused = rtmsReducer(live, { type: 'STATUS', status: 'paused', source: 'server' });
  const ask = (from, action) => rtmsReducer(from, { type: 'REQUEST', action });

  test('an unconfirmed pause of a stream the server says is paused is paused, without an error', () => {
    const state = rtmsReducer(ask(live, 'pause'), { type: 'TIMEOUT', serverPaused: true });
    expect(state).toEqual({ phase: 'paused', pending: null, error: null, waitingLong: false });
  });

  test('an unconfirmed resume of a stream the server says is running is running, without an error', () => {
    const state = rtmsReducer(ask(paused, 'resume'), { type: 'TIMEOUT', serverPaused: false });
    expect(state).toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
  });

  test('a pause or resume Zoom refuses is treated the same way', () => {
    const refused = (action) => ({ type: 'REQUEST_FAILED', action, code: '10000', message: 'Already in that state' });
    expect(rtmsReducer(ask(live, 'pause'), { ...refused('pause'), serverPaused: true }))
      .toEqual({ phase: 'paused', pending: null, error: null, waitingLong: false });
    expect(rtmsReducer(ask(paused, 'resume'), { ...refused('resume'), serverPaused: false }))
      .toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
  });

  test('when the server does not agree, or has not said, the error is shown as before', () => {
    for (const serverPaused of [false, null, undefined]) {
      const state = rtmsReducer(ask(live, 'pause'), { type: 'TIMEOUT', serverPaused });
      expect(state.phase).toBe('active');
      expect(state.error.message).toBe('Zoom did not confirm the request. Try again.');
    }
    for (const serverPaused of [true, null, undefined]) {
      const state = rtmsReducer(ask(paused, 'resume'), { type: 'REQUEST_FAILED', action: 'resume', message: 'No', serverPaused });
      expect(state.phase).toBe('paused');
      expect(state.error.message).toBe('No');
    }
    // a stop is never taken as done from the pause state
    expect(rtmsReducer(ask(live, 'stop'), { type: 'TIMEOUT', serverPaused: true }).error.action).toBe('stop');
  });

  test('the server saying so after the error was shown takes the error away', () => {
    const failedPause = rtmsReducer(ask(live, 'pause'), { type: 'TIMEOUT' });
    expect(failedPause.error).not.toBeNull();
    expect(rtmsReducer(failedPause, { type: 'SERVER_PAUSE', paused: false })).toBe(failedPause);
    expect(rtmsReducer(failedPause, { type: 'SERVER_PAUSE', paused: true }))
      .toEqual({ phase: 'paused', pending: null, error: null, waitingLong: false });

    const failedResume = rtmsReducer(ask(paused, 'resume'), { type: 'TIMEOUT' });
    expect(rtmsReducer(failedResume, { type: 'SERVER_PAUSE', paused: true })).toBe(failedResume);
    expect(rtmsReducer(failedResume, { type: 'SERVER_PAUSE', paused: false }).phase).toBe('active');
    expect(rtmsReducer(failedResume, { type: 'SERVER_PAUSE', paused: false }).error).toBeNull();
  });

  test('the server\'s word changes nothing without such an error: not a running stream, not a request in flight, not another error', () => {
    for (const state of [live, paused, ask(live, 'pause'), ask(paused, 'resume'), initialRtmsState]) {
      expect(rtmsReducer(state, { type: 'SERVER_PAUSE', paused: true })).toBe(state);
      expect(rtmsReducer(state, { type: 'SERVER_PAUSE', paused: false })).toBe(state);
    }
    const failedStop = rtmsReducer(ask(live, 'stop'), { type: 'TIMEOUT' });
    expect(rtmsReducer(failedStop, { type: 'SERVER_PAUSE', paused: true })).toBe(failedStop);
  });
});

describe('a start of one\'s own while another person\'s stream runs', () => {
  const others = run([status('started')]); // someone else's stream, confirmed by the server
  const own = { type: 'REQUEST', action: 'start', alongside: true };
  const ownLive = { type: 'OWN_STREAM_LIVE' };
  const asked = run([own, accepted('start')], others);

  test('is a request like any other: not a running stream of one\'s own', () => {
    expect(asked.phase).toBe('requested');
    expect(asked.pending).toBe('start');
    expect(isRtmsActive(asked)).toBe(false);
  });

  test('the other stream\'s lines and statuses do not confirm it', () => {
    for (const event of [{ type: 'TRANSCRIPT' }, status('started'), status('resumed'), status('paused'), status('interrupted')]) {
      expect(rtmsReducer(asked, event)).toBe(asked);
    }
    const starting = rtmsReducer(asked, status('started', 'sdk'));
    expect(starting.phase).toBe('starting');
    expect(rtmsReducer(starting, { type: 'TRANSCRIPT' })).toBe(starting);
    expect(rtmsReducer(starting, status('started'))).toBe(starting);
  });

  test('the server saying this person\'s own stream is live confirms it', () => {
    expect(rtmsReducer(asked, ownLive)).toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
    const starting = rtmsReducer(asked, status('started', 'sdk'));
    expect(rtmsReducer(starting, ownLive)).toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
  });

  test('a long wait, and asking again, stay a request of one\'s own', () => {
    const long = rtmsReducer(asked, { type: 'TIMEOUT' });
    expect(long.waitingLong).toBe(true);
    expect(rtmsReducer(long, { type: 'TRANSCRIPT' })).toBe(long);
    const again = rtmsReducer(long, request('start'));
    expect(again.phase).toBe('requested');
    expect(rtmsReducer(again, { type: 'TRANSCRIPT' })).toBe(again);
  });

  test.each([
    ['declined (the Zoom client reports stopped)', status('stopped', 'sdk'), 'denied'],
    ['declined by the host (webhook)', { type: 'REQUEST_STATUS', status: 3 }, 'denied'],
    ['expired', { type: 'EXPIRE' }, 'expired'],
    ['refused by Zoom', failed('start', '10301', 'RTMS is not enabled'), 'failed'],
  ])('%s: the reason stays when the other stream\'s next line shows Arlo is still here', (name, event, phase) => {
    const ended = rtmsReducer(asked, event);
    expect(ended.phase).toBe(phase);
    expect(ended.error).not.toBeNull();
    for (const others of [{ type: 'TRANSCRIPT' }, status('started')]) {
      const after = rtmsReducer(ended, others);
      expect(after.phase).toBe('active');
      expect(after.pending).toBeNull();
      expect(after.error).toEqual(ended.error);
      // and further lines leave it there
      expect(rtmsReducer(after, { type: 'TRANSCRIPT' })).toBe(after);
    }
  });

  test('a stall keeps its reason too', () => {
    const stalled = run([status('started', 'sdk'), { type: 'STALL' }], asked);
    expect(stalled.phase).toBe('stalled');
    expect(rtmsReducer(stalled, { type: 'TRANSCRIPT' }).error).toEqual(stalled.error);
  });

  test('a new request clears the reason; one that is not beside another stream is confirmed by a line as before', () => {
    const ended = rtmsReducer(asked, { type: 'EXPIRE' });
    const again = rtmsReducer(ended, own);
    expect(again.error).toBeNull();
    expect(rtmsReducer(again, { type: 'TRANSCRIPT' })).toBe(again);
    const alone = rtmsReducer(ended, request('start'));
    expect(rtmsReducer(alone, { type: 'TRANSCRIPT' }).phase).toBe('active');
  });

  // The mark is what keeps this panel from counting the other person's stream
  // as one it started (Zoom's indicator, the restart after a fault, the chat notice).
  const endings = [
    ['Zoom says a stream already exists (10308), then nothing arrives', [failed('start', '10308', 'already running'), { type: 'STALL' }], 'stalled'],
    ['the Zoom client says started, then nothing arrives', [status('started', 'sdk'), { type: 'STALL' }], 'stalled'],
    ['declined', [{ type: 'REQUEST_STATUS', status: 3 }], 'denied'],
    ['expired', [{ type: 'EXPIRE' }], 'expired'],
    ['refused by Zoom', [failed('start', '10301', 'RTMS is not enabled')], 'failed'],
  ];

  test.each(endings)('%s: it stays a start beside another stream', (name, events, phase) => {
    const ended = run(events, asked);
    expect(ended.phase).toBe(phase);
    expect(ended.alongside).toBe(true);
  });

  test.each(endings)('%s: the other stream\'s lines and statuses settle the phase, and never make the stream this panel\'s', (name, events) => {
    const ended = run(events, asked);
    for (const first of [{ type: 'TRANSCRIPT' }, status('started'), status('resumed'), status('paused'), status('interrupted')]) {
      let state = rtmsReducer(ended, first);
      expect(isRtmsActive(state)).toBe(true);
      expect(state.alongside).toBe(true);
      // whatever the other stream does next
      for (const later of [status('paused'), { type: 'TRANSCRIPT' }, status('resumed'), status('interrupted'), status('started'), { type: 'TRANSCRIPT' }, { type: 'TIMEOUT' }]) {
        state = rtmsReducer(state, later);
        expect(state.alongside).toBe(true);
      }
      expect(state.phase).toBe('active');
    }
  });

  test('once settled by the other stream, only the server\'s word about one\'s own stream removes the mark', () => {
    const settledByOthers = run([{ type: 'EXPIRE' }, { type: 'TRANSCRIPT' }], asked);
    expect(settledByOthers).toMatchObject({ phase: 'active', alongside: true });
    const confirmed = rtmsReducer(settledByOthers, ownLive);
    expect(confirmed).toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
    // while the other stream is paused, the confirmation does not claim it runs
    const pausedByOthers = rtmsReducer(settledByOthers, status('paused'));
    expect(rtmsReducer(pausedByOthers, ownLive)).toEqual({ phase: 'paused', pending: null, error: null, waitingLong: false });
  });

  test('the other stream stopping, also by a fault, leaves the mark: the stream that ended was never this panel\'s', () => {
    const settledByOthers = run([failed('start', '10308', 'already running'), { type: 'STALL' }, { type: 'TRANSCRIPT' }], asked);
    const faulted = rtmsReducer(settledByOthers, { ...status('stopped'), fault: true });
    expect(faulted).toMatchObject({ phase: 'stopped', alongside: true });
    expect(faulted.error.code).toBe(STREAM_FAULT);
    // while the request still waits on Zoom's word, too
    const starting = rtmsReducer(asked, status('started', 'sdk'));
    expect(rtmsReducer(starting, { ...status('stopped'), fault: true })).toMatchObject({ phase: 'stopped', alongside: true });
    // the other stream coming back is still the other stream
    expect(rtmsReducer(faulted, status('started'))).toMatchObject({ phase: 'active', alongside: true });
    expect(rtmsReducer(faulted, { type: 'TRANSCRIPT' })).toMatchObject({ phase: 'active', alongside: true });
    // a start asked for with nothing else running is an ordinary one
    const alone = rtmsReducer(faulted, request('start'));
    expect(alone.alongside).toBeUndefined();
    expect(rtmsReducer(alone, { type: 'TRANSCRIPT' })).toEqual({ phase: 'active', pending: null, error: null, waitingLong: false });
    expect(rtmsReducer(faulted, { type: 'RESET' })).toEqual(initialRtmsState);
  });

  test('the server\'s word about one\'s own stream changes nothing without such a request', () => {
    for (const state of [initialRtmsState, others, run([request('start')])]) {
      expect(rtmsReducer(state, ownLive)).toBe(state);
    }
  });

  test('if every stream stops while it starts, it is stopped; a reset forgets it', () => {
    const starting = rtmsReducer(asked, status('started', 'sdk'));
    const stopped = rtmsReducer(starting, status('stopped'));
    expect(stopped.phase).toBe('stopped');
    expect(rtmsReducer(stopped, { type: 'TRANSCRIPT' }).error).toBeNull();
    expect(rtmsReducer(asked, { type: 'RESET' })).toEqual(initialRtmsState);
  });
});
