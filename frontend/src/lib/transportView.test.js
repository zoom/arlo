import { getTransportView } from './transportView';
import { initialRtmsState, rtmsReducer } from './rtmsMachine';

const base = {
  phase: 'idle', active: false, paused: false, busy: false, hasContent: false,
  waitingLong: false, secondsLeft: null, error: null, guest: false,
};
const view = (overrides) => getTransportView({ ...base, ...overrides });

describe('getTransportView', () => {
  test('not started: says so and offers Start', () => {
    const v = view({});
    expect(v.state).toBe('not-started');
    expect(v.label).toBe('Transcription not started');
    expect(v.indicator).toBe('none');
    expect(v.actions).toEqual(['start']);
    expect(v.startLabel).toBe('Start Transcription');
  });

  test('requested: spinner, no controls until it is clearly waiting on the host', () => {
    const v = view({ phase: 'requested', busy: true });
    expect(v.state).toBe('requesting');
    expect(v.label).toBe('Requesting transcription…');
    expect(v.indicator).toBe('spinner');
    expect(v.actions).toEqual([]);
  });

  test('waiting on the host: countdown, a hint and Start (Zoom does not say when the host allows it)', () => {
    const v = view({ phase: 'requested', busy: true, waitingLong: true, secondsLeft: 42 });
    expect(v.label).toBe('Waiting for host approval… 42s');
    expect(v.hint).toBe('Has the host allowed Arlo?');
    expect(v.actions).toEqual(['start']);
  });

  test('starting: the client says started, the stream has not arrived', () => {
    const v = view({ phase: 'starting', busy: true });
    expect(v.state).toBe('starting');
    expect(v.label).toBe('Starting transcription…');
    expect(v.actions).toEqual([]);
  });

  test('stream is up but nobody has spoken', () => {
    const v = view({ phase: 'active', active: true });
    expect(v.state).toBe('waiting');
    expect(v.label).toBe('Waiting for transcript...');
    expect(v.indicator).toBe('live');
    expect(v.actions).toEqual(['pause', 'stop']);
  });

  test('live', () => {
    const v = view({ phase: 'active', active: true, hasContent: true });
    expect(v.state).toBe('live');
    expect(v.label).toBe('Transcribing');
    expect(v.actions).toEqual(['pause', 'stop']);
  });

  test('a stream that ended by a fault: the reason and a Restart button', () => {
    const error = { action: 'start', code: 'stream_fault', message: 'Transcription stopped because of a connection problem.' };
    const v = view({ phase: 'stopped', error });
    expect(v.state).toBe('not-started');
    expect(v.message).toBe('Transcription stopped because of a connection problem.');
    expect(v.actions).toEqual(['start']);
    expect(v.startLabel).toBe('Restart Transcription');
    expect(view({ phase: 'stopped' }).startLabel).toBe('Start Transcription');
    expect(view({ phase: 'stopped', error, guest: true }).actions).toEqual([]);
  });

  test('interrupted stream shows as reconnecting', () => {
    expect(view({ phase: 'interrupted', active: true, hasContent: true }).label).toBe('Reconnecting…');
  });

  test('paused', () => {
    const v = view({ phase: 'paused', active: true, paused: true, hasContent: true });
    expect(v.state).toBe('paused');
    expect(v.label).toBe('Paused');
    expect(v.indicator).toBe('paused');
    expect(v.actions).toEqual(['resume', 'stop']);
  });

  test('a denied or expired start shows the reason and a plain Start', () => {
    const v = view({ phase: 'denied', error: { action: 'start', message: 'The host declined the transcription request.' } });
    expect(v.state).toBe('not-started');
    expect(v.message).toBe('The host declined the transcription request.');
    expect(v.startLabel).toBe('Start Transcription');
  });

  test('a failed start offers Try again', () => {
    const v = view({ phase: 'failed', error: { action: 'start', message: 'RTMS is not enabled' } });
    expect(v.message).toBe('RTMS is not enabled');
    expect(v.startLabel).toBe('Try again');
  });

  test('a rejected pause keeps the stream state and shows why', () => {
    const v = view({ phase: 'active', active: true, hasContent: true, error: { action: 'pause', message: 'Not allowed' } });
    expect(v.state).toBe('live');
    expect(v.message).toBe('Not allowed');
  });

  test('guests see the state but never controls', () => {
    expect(view({ guest: true }).actions).toEqual([]);
    expect(view({ guest: true }).label).toBe('Waiting for host to start transcription...');
    expect(view({ guest: true, phase: 'active', active: true, hasContent: true }).actions).toEqual([]);
    expect(view({ guest: true, phase: 'denied', error: { action: 'start', message: 'x' } }).message).toBeNull();
    expect(view({ guest: true, phase: 'requested', busy: true, waitingLong: true, secondsLeft: 9 }).hint).toBeNull();
  });
});

