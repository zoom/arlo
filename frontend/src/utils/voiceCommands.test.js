import { detectTrigger, processTranscriptForCommand } from './voiceCommands';

describe('detectTrigger', () => {
  test.each([
    ['Hey Arlo, summarize this meeting', 'Summarize this meeting'],
    ['hey arlo summarize', 'Summarize'],
    ['Hi, Arlo. What are the action items?', 'What are the action items?'],
    ['Arlo, help', 'Help'],
    ['Okay. Arlo, send to chat', 'Send to chat'],
    ['So anyway, hey Arlo, recap', 'Recap'],
    ['Hey Carlo, summarize', 'Summarize'], // common mis-transcription of "Arlo"
  ])('triggers on %j', (text, after) => {
    expect(detectTrigger(text)?.textAfterTrigger).toBe(after);
  });

  test.each([
    'Carlos will send the summary tomorrow',
    'Charlotte and Marlo joined late',
    'We met in Harlow last week',
    'I showed Arlo to the team and they liked the summary',
    'The parlor is booked',
    '',
  ])('does not trigger on %j', (text) => {
    expect(detectTrigger(text)).toBeNull();
  });

  test('ignores non-strings', () => {
    expect(detectTrigger(null)).toBeNull();
    expect(detectTrigger(42)).toBeNull();
  });
});

describe('processTranscriptForCommand', () => {
  test('a name that only contains "arlo" runs no command', () => {
    expect(processTranscriptForCommand('Carlos, can you summarize the tasks?')).toBeNull();
  });

  test('a real trigger still parses the command', () => {
    expect(processTranscriptForCommand('Hey Arlo, give me a summary')?.action).toBe('SUMMARIZE');
  });
});
