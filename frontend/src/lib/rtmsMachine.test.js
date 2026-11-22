import {
  initialRtmsState,
  rtmsReducer,
  isRtmsActive,
  isRtmsPaused,
  isRtmsBusy,
  statusFromWs,
  statusFromRtmsStatusList,
} from './rtmsMachine';

const run = (events, from = initialRtmsState) => events.reduce(rtmsReducer, from);

const request = (action) => ({ type: 'REQUEST', action });
const accepted = (action, confirmsState = false) => ({ type: 'REQUEST_ACCEPTED', action, confirmsState });
const failed = (action, code, message) => ({ type: 'REQUEST_FAILED', action, code, message });
const status = (value, source = 'sdk') => ({ type: 'STATUS', status: value, source });

describe('starting', () => {
  test('a start request is not an active transcription', () => {
    const state = run([request('start'), accepted('start')]);
    expect(state.phase).toBe('requested');
    expect(isRtmsActive(state)).toBe(false);
    expect(isRtmsBusy(state)).toBe(true);
  });

  test('becomes active only when Zoom confirms the stream started', () => {
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
    const state = run([request('start'), accepted('start'), status('stopped')]);
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

  test('error 10308 (already running) counts as active', () => {
    expect(run([request('start'), failed('start', '10308', 'already started')]).phase).toBe('active');
    expect(run([request('start'), failed('start', 10308, 'already started')]).phase).toBe('active');
  });

  test('retry after a denied or failed start clears the error', () => {
    const denied = run([request('start'), status('stopped')]);
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
