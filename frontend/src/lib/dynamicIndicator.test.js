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
    for (const phase of ['idle', 'requested', 'starting', 'stalled', 'paused', 'interrupted', 'stopped', 'failed', 'denied', 'expired']) {
      expect(text({ phase })).toBeNull();
    }
  });

  test('nothing from a panel that did not start the stream, or from a guest', () => {
    expect(text({ startedHere: false })).toBeNull();
    expect(text({ guest: true })).toBeNull();
  });
});
