import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { createZoomSdk, resetHarness, MEETING } from '../test/harness';
import { ZoomSdkProvider, useZoomSdk } from './ZoomSdkContext';

// What the panel takes a Zoom client to support. Zoom can accept a
// configuration and still say, in its answer, that it lacks some of the APIs
// asked for (`unsupportedApis`): those count as not supported.

let zoom;
function Probe() {
  zoom = useZoomSdk();
  return null;
}

async function configured(options) {
  window.zoomSdk = createZoomSdk(options);
  render(<ZoomSdkProvider><Probe /></ZoomSdkProvider>);
  await waitFor(() => expect(zoom.sdkConfigured).toBe(true));
  return {
    chat: zoom.chatSupported,
    waitingRoom: zoom.waitingRoomSupported,
    indicator: zoom.dynamicIndicatorSupported,
    rtmsStatus: zoom.rtmsStatusSupported,
    invitation: zoom.invitationSupported,
    reaction: zoom.reactionSupported,
    mute: zoom.muteSupported,
    openUrl: zoom.openUrlSupported,
    shareScreen: zoom.shareScreenSupported,
    collaborate: zoom.collaborateSupported,
  };
}
const ALL = {
  chat: true, waitingRoom: true, indicator: true, rtmsStatus: true, invitation: true, reaction: true, mute: true, openUrl: true, shareScreen: true, collaborate: true,
};
const lastCapabilities = () => window.zoomSdk.config.mock.calls.at(-1)[0].capabilities;

afterEach(resetHarness);

test('a client that accepts everything and lists nothing as unsupported has everything', async () => {
  expect(await configured()).toEqual(ALL);
});

test.each([
  ['sendMessageToChat', { chat: false }],
  ['getWaitingRoomParticipants', { waitingRoom: false }],
  ['admitParticipantFromWaitingRoom', { waitingRoom: false }],
  ['setDynamicIndicator', { indicator: false }],
  ['removeDynamicIndicator', { indicator: false }],
  ['getRTMSStatus', { rtmsStatus: false }],
  ['onRTMSStatusChange', { rtmsStatus: false }],
  ['sendAppInvitationToAllParticipants', { invitation: false }],
  ['setEmojiReaction', { reaction: false }],
  ['toggleParticipantMediaAudio', { mute: false }],
  ['getMeetingParticipants', { mute: false }],
  ['openUrl', { openUrl: false }],
  ['promptShareScreen', { shareScreen: false }],
  ['startCollaborate', { collaborate: false }],
])('%s accepted at config but listed in unsupportedApis is not supported', async (api, lost) => {
  expect(await configured({ unsupportedApis: [api] })).toEqual({ ...ALL, ...lost });
  // Zoom accepted the first, largest set: nothing was asked again
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(1);
});

test('an API of another tier in the list takes nothing away', async () => {
  expect(await configured({ unsupportedApis: ['joinCollaborate', 'runRenderingContext'] })).toEqual(ALL);
});

test.each([
  ['no list', undefined],
  ['a list that is not one', 'sendMessageToChat'],
  ['entries that are not names', [null, 7, { name: 'sendMessageToChat' }]],
])('an answer with %s is read as nothing unsupported', async (_name, unsupportedApis) => {
  window.zoomSdk = createZoomSdk();
  window.zoomSdk.config.mockImplementation(async () => ({ clientVersion: '6.6.0', unsupportedApis }));
  render(<ZoomSdkProvider><Probe /></ZoomSdkProvider>);
  await waitFor(() => expect(zoom.sdkConfigured).toBe(true));
  expect(zoom.chatSupported).toBe(true);
  expect(zoom.waitingRoomSupported).toBe(true);
});

