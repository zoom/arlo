import { indicatorText, INDICATOR_TEXT } from './dynamicIndicator';

const base = { phase: 'active', startedHere: true, guest: false, voiceEnabled: false, voiceProcessing: false };
const text = (overrides) => indicatorText({ ...base, ...overrides });

describe('indicatorText', () => {
  test('confirmed transcription started here: "Arlo is transcribing"', () => {
    expect(text({})).toBe('Arlo is transcribing');
  });

  test('with voice commands on, it also says how to call Arlo', () => {
    expect(text({ voiceEnabled: true })).toBe(INDICATOR_TEXT.listening);
    expect(INDICATOR_TEXT.listening).toContain('Say "Hey Arlo"');
  });

  test('while a voice command is processed: "Arlo is thinking…"', () => {
    expect(text({ voiceEnabled: true, voiceProcessing: true })).toBe('Arlo is thinking…');
    expect(text({ voiceEnabled: false, voiceProcessing: true })).toBe('Arlo is transcribing');
  });

  test('nothing unless transcription is confirmed', () => {
    for (const phase of ['idle', 'requested', 'starting', 'stalled', 'interrupted', 'stopped', 'failed', 'denied', 'expired']) {
      expect(text({ phase })).toBeNull();
      // the server's word about a pause does not bring an indicator back
      expect(text({ phase, pausedOnServer: true })).toBeNull();
    }
  });

  test('while this user\'s stream is paused: "Arlo is paused", whoever says so', () => {
    expect(INDICATOR_TEXT.paused).toBe('Arlo is paused');
    expect(text({ phase: 'paused' })).toBe('Arlo is paused');
    // paused with Zoom's own controls: this panel still thinks it runs, the server knows
    expect(text({ phase: 'active', pausedOnServer: true })).toBe('Arlo is paused');
    // voice commands do not change that
    expect(text({ phase: 'paused', voiceEnabled: true, voiceProcessing: true })).toBe('Arlo is paused');
    expect(text({ phase: 'active', pausedOnServer: true, voiceEnabled: true })).toBe('Arlo is paused');
  });

  test('resumed: the transcribing text again', () => {
    expect(text({ phase: 'active', pausedOnServer: false })).toBe('Arlo is transcribing');
  });

  test('a paused stream this panel did not start, or a guest\'s panel: nothing', () => {
    expect(text({ phase: 'paused', startedHere: false })).toBeNull();
    expect(text({ phase: 'active', pausedOnServer: true, startedHere: false })).toBeNull();
    expect(text({ phase: 'paused', guest: true })).toBeNull();
  });

  test('nothing from a panel that did not start the stream, or from a guest', () => {
    expect(text({ startedHere: false })).toBeNull();
    expect(text({ guest: true })).toBeNull();
  });
});
