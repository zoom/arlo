import { usableName, ownerWording, sharedNotesHeading } from './ownerName';

describe('usableName', () => {
  test('a name is trimmed; anything blank or not a string is no name', () => {
    expect(usableName('  Ana Ruiz ')).toBe('Ana Ruiz');
    for (const none of [' ', '', '\t\n', null, undefined, 7, {}, ['Ana']]) expect(usableName(none)).toBeNull();
    expect(usableName('x'.repeat(300))).toHaveLength(200);
    expect(usableName('x'.repeat(300), 100)).toHaveLength(100);
  });

  // Each shows as nothing, or changes how the sentence around the name reads
  const INVISIBLE = {
    'zero-width space U+200B': '\u200b',
    'soft hyphen U+00AD': '\u00ad',
    'Hangul filler U+3164': '\u3164',
    'Hangul choseong filler U+115F': '\u115f',
    'Hangul jungseong filler U+1160': '\u1160',
    'halfwidth Hangul filler U+FFA0': '\uffa0',
    'right-to-left override U+202E': '\u202e',
    'line separator U+2028': '\u2028',
    'paragraph separator U+2029': '\u2029',
    'private use U+E000': '\ue000',
    'unassigned U+0378': '\u0378',
    'lone surrogate': '\ud83d',
    'control U+0007': '\u0007',
  };

  test.each(Object.entries(INVISIBLE))('a name made of, or holding, %s is no name', (label, char) => {
    expect(usableName(char)).toBeNull();
    expect(usableName(char.repeat(5))).toBeNull();
    expect(usableName(`An${char}a`)).toBeNull();
    expect(ownerWording(char.repeat(3)).heading).toBe('Arlo is in this meeting');
    expect(ownerWording(`An${char}a`).heading).toBe('Arlo is in this meeting');
  });

  test('a name needs a letter or a digit', () => {
    for (const none of ['...', '-', '🎉', '\u0301']) expect(usableName(none)).toBeNull();
  });

  test('ordinary names in any script are names, kept in one form (NFC)', () => {
    const names = ['Ana Ruiz', 'José Ángel Müller', 'Zoë O\'Brien-Smith', '山田 太郎', '王小明', '김민준', 'محمد علي', 'Дмитрий', 'Ana 🎉', '🎉 Ben', 'R2', '7'];
    for (const name of names) expect(usableName(` ${name} `)).toBe(name.normalize('NFC'));
    expect(usableName('Jose\u0301')).toBe('José');
  });

  test('a name cut to the limit does not end in half an emoji', () => {
    expect(usableName(`${'x'.repeat(199)}🎉`)).toBe('x'.repeat(199));
  });
});

describe('ownerWording', () => {
  test('with a name, the sentences name the person', () => {
    expect(ownerWording('Ana')).toEqual({
      heading: 'Ana brought Arlo into this meeting',
      body: 'Arlo reads Zoom\'s live transcript to take notes for Ana. Nothing is stored after the meeting ends.',
    });
  });

  test('without one (null, or a blank), they say it without a name and leave no gap', () => {
    const plain = {
      heading: 'Arlo is in this meeting',
      body: 'Arlo reads Zoom\'s live transcript to take notes for the person who brought it in. Nothing is stored after the meeting ends.',
    };
    for (const none of [null, undefined, '', ' ', '   ']) {
      expect(ownerWording(none)).toEqual(plain);
    }
    for (const sentence of Object.values(plain)) expect(sentence).not.toMatch(/ {2}| \./);
  });
});

describe('sharedNotesHeading', () => {
  test('names who shares the notes, and says it without a name when there is none', () => {
    expect(sharedNotesHeading('Ana')).toBe('Ana is sharing Arlo\'s notes');
    expect(sharedNotesHeading(' Ana Ruiz ')).toBe('Ana Ruiz is sharing Arlo\'s notes');
    for (const none of [null, undefined, '', '   ', '\u202E', 42]) {
      expect(sharedNotesHeading(none)).toBe('Arlo\'s notes are shared with everyone');
    }
  });
});