test('the waiting-room APIs refused at config: a smaller set is asked for, and they are not supported although the methods exist', async () => {
  const flags = await configured({ waitingRoomRefused: true });
  expect(typeof window.zoomSdk.getWaitingRoomParticipants).toBe('function');
  // The tiers added after the waiting room are in every set that has it, so they go too
  expect(flags).toEqual({ ...ALL, waitingRoom: false, reaction: false, mute: false, shareScreen: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(4);
});

test('the share dialog\'s API is asked for with the reactions, in the first set only: no set more than before', async () => {
  await configured();
  expect(lastCapabilities()).toEqual(expect.arrayContaining(['openUrl', 'promptShareScreen', 'setEmojiReaction']));
  resetHarness();
  // Refused: one smaller set, the reactions go with them, everything before stays
  const flags = await configured({ refusedApis: ['promptShareScreen'] });
  expect(typeof window.zoomSdk.promptShareScreen).toBe('function');
  expect(flags).toEqual({ ...ALL, reaction: false, shareScreen: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(2);
  expect(lastCapabilities()).toContain('toggleParticipantMediaAudio');
  expect(lastCapabilities()).not.toContain('promptShareScreen');
});

test('an API that is never called is never asked for: a client that refuses it must not lose what is', async () => {
  await configured();
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(1);
  for (const call of window.zoomSdk.config.mock.calls) {
    expect(call[0].capabilities).not.toContain('getEmojiConfiguration');
    expect(call[0].capabilities).not.toContain('stopShareScreen');
  }
  resetHarness();
  // also in none of the smaller sets
  await configured({ refusedApis: ['toggleParticipantMediaAudio'] });
  expect(window.zoomSdk.config.mock.calls.length).toBeGreaterThan(1);
  for (const call of window.zoomSdk.config.mock.calls) {
    expect(call[0].capabilities).not.toContain('getEmojiConfiguration');
    expect(call[0].capabilities).not.toContain('stopShareScreen');
  }
});

test('the first set asked for has the reaction and participant-audio APIs', async () => {
  await configured();
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(1);
  expect(lastCapabilities()).toEqual(expect.arrayContaining([
    'setEmojiReaction', 'toggleParticipantMediaAudio', 'getMeetingParticipants',
    'sendAppInvitationToAllParticipants', 'getWaitingRoomParticipants',
  ]));
});

test('the reaction APIs refused at config: one smaller set, and everything else stays, muting too', async () => {
  const flags = await configured({ refusedApis: ['setEmojiReaction'] });
  expect(typeof window.zoomSdk.setEmojiReaction).toBe('function');
  expect(flags).toEqual({ ...ALL, reaction: false, shareScreen: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(2);
  expect(lastCapabilities()).toContain('toggleParticipantMediaAudio');
  expect(lastCapabilities()).not.toContain('setEmojiReaction');
});

test('the participant-audio API refused at config: two smaller sets, reactions go with it, the waiting room stays', async () => {
  const flags = await configured({ refusedApis: ['toggleParticipantMediaAudio'] });
  expect(typeof window.zoomSdk.toggleParticipantMediaAudio).toBe('function');
  expect(flags).toEqual({ ...ALL, reaction: false, mute: false, shareScreen: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(3);
  expect(lastCapabilities()).toContain('getWaitingRoomParticipants');
});

test('both new tiers and the waiting room refused: what the client had before is kept', async () => {
  const flags = await configured({ refusedApis: ['setEmojiReaction', 'toggleParticipantMediaAudio'], waitingRoomRefused: true });
  expect(flags).toEqual({ ...ALL, reaction: false, mute: false, waitingRoom: false, shareScreen: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(4);
});

test('a client that takes the core set only: every set is tried once, largest first, and nothing optional is supported', async () => {
  const flags = await configured({ refusedApis: ['getMeetingParticipants'] });
  expect(flags).toEqual({
    chat: true, waitingRoom: false, indicator: false, rtmsStatus: false, invitation: false, reaction: false, mute: false,
    openUrl: true, shareScreen: false, collaborate: false,
  });
  const sizes = window.zoomSdk.config.mock.calls.map(([options]) => options.capabilities.length);
  expect(sizes).toHaveLength(7);
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
});

test('a client object without the methods does not support them, whatever config said', async () => {
  window.zoomSdk = createZoomSdk();
  delete window.zoomSdk.setEmojiReaction;
  delete window.zoomSdk.toggleParticipantMediaAudio;
  delete window.zoomSdk.sendAppInvitationToAllParticipants;
  delete window.zoomSdk.openUrl;
  delete window.zoomSdk.promptShareScreen;
  render(<ZoomSdkProvider><Probe /></ZoomSdkProvider>);
  await waitFor(() => expect(zoom.sdkConfigured).toBe(true));
  expect(zoom.reactionSupported).toBe(false);
  expect(zoom.muteSupported).toBe(false);
  expect(zoom.invitationSupported).toBe(false);
  expect(zoom.openUrlSupported).toBe(false);
  expect(zoom.shareScreenSupported).toBe(false);
});

// --- Collaborate mode: the running context ---------------------------------------

async function started(options) {
  window.zoomSdk = createZoomSdk(options);
  render(<ZoomSdkProvider><Probe /></ZoomSdkProvider>);
  await waitFor(() => expect(zoom.sdkConfigured).toBe(true));
  await waitFor(() => expect(zoom.runningContext).not.toBeNull());
  return window.zoomSdk;
}
const fire = (sdk, event, payload) => act(async () => { sdk.emit(event, payload); });

test('in a meeting\'s side panel: in a meeting, not in Collaborate', async () => {
  await started();
  expect([zoom.runningContext, zoom.inCollaborate]).toEqual(['inMeeting', false]);
  await waitFor(() => expect(zoom.meetingContext?.meetingUUID).toBe(MEETING));
});

test('an app that starts in Collaborate is in a meeting, with the meeting\'s id, and says it is in Collaborate', async () => {
  await started({ runningContext: 'inCollaborate' });
  expect([zoom.runningContext, zoom.inCollaborate]).toEqual(['inMeeting', true]);
  await waitFor(() => expect(zoom.meetingContext?.meetingUUID).toBe(MEETING));
  expect(zoom.isGuest).toBe(false);
});

test('onCollaborateChange carries no state: the running context is read again, each time', async () => {
  const sdk = await started();
  await waitFor(() => expect(zoom.meetingContext?.meetingUUID).toBe(MEETING));
  const reads = sdk.getRunningContext.mock.calls.length;
  sdk.runningContext = 'inCollaborate';
  await fire(sdk, 'onCollaborateChange', { action: 'start', timestamp: 1 });
  await waitFor(() => expect(zoom.inCollaborate).toBe(true));
  expect(sdk.getRunningContext.mock.calls.length).toBe(reads + 1);
  // still the same meeting for everything else in the panel
  expect(zoom.runningContext).toBe('inMeeting');
  expect(zoom.meetingContext?.meetingUUID).toBe(MEETING);

  sdk.runningContext = 'inMeeting';
  await fire(sdk, 'onCollaborateChange', undefined);
  await waitFor(() => expect(zoom.inCollaborate).toBe(false));
  expect([zoom.runningContext, zoom.meetingContext?.meetingUUID]).toEqual(['inMeeting', MEETING]);
});

test('onRunningContextChange into and out of Collaborate keeps the meeting', async () => {
  const sdk = await started();
  await waitFor(() => expect(zoom.meetingContext?.meetingUUID).toBe(MEETING));
  await fire(sdk, 'onRunningContextChange', { runningContext: 'inCollaborate' });
  await waitFor(() => expect(zoom.inCollaborate).toBe(true));
  expect([zoom.runningContext, zoom.meetingContext?.meetingUUID]).toEqual(['inMeeting', MEETING]);
  await fire(sdk, 'onRunningContextChange', { runningContext: 'inMeeting' });
  await waitFor(() => expect(zoom.inCollaborate).toBe(false));
  expect(zoom.meetingContext?.meetingUUID).toBe(MEETING);
  // out of the meeting altogether: no meeting, as before
  await fire(sdk, 'onRunningContextChange', { runningContext: 'inMainClient' });
  await waitFor(() => expect(zoom.meetingContext).toBeNull());
  expect([zoom.runningContext, zoom.inCollaborate]).toEqual(['inMainClient', false]);
});

test('Zoom does not answer for the meeting while in Collaborate: the meeting the panel was in is kept', async () => {
  const sdk = await started();
  await waitFor(() => expect(zoom.meetingContext?.meetingUUID).toBe(MEETING));
  sdk.getMeetingUUID.mockImplementation(async () => { throw new Error('not in this context'); });
  sdk.getMeetingContext.mockImplementation(async () => { throw new Error('not in this context'); });
  await fire(sdk, 'onRunningContextChange', { runningContext: 'inCollaborate' });
  await waitFor(() => expect(zoom.inCollaborate).toBe(true));
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(zoom.meetingContext?.meetingUUID).toBe(MEETING);
});

test('a re-read that fails, or answers nothing usable, changes nothing', async () => {
  const sdk = await started();
  sdk.getRunningContext.mockImplementation(async () => { throw new Error('no'); });
  await fire(sdk, 'onCollaborateChange', {});
  sdk.getRunningContext.mockImplementation(async () => ({ context: 7 }));
  await fire(sdk, 'onCollaborateChange', {});
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect([zoom.runningContext, zoom.inCollaborate]).toEqual(['inMeeting', false]);
});

test('a client that did not take onCollaborateChange is not listened to for it', async () => {
  const sdk = await started({ unsupportedApis: ['onCollaborateChange'] });
  const reads = sdk.getRunningContext.mock.calls.length;
  sdk.runningContext = 'inCollaborate';
  await fire(sdk, 'onCollaborateChange', {});
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(sdk.getRunningContext.mock.calls.length).toBe(reads);
  expect(zoom.inCollaborate).toBe(false);
});
