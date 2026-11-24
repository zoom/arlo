import { vi } from 'vitest';
import {
  COLLABORATE_GUESSES, isInCollaborate, meetingRunningContext, readRunningContext, startCollaborateForEveryone, collaborateRedirect,
} from './collaborate';

describe('the running context in Collaborate', () => {
  test('only Zoom\'s own value for it counts', () => {
    expect(COLLABORATE_GUESSES.runningContext).toBe('inCollaborate');
    expect(isInCollaborate('inCollaborate')).toBe(true);
    for (const value of ['inMeeting', 'inCollaborateSidecar', 'incollaborate', 'inImmersive', 'inMainClient', '', null, undefined, true, {}]) {
      expect(isInCollaborate(value)).toBe(false);
    }
  });

  test('Collaborate is inside a meeting: the rest of the panel reads it as "inMeeting"; nothing else is changed', () => {
    expect(meetingRunningContext('inCollaborate')).toBe('inMeeting');
    for (const value of ['inMeeting', 'inMainClient', 'inWebinar', 'inImmersive', 'inCollaborateSidecar', 'test', 'error', null]) {
      expect(meetingRunningContext(value)).toBe(value);
    }
  });

  test('the answer of getRunningContext, in either shape; anything else is null', () => {
    expect(readRunningContext({ context: 'inCollaborate' })).toBe('inCollaborate');
    expect(readRunningContext('inMeeting')).toBe('inMeeting');
    for (const value of [null, undefined, {}, { context: 5 }, { context: '' }, 5, []]) expect(readRunningContext(value)).toBe(null);
  });
});

describe('startCollaborateForEveryone', () => {
  test('starts Collaborate with the screen share for people without the app', async () => {
    const sdk = { startCollaborate: vi.fn(async () => ({ message: 'Success' })) };
    expect(await startCollaborateForEveryone(sdk)).toBe(true);
    expect(sdk.startCollaborate).toHaveBeenCalledTimes(1);
    expect(sdk.startCollaborate).toHaveBeenCalledWith({ shareScreen: true });
  });

  test('Zoom saying the app is in Collaborate already is as good as started', async () => {
    for (const code of [10084, '10084']) {
      const sdk = { startCollaborate: vi.fn(async () => { throw Object.assign(new Error('The app is in collaborate mode.'), { code }); }) };
      expect(await startCollaborateForEveryone(sdk)).toBe(true);
    }
  });

  test('any other refusal, a throw, or a client without the call: not started', async () => {
    for (const error of [Object.assign(new Error('no'), { code: 10089 }), Object.assign(new Error('no'), { code: 10090 }), new Error('no'), 'no', null]) {
      const sdk = { startCollaborate: vi.fn(async () => { throw error; }) };
      expect(await startCollaborateForEveryone(sdk)).toBe(false);
    }
    expect(await startCollaborateForEveryone({ startCollaborate: vi.fn(() => { throw new Error('at once'); }) })).toBe(false);
    expect(await startCollaborateForEveryone({})).toBe(false);
    expect(await startCollaborateForEveryone(undefined)).toBe(false);
  });
});

describe('collaborateRedirect: in Collaborate the only screen is the meeting\'s Arlo screen', () => {
  const at = (pathname, extra = {}) => collaborateRedirect({
    inCollaborate: true, pathname, meetingId: 'M 1==', isAuthenticated: true, authLoading: false, ...extra,
  });

  test('every other route goes to it, by who is signed in', () => {
    for (const pathname of ['/settings', '/home', '/meetings', '/meetings/5', '/search', '/upcoming', '/select-vertical', '/welcome',
      '/meeting/M%201%3D%3D/record', '/meeting/M%201%3D%3D/classic', '/guest-meeting/x/record', '/guest', '/guest/x', '/nowhere', '/meeting', '/meeting/']) {
      expect(at(pathname)).toBe('/meeting/M%201%3D%3D');
      expect(at(pathname, { isAuthenticated: false })).toBe('/guest-meeting/M%201%3D%3D');
    }
  });

  test('stays: on that screen, while the app starts or signs in, and before the meeting or the session is known', () => {
    for (const pathname of ['/meeting/M%201%3D%3D', '/guest-meeting/M%201%3D%3D', '/meeting/another', '/', '/auth']) expect(at(pathname)).toBe(null);
    expect(at('/settings', { authLoading: true })).toBe(null);
    for (const meetingId of [null, undefined, '', 5]) expect(at('/settings', { meetingId })).toBe(null);
    for (const pathname of [null, undefined, 5]) expect(at(pathname)).toBe(null);
  });

  test('out of Collaborate nothing is redirected', () => {
    for (const inCollaborate of [false, null, undefined, 'true', 1]) expect(at('/settings', { inCollaborate })).toBe(null);
    expect(collaborateRedirect()).toBe(null);
  });
});
