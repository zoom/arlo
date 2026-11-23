import { resolveUserStatus } from './userStatus';

describe('resolveUserStatus', () => {
  test('in a meeting, Zoom\'s answer decides: only "authorized" is a full user', () => {
    expect(resolveUserStatus({ runningContext: 'inMeeting', reported: 'authorized' })).toEqual({ status: 'authorized', isGuest: false });
    expect(resolveUserStatus({ runningContext: 'inMeeting', reported: 'authenticated' })).toEqual({ status: 'authenticated', isGuest: true });
    expect(resolveUserStatus({ runningContext: 'inMeeting', reported: 'unauthenticated' })).toEqual({ status: 'unauthenticated', isGuest: true });
  });

  test('in a meeting, not being able to ask means guest', () => {
    expect(resolveUserStatus({ runningContext: 'inMeeting', reported: null })).toEqual({ status: 'unauthenticated', isGuest: true });
  });

  test.each(['inWebinar', 'inImmersive', 'inCollaborate', 'inCamera'])('%s counts as a meeting', (runningContext) => {
    expect(resolveUserStatus({ runningContext, reported: null }).isGuest).toBe(true);
  });

  // Guest mode only exists inside a meeting. Outside one (the Apps tab, where a
  // deeplink lands) the person opened their own app, so they are never a guest.
  test.each(['inMainClient', 'inChat', 'inPhone', 'somethingNew'])('outside a meeting (%s) the user is never a guest', (runningContext) => {
    expect(resolveUserStatus({ runningContext, reported: null })).toEqual({ status: 'authorized', isGuest: false });
    expect(resolveUserStatus({ runningContext, reported: 'unauthenticated' })).toEqual({ status: 'authorized', isGuest: false });
    expect(resolveUserStatus({ runningContext, reported: 'authorized' })).toEqual({ status: 'authorized', isGuest: false });
  });
});
