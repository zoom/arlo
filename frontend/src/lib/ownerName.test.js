import { usableName, ownerWording } from './ownerName';

describe('usableName', () => {
  test('a name is trimmed; anything blank or not a string is no name', () => {
    expect(usableName('  Ana Ruiz ')).toBe('Ana Ruiz');
    for (const none of [' ', '', '\t\n', null, undefined, 7, {}, ['Ana']]) expect(usableName(none)).toBeNull();
    expect(usableName('x'.repeat(300))).toHaveLength(200);
    expect(usableName('x'.repeat(300), 100)).toHaveLength(100);
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
