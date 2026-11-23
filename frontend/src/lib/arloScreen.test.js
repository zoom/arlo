import { getArloScreen, canControlArlo } from './arloScreen';

// Arlo's state received: Arlo is not in the meeting and never was
const base = {
  guest: false, zoomRole: 'attendee', arloRole: 'participant', present: false,
  phase: 'idle', meetingEnded: false, hasNotes: false, everPresent: false,
};
const screenFor = (overrides) => getArloScreen({ ...base, ...overrides });

describe('getArloScreen', () => {
  test.each([
    // 1. the meeting has ended
    ['ended, owner with notes', { meetingEnded: true, arloRole: 'owner', hasNotes: true }, 'after'],
    ['ended, owner without notes', { meetingEnded: true, arloRole: 'owner' }, 'participant'],
    ['ended, participant', { meetingEnded: true, everPresent: true }, 'participant'],
    ['ended, host who is not the owner', { meetingEnded: true, zoomRole: 'host' }, 'participant'],
    ['ended wins over a stream still reported', { meetingEnded: true, arloRole: 'owner', hasNotes: true, present: true, phase: 'active' }, 'after'],
    // 2. Arlo is present
    ['present, owner', { present: true, arloRole: 'owner' }, 'notes'],
    ['present, participant', { present: true }, 'participant'],
    ['present, guest', { present: true, guest: true }, 'participant'],
    ['present, host who is not the owner', { present: true, zoomRole: 'host' }, 'participant'],
    ['present, co-host who is not the owner', { present: true, zoomRole: 'coHost' }, 'participant'],
    ['active phase, owner', { phase: 'active', arloRole: 'owner' }, 'notes'],
    ['paused phase, owner', { phase: 'paused', arloRole: 'owner' }, 'notes'],
    ['reconnecting, owner', { phase: 'reconnecting', arloRole: 'owner' }, 'notes'],
    ['interrupted (the machine\'s name for reconnecting), owner', { phase: 'interrupted', arloRole: 'owner' }, 'notes'],
    ['active phase, participant', { phase: 'active' }, 'participant'],
    ['stream confirmed before Arlo\'s state arrived', { phase: 'active', arloRole: null, present: null }, 'loading'],
    // 3. a request is not a state
    ['requested, host', { phase: 'requested', zoomRole: 'host' }, 'waiting'],
    ['requested, attendee', { phase: 'requested' }, 'waiting'],
    ['requested never shows the notes', { phase: 'requested', arloRole: 'owner', hasNotes: true, everPresent: true }, 'waiting'],
    ['starting', { phase: 'starting', zoomRole: 'host' }, 'waiting'],
    // 4. Arlo has left, the owner keeps the notes
    ['left, owner with notes', { arloRole: 'owner', hasNotes: true, everPresent: true, phase: 'stopped' }, 'notes'],
    ['left, owner without notes, host', { arloRole: 'owner', everPresent: true, zoomRole: 'host', phase: 'stopped' }, 'bring-in'],
    ['never present, owner with notes, attendee', { arloRole: 'owner', hasNotes: true }, 'ask-host'],
    // 5. not present
    ['not present, host', { zoomRole: 'host' }, 'bring-in'],
    ['not present, co-host', { zoomRole: 'coHost' }, 'bring-in'],
    ['not present, attendee', {}, 'ask-host'],
    ['not present, unknown Zoom role', { zoomRole: undefined }, 'ask-host'],
    ['not present, guest', { guest: true }, 'participant'],
    ['not present, guest who is the Zoom host', { guest: true, zoomRole: 'host' }, 'participant'],
    ['after a denied request, host', { zoomRole: 'host', phase: 'denied' }, 'bring-in'],
    ['after a failed request, attendee', { phase: 'failed' }, 'ask-host'],
    // 6. nothing known yet
    ['state not received', { present: null, arloRole: null }, 'loading'],
    ['state not received, host', { present: undefined, arloRole: undefined, zoomRole: 'host' }, 'loading'],
  ])('%s', (name, overrides, expected) => {
    expect(screenFor(overrides)).toBe(expected);
  });
});

describe('canControlArlo', () => {
  test.each([
    [{ guest: false, zoomRole: 'attendee', arloRole: 'owner' }, true],
    [{ guest: false, zoomRole: 'host', arloRole: 'participant' }, true],
    [{ guest: false, zoomRole: 'coHost', arloRole: 'participant' }, true],
    [{ guest: false, zoomRole: 'attendee', arloRole: 'participant' }, false],
    [{ guest: false, zoomRole: undefined, arloRole: null }, false],
    [{ guest: true, zoomRole: 'host', arloRole: 'participant' }, false],
    [{ guest: true, zoomRole: 'attendee', arloRole: 'owner' }, false],
  ])('%j → %s', (input, expected) => {
    expect(canControlArlo(input)).toBe(expected);
  });
});
