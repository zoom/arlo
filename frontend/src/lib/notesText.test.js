import { notesToText, cleanNotes } from './notesText';

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
