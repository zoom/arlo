import { addSegment, mergeHistory, transcriptToText } from './transcript';

const seg = (seqNo, text, extra = {}) => ({
  seqNo, text, speakerId: '1', speakerLabel: 'Ana', tStartMs: 1000 * seqNo, tEndMs: 1000 * seqNo, ...extra,
});

describe('addSegment', () => {
  test('appends new speech', () => {
    const list = addSegment([seg(1, 'hello')], seg(2, 'world'));
    expect(list.map((s) => s.text)).toEqual(['hello', 'world']);
  });

  test('drops the same segment delivered twice (one socket can be registered under two meeting ids)', () => {
    const first = [seg(1, 'hello')];
    expect(addSegment(first, seg(1, 'hello'))).toBe(first);
  });

  test('keeps new speech after Stop → Start, when sequence numbers begin at 1 again', () => {
    const before = [seg(1, 'before the break'), seg(2, 'still before')];
    const after = addSegment(before, seg(1, 'after the break', { tStartMs: 900000 }));
    expect(after.map((s) => s.text)).toEqual(['before the break', 'still before', 'after the break']);
  });

  test('ignores malformed input', () => {
    const list = [seg(1, 'hello')];
    expect(addSegment(list, null)).toBe(list);
    expect(addSegment(list, {})).toBe(list);
  });
});

describe('mergeHistory', () => {
  test('puts stored segments first and keeps live ones that are not stored yet', () => {
    const live = [seg(2, 'two'), seg(3, 'three')];
    const stored = [seg(1, 'one'), seg(2, 'two')];
    expect(mergeHistory(stored, live).map((s) => s.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('transcriptToText', () => {
  test('uses the speaker name the server sends (speakerLabel)', () => {
    expect(transcriptToText([seg(1, 'We ship Friday.'), seg(2, 'Agreed.', { speakerLabel: 'Ben' })]))
      .toBe('Ana: We ship Friday.\nBen: Agreed.');
  });

  test('falls back for older data and unknown speakers', () => {
    expect(transcriptToText([{ speakerName: 'Old', text: 'x' }, { text: 'y' }])).toBe('Old: x\nUnknown: y');
  });

  test('is empty for no segments', () => {
    expect(transcriptToText([])).toBe('');
    expect(transcriptToText(undefined)).toBe('');
  });
});
