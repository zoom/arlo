import { isForMeeting, readMeetingMessage } from './meetingMessage';

const MINE = 'MEETING-1==';
const event = (message) => ({ data: typeof message === 'string' ? message : JSON.stringify(message) });

describe('isForMeeting', () => {
  test('a message that names my meeting is mine', () => {
    expect(isForMeeting({ type: 'transcript.segment', data: { meetingId: MINE } }, MINE)).toBe(true);
  });

  test('a message that names another meeting is not', () => {
    expect(isForMeeting({ type: 'transcript.segment', data: { meetingId: 'OTHER==' } }, MINE)).toBe(false);
  });

  test('a message without data or without a meeting id is not', () => {
    expect(isForMeeting({ type: 'pong' }, MINE)).toBe(false);
    expect(isForMeeting({ type: 'error', data: null }, MINE)).toBe(false);
    expect(isForMeeting({ type: 'x', data: {} }, MINE)).toBe(false);
    expect(isForMeeting({ type: 'x', data: 'MEETING-1==' }, MINE)).toBe(false);
    expect(isForMeeting(null, MINE)).toBe(false);
  });

  test('without a verified meeting id nothing is mine, not even a message without one', () => {
    expect(isForMeeting({ type: 'x', data: { meetingId: MINE } }, null)).toBe(false);
    expect(isForMeeting({ type: 'x', data: { meetingId: MINE } }, undefined)).toBe(false);
    expect(isForMeeting({ type: 'x', data: { meetingId: '' } }, '')).toBe(false);
    expect(isForMeeting({ type: 'x', data: {} }, undefined)).toBe(false);
  });

  test('ids are compared exactly, never loosely', () => {
    expect(isForMeeting({ type: 'x', data: { meetingId: 123456 } }, '123456')).toBe(false);
  });
});

describe('readMeetingMessage', () => {
  test('gives the parsed message when it is for my meeting', () => {
    const message = { type: 'meeting.status', data: { meetingId: MINE, status: 'rtms_started' } };
    expect(readMeetingMessage(event(message), MINE)).toEqual(message);
  });

  test('gives null for another meeting, for no verified id and for what is not a message', () => {
    expect(readMeetingMessage(event({ type: 'x', data: { meetingId: 'OTHER==' } }), MINE)).toBeNull();
    expect(readMeetingMessage(event({ type: 'x', data: { meetingId: MINE } }), null)).toBeNull();
    expect(readMeetingMessage(event('not json'), MINE)).toBeNull();
    expect(readMeetingMessage(event('null'), MINE)).toBeNull();
    expect(readMeetingMessage(event('"text"'), MINE)).toBeNull();
    expect(readMeetingMessage(undefined, MINE)).toBeNull();
  });
});
