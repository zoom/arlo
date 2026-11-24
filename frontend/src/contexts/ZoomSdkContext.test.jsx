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
  };
}
const ALL = { chat: true, waitingRoom: true, indicator: true, rtmsStatus: true };

afterEach(resetHarness);

test('a client that accepts everything and lists nothing as unsupported has all four', async () => {
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

test('the waiting-room APIs refused at config: the smaller set is asked for, and they are not supported although the methods exist', async () => {
  const flags = await configured({ waitingRoomRefused: true });
  expect(typeof window.zoomSdk.getWaitingRoomParticipants).toBe('function');
  expect(flags).toEqual({ ...ALL, waitingRoom: false });
  expect(window.zoomSdk.config).toHaveBeenCalledTimes(2);
});
