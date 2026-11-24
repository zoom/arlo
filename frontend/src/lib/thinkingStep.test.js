import { describe, test, expect } from 'vitest';
import { readThinkingStep, readThinkingChannel, MAX_STEP_CHARS } from './thinkingStep';

describe('readThinkingStep', () => {
  test('a sentence is kept, trimmed', () => {
    expect(readThinkingStep('Writing an answer')).toBe('Writing an answer');
    expect(readThinkingStep('  Admitting Zo\u00EB from the waiting room \n')).toBe('Admitting Zo\u00EB from the waiting room');
  });

  test('control and invisible characters are removed', () => {
    expect(readThinkingStep('Writing\u0000 an\u0007 answer')).toBe('Writing an answer');
    expect(readThinkingStep('Admitting \u202Esemaj\u202C from the waiting room')).toBe('Admitting semaj from the waiting room');
    expect(readThinkingStep('Posting\u2028to chat')).toBe('Postingto chat');
  });

  test('anything else is no step', () => {
    for (const value of [undefined, null, '', '   ', '\u0000\u0001', 7, true, {}, ['Writing an answer'], { toString: () => 'x' }]) {
      expect(readThinkingStep(value)).toBeNull();
    }
    expect(readThinkingStep('x'.repeat(MAX_STEP_CHARS))).toBe('x'.repeat(MAX_STEP_CHARS));
    expect(readThinkingStep('x'.repeat(MAX_STEP_CHARS + 1))).toBeNull();
    expect(MAX_STEP_CHARS).toBe(120);
  });
});

describe('readThinkingChannel', () => {
  test('one of the two, otherwise null', () => {
    expect(readThinkingChannel('voice')).toBe('voice');
    expect(readThinkingChannel('panel')).toBe('panel');
    for (const value of [undefined, null, '', 'Voice', 'radio', 1, ['voice'], {}]) expect(readThinkingChannel(value)).toBeNull();
  });
});
