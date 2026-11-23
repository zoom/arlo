/**
 * Test doubles for running the real app as it runs inside a Zoom meeting:
 * a fake Zoom Apps SDK, a fake WebSocket the test can speak through as the
 * server, and a fetch router. The app code under test is not mocked.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import App from '../App';

export const MEETING = 'MEETING-1==';

/** Fake `window.zoomSdk`. `sdk.emit(event, payload)` fires an SDK event. */
export function createZoomSdk({
  status = 'authorized',
  role = 'host',
  screenName = 'Ana',
  rtmsStatus = [],
  startRTMS = async () => ({ message: 'Success' }),
  runningContext = 'inMeeting',
  userContextFails = false, // outside a meeting Zoom may not answer getUserContext
} = {}) {
  const listeners = new Map();
  const on = (event) => (handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
  };
  const sdk = {
    rtmsStatus,
    config: vi.fn(async ({ capabilities }) => ({ clientVersion: '6.6.0', capabilities })),
    getRunningContext: vi.fn(async () => ({ context: runningContext })),
    getUserContext: vi.fn(async () => {
      if (userContextFails) throw new Error('getUserContext is not available in this context');
      return { status, role, screenName };
    }),
    getMeetingUUID: vi.fn(async () => ({ meetingUUID: MEETING })),
    getMeetingContext: vi.fn(async () => ({ meetingTopic: 'Planning', meetingID: '123456' })),
    getAppContext: vi.fn(async () => ({ context: 'signed-app-context' })),
    getRTMSStatus: vi.fn(async () => ({ rtmsStatus: sdk.rtmsStatus })),
    getMeetingParticipants: vi.fn(async () => ({ participants: [] })),
    onRunningContextChange: on('onRunningContextChange'),
    onMyUserContextChange: on('onMyUserContextChange'),
    onSendAppInvitation: on('onSendAppInvitation'),
    onCollaborateChange: on('onCollaborateChange'),
    onMessage: on('onMessage'),
    addEventListener: (event, handler) => on(event)(handler),
    removeEventListener: (event, handler) => listeners.get(event)?.delete(handler),
    authorize: vi.fn(async () => ({ message: 'Success' })),
    showNotification: vi.fn(async () => ({})),
    sendMessageToChat: vi.fn(async () => ({})),
    sendAppInvitationToAllParticipants: vi.fn(async () => ({})),
    showAppInvitationDialog: vi.fn(async () => ({})),
    startCollaborate: vi.fn(async () => ({})),
    endCollaborate: vi.fn(async () => ({})),
    // RTMS controls: the app calls start through callZoomApi (it passes media
    // options) and the others through the documented methods.
    startRTMS: vi.fn(startRTMS),
    stopRTMS: vi.fn(async () => ({ message: 'Success' })),
    pauseRTMS: vi.fn(async () => ({ message: 'Success' })),
    resumeRTMS: vi.fn(async () => ({ message: 'Success' })),
    callZoomApi: vi.fn(async (name, options) => sdk[name](options)),
    emit(event, payload) {
      [...(listeners.get(event) || [])].forEach((handler) => handler(payload));
    },
  };
  return sdk;
}

/** Fake browser WebSocket. The test plays the server with `serverSend`. */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Set();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  addEventListener(type, handler) {
    if (type === 'message') this.listeners.add(handler);
  }

  removeEventListener(type, handler) {
    if (type === 'message') this.listeners.delete(handler);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  serverSend(message) {
    const event = { data: JSON.stringify(message) };
    this.onmessage?.(event);
    [...this.listeners].forEach((handler) => handler(event));
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Route fetch by "METHOD /path" or "/path" prefix. Unlisted API calls answer
 * 200 {} the way the demo-mode stubs do. Returns the mock to inspect calls.
 */
export function mockFetch(routes = {}, { signedIn = true } = {}) {
  const table = {
    '/api/auth/me': () => (signedIn
      ? json({ user: { id: 'user-1', displayName: 'Ana' } })
      : json({ error: 'Not authenticated' }, 401)),
    '/api/auth/settings': () => json({ demoMode: true }),
    '/api/auth/meeting-access': () => json({ verified: true, isGuest: !signedIn, meetingId: MEETING }),
    ...routes,
  };
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((route) => {
        const [routeMethod, routePath] = route.includes(' ') ? route.split(' ') : [null, route];
        return (!routeMethod || routeMethod === method) && url.startsWith(routePath);
      });
    if (!key) return json({});
    const body = init.body ? JSON.parse(init.body) : undefined;
    return table[key]({ url, method, body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export { json };

/** Messages the server sends, in the shapes the backend uses. */
export const serverMessage = {
  status: (status, extra = {}) => ({ type: 'meeting.status', data: { meetingId: MEETING, status, ...extra } }),
  requestStatus: (status) => ({ type: 'rtms.request_status', data: { meetingId: MEETING, status } }),
  segment: (seqNo, text, extra = {}) => ({
    type: 'transcript.segment',
    data: {
      meetingId: MEETING,
      segment: {
        seqNo, text, speakerId: '1', speakerLabel: 'Ana', tStartMs: 1000 * seqNo, tEndMs: 1000 * seqNo, ...extra,
      },
    },
  }),
};

/**
 * Render the real app inside a (fake) Zoom meeting, on the in-meeting route.
 * Auto-start is off unless asked for, so each test decides when a start happens.
 */
export function renderInMeeting({ sdk = createZoomSdk(), autoStart = false, guest = false } = {}) {
  window.zoomSdk = sdk;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-vertical', 'notes');
  localStorage.setItem('arlo-auto-start', autoStart ? 'true' : 'false');
  window.location.hash = guest
    ? `#/guest-meeting/${encodeURIComponent(MEETING)}`
    : `#/meeting/${encodeURIComponent(MEETING)}`;
  return { sdk, ...render(<App />) };
}

/** Undo what renderInMeeting and mockFetch installed. */
export function resetHarness() {
  delete window.zoomSdk;
  vi.unstubAllGlobals();
  window.location.hash = '#/';
}
