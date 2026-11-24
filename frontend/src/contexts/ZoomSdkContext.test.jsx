import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { createZoomSdk, resetHarness } from '../test/harness';
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
  };
}
const ALL = {
  chat: true, waitingRoom: true, indicator: true, rtmsStatus: true, invitation: true, reaction: true, mute: true,
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
])('%s accepted at config but listed in unsupportedApis is not supported', async (api, lost) => {
  expect(await configured({ unsupportedApis: [api] })).toEqual({ ...ALL, ...lost });
  // Zoom accepted the first, largest set: nothing was asked again
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(1);
});

test('an API of another tier in the list takes nothing away', async () => {
  expect(await configured({ unsupportedApis: ['startCollaborate', 'runRenderingContext'] })).toEqual(ALL);
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
  expect(flags).toEqual({ ...ALL, waitingRoom: false, reaction: false, mute: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(4);
});

test('the first set asked for has the reaction and participant-audio APIs', async () => {
  await configured();
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(1);
  expect(lastCapabilities()).toEqual(expect.arrayContaining([
    'setEmojiReaction', 'getEmojiConfiguration', 'toggleParticipantMediaAudio', 'getMeetingParticipants',
    'sendAppInvitationToAllParticipants', 'getWaitingRoomParticipants',
  ]));
});

test('getEmojiConfiguration listed as unsupported takes no reaction away: only setEmojiReaction is called', async () => {
  expect(await configured({ unsupportedApis: ['getEmojiConfiguration'] })).toEqual(ALL);
});

test('the reaction APIs refused at config: one smaller set, and everything else stays, muting too', async () => {
  const flags = await configured({ refusedApis: ['setEmojiReaction'] });
  expect(typeof window.zoomSdk.setEmojiReaction).toBe('function');
  expect(flags).toEqual({ ...ALL, reaction: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(2);
  expect(lastCapabilities()).toContain('toggleParticipantMediaAudio');
  expect(lastCapabilities()).not.toContain('getEmojiConfiguration');
});

test('the participant-audio API refused at config: two smaller sets, reactions go with it, the waiting room stays', async () => {
  const flags = await configured({ refusedApis: ['toggleParticipantMediaAudio'] });
  expect(typeof window.zoomSdk.toggleParticipantMediaAudio).toBe('function');
  expect(flags).toEqual({ ...ALL, reaction: false, mute: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(3);
  expect(lastCapabilities()).toContain('getWaitingRoomParticipants');
});

test('both new tiers and the waiting room refused: what the client had before is kept', async () => {
  const flags = await configured({ refusedApis: ['setEmojiReaction', 'toggleParticipantMediaAudio'], waitingRoomRefused: true });
  expect(flags).toEqual({ ...ALL, reaction: false, mute: false, waitingRoom: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(4);
});

test('a client that takes the core set only: every set is tried once, largest first, and nothing optional is supported', async () => {
  const flags = await configured({ refusedApis: ['getMeetingParticipants'] });
  expect(flags).toEqual({
    chat: true, waitingRoom: false, indicator: false, rtmsStatus: false, invitation: false, reaction: false, mute: false,
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
  render(<ZoomSdkProvider><Probe /></ZoomSdkProvider>);
  await waitFor(() => expect(zoom.sdkConfigured).toBe(true));
  expect(zoom.reactionSupported).toBe(false);
  expect(zoom.muteSupported).toBe(false);
  expect(zoom.invitationSupported).toBe(false);
});