// The single-action Arlo screens have no "Start" button and no "transcription":
// the action there is "Bring Arlo into this meeting" or "Ask the host to bring
// Arlo in". The classic dashboard keeps its own wording.
describe('wording for the Arlo screens', () => {
  const run = (...events) => events.reduce(rtmsReducer, initialRtmsState);
  const requested = { type: 'REQUEST', action: 'start' };
  const active = { type: 'STATUS', status: 'started', source: 'server' };
  const sdkStarted = { type: 'STATUS', status: 'started', source: 'sdk' };
  const requestStatus = (status) => run(requested, { type: 'REQUEST_STATUS', status });

  const cases = [
    ['the host may have declined', run(requested, { type: 'STATUS', status: 'stopped', source: 'sdk' }), 'Arlo did not join. The host may have declined the request.'],
    ['no answer in 60 seconds', run(requested, { type: 'EXPIRE' }), 'No answer from the host (Zoom cancels a request after 60 seconds). Try again.'],
    ['Zoom denied', requestStatus(1), 'Zoom declined the request to bring Arlo in.'],
    ['app owner not in the meeting', requestStatus(2), 'Arlo can\'t join because the app owner is not in the meeting.'],
    ['the host declined', requestStatus(3), 'The host declined the request to bring Arlo in.'],
    ['not enabled for the account', requestStatus(4), 'Arlo can\'t join: live transcripts are not enabled for this app\'s account (license expired or feature turned off).'],
    ['no concurrency limit', requestStatus(5), 'Arlo can\'t join: no RTMS concurrency limit is set for this app\'s account.'],
    ['Zoom\'s server failed', requestStatus(6), 'Zoom\'s transcript server failed. Try again.'],
    ['Arlo could not join the stream', run(requested, { type: 'STATUS', status: 'failed', source: 'server' }), 'Arlo could not connect to the meeting\'s transcript. Try again.'],
    ['a stream fault', run(active, { type: 'STATUS', status: 'stopped', source: 'server', fault: true }), 'Arlo left because of a connection problem.'],
    ['allowed but nothing streams', run(sdkStarted, { type: 'STALL' }), 'Zoom allows Arlo, but it has not joined yet. Try again.'],
    ['an unconfirmed control', run(active, { type: 'REQUEST', action: 'pause' }, { type: 'TIMEOUT' }), 'Zoom did not confirm the request. Try again.'],
  ];

  test.each(cases)('%s', (name, state, expected) => {
    expect(state.error).not.toBeNull();
    const arlo = view({ phase: state.phase, error: state.error, wording: 'arlo' });
    expect(arlo.message).toBe(expected);
    expect(arlo.message).not.toMatch(/transcription|start button|start it here|start again/i);
    // The classic dashboard still says it its own way
    expect(view({ phase: state.phase, error: state.error }).message).toBe(state.error.message);
  });

  test('Zoom\'s own reason is passed on as it is', () => {
    const state = run(requested, { type: 'REQUEST_FAILED', action: 'start', code: '10301', message: 'RTMS is not enabled for this app' });
    expect(view({ phase: state.phase, error: state.error, wording: 'arlo' }).message).toBe('RTMS is not enabled for this app');
  });

  test('guests still see no reason', () => {
    const state = requestStatus(3);
    expect(view({ phase: state.phase, error: state.error, wording: 'arlo', guest: true }).message).toBeNull();
  });
});
