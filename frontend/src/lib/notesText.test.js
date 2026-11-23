import { notesToText, notesToChatMessage, cleanNotes, CHAT_MESSAGE_MAX_CHARS } from './notesText';

const notes = {
  summary: 'The beta moves to March 3.',
  decisions: ['Beta launch moves to March 3', 'Keep the three-tier pricing'],
  actionItems: [
    { text: 'Send the revised timeline', owner: 'Ana' },
    { text: 'Draft the beta invite email', owner: null },
  ],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 12,
};

describe('notesToText', () => {
  test('title, then the three sections', () => {
    expect(notesToText(notes, { title: 'Q1 launch review' })).toBe([
      'Q1 launch review',
      '',
      'Summary',
      'The beta moves to March 3.',
      '',
      'Decisions',
      '- Beta launch moves to March 3',
      '- Keep the three-tier pricing',
      '',
      'Action items',
      '- Send the revised timeline · Ana',
      '- Draft the beta invite email',
    ].join('\n'));
  });

  test('sections with no entries are left out', () => {
    const text = notesToText({ ...notes, decisions: [], actionItems: [] }, { title: 'Sync' });
    expect(text).toBe('Sync\n\nSummary\nThe beta moves to March 3.');
    expect(notesToText({ ...notes, summary: '' }, { title: 'Sync' })).not.toContain('Summary');
  });

  test('works without a title', () => {
    expect(notesToText({ ...notes, decisions: [], actionItems: [] })).toBe('Summary\nThe beta moves to March 3.');
  });

  test('null notes give an empty string', () => {
    expect(notesToText(null, { title: 'Sync' })).toBe('');
    expect(notesToText(undefined)).toBe('');
  });
});

describe('cleanNotes (what the server sent is rebuilt from known fields)', () => {
  test('keeps valid notes', () => {
    expect(cleanNotes(notes)).toEqual(notes);
  });

  test('drops unknown fields and entries of the wrong type', () => {
    expect(cleanNotes({
      summary: 'S',
      decisions: ['a', 4, null, ''],
      actionItems: [{ text: 'do', owner: 7, extra: 1 }, { text: '' }, 'x', null, { text: 'b', owner: 'Ben' }],
      html: '<b>x</b>',
    })).toEqual({
      summary: 'S',
      decisions: ['a'],
      actionItems: [{ text: 'do', owner: null }, { text: 'b', owner: 'Ben' }],
      updatedAt: null,
      throughSeqNo: null,
    });
  });

  test.each([null, undefined, 'text', 42, [], { summary: 42 }])('%j is not notes', (value) => {
    expect(cleanNotes(value)).toBeNull();
  });
});

describe('notesToChatMessage (the notes as one Zoom chat message)', () => {
  const SHORTENED = '… (shortened)';

  test('short notes: "Notes from Arlo", then the three sections', () => {
    expect(notesToChatMessage(notes)).toBe([
      'Notes from Arlo',
      '',
      'Summary',
      'The beta moves to March 3.',
      '',
      'Decisions',
      '- Beta launch moves to March 3',
      '- Keep the three-tier pricing',
      '',
      'Action items',
      '- Send the revised timeline · Ana',
      '- Draft the beta invite email',
    ].join('\n'));
  });

  test('sections with no entries are left out', () => {
    expect(notesToChatMessage({ ...notes, decisions: [], actionItems: [] }))
      .toBe('Notes from Arlo\n\nSummary\nThe beta moves to March 3.');
    expect(notesToChatMessage({ ...notes, summary: '', actionItems: [] }))
      .toBe('Notes from Arlo\n\nDecisions\n- Beta launch moves to March 3\n- Keep the three-tier pricing');
  });

  test('no notes, or notes with nothing in them, give an empty string', () => {
    expect(notesToChatMessage(null)).toBe('');
    expect(notesToChatMessage(undefined)).toBe('');
    expect(notesToChatMessage({ summary: '  ', decisions: [], actionItems: [] })).toBe('');
  });

  test('the limit is 4000 characters', () => {
    expect(CHAT_MESSAGE_MAX_CHARS).toBe(4000);
  });

  test('a message of exactly the limit is not cut', () => {
    const head = 'Notes from Arlo\n\nSummary\n';
    const message = notesToChatMessage({ summary: 'x'.repeat(4000 - head.length), decisions: [], actionItems: [] });
    expect(message).toHaveLength(4000);
    expect(message).not.toContain(SHORTENED);
  });

  test('over the limit: cut after the last whole line that fits, then "… (shortened)"', () => {
    const decisions = Array.from({ length: 200 }, (_, index) => `Decision number ${index + 1} is a line of some length`);
    const message = notesToChatMessage({ ...notes, decisions });
    const lines = message.split('\n');
    const full = notesToText({ ...notes, decisions }, { title: 'Notes from Arlo' }).split('\n');

    expect(message.length).toBeLessThanOrEqual(4000);
    expect(lines[lines.length - 1]).toBe(SHORTENED);
    // Every line before the last is a whole line of the full text, in order
    expect(lines.slice(0, -1)).toEqual(full.slice(0, lines.length - 1));
    // And the next whole line would not have fitted
    const next = full[lines.length - 1];
    expect(`${lines.slice(0, -1).join('\n')}\n${next}\n${SHORTENED}`.length).toBeGreaterThan(4000);
    expect(message).not.toContain('Action items');
  });

  test('the cut never ends on an empty line or on a heading with nothing under it', () => {
    // The summary fills the message so that only "", "Decisions" would still fit
    const head = 'Notes from Arlo\n\nSummary\n';
    const tail = `\n\nDecisions\n${SHORTENED}`;
    const summary = 'y'.repeat(4000 - head.length - tail.length);
    const message = notesToChatMessage({ summary, decisions: ['A decision that does not fit any more'], actionItems: [] });
    expect(message).toBe(`${head}${summary}\n${SHORTENED}`);
  });

  test('one line longer than the whole message is cut inside the line, at a word', () => {
    const summary = Array.from({ length: 1500 }, () => 'word').join(' ');
    const message = notesToChatMessage({ summary, decisions: ['Kept?'], actionItems: [] });
    const lines = message.split('\n');
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(lines.slice(0, 3)).toEqual(['Notes from Arlo', '', 'Summary']);
    expect(lines[3]).toMatch(/^(word )+word$/);
    expect(lines[3].length).toBeGreaterThan(3900);
    expect(lines[4]).toBe(SHORTENED);
    expect(lines).toHaveLength(5);
  });

  test.each([1, 37, 512, 3990, 3999, 4001, 4050, 9000])('never more than 4000 characters (summary of %i)', (size) => {
    const message = notesToChatMessage({ ...notes, summary: 'z'.repeat(size) });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message.startsWith('Notes from Arlo\n')).toBe(true);
  });
});
