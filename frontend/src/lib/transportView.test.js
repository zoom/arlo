import { getTransportView } from './transportView';

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
