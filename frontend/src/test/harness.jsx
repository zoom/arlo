/**
 * Test doubles for running the real app as it runs inside a Zoom meeting:
 * a fake Zoom Apps SDK, a fake WebSocket the test can speak through as the
 * server, and a fetch router. The app code under test is not mocked.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import App from '../App';

export const MEETING = 'MEETING-1==';

/**
 * Arlo's routes for the test meeting: arloPath('state' | 'settings' | 'notes' | 'ask' |
 * 'notes-request' | 'approvals' | 'approvals/<id>').
 * `meetingId`: the id the server knows the meeting by, when a test makes it
 * differ from the one the Zoom SDK reports (see mockFetch `serverMeetingId`).
 */
export const arloPath = (name, meetingId = MEETING) => `/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${name}`;

/**
 * What the server says about Arlo before anyone brought it in. `paused` is
 * about the meeting (true only when every live stream is paused);
 * `myStreamPaused` is about the own stream of the person it is sent to.
 */
export const ARLO_ABSENT = Object.freeze({
  present: false, paused: false, myStreamPaused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner',
});

/** Fake `window.zoomSdk`. `sdk.emit(event, payload)` fires an SDK event. */
export function createZoomSdk({
  status = 'authorized',
  role = 'host',
  screenName = 'Ana',
  rtmsStatus = [],
  startRTMS = async () => ({ message: 'Success' }),
  runningContext = 'inMeeting',
  userContextFails = false, // outside a meeting Zoom may not answer getUserContext
  // The meeting id the SDK reports. The server may know the meeting by another
  // id (mockFetch `serverMeetingId`): the SDK path has fallbacks.
  meetingUUID = MEETING,
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
    getMeetingUUID: vi.fn(async () => ({ meetingUUID })),
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
    // Dynamic Indicator: Arlo's status in Zoom's own meeting window
    setDynamicIndicator: vi.fn(async () => ({ message: 'Success' })),
    removeDynamicIndicator: vi.fn(async () => ({ message: 'Success' })),
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
 *
 * `serverMeetingId`: the meeting id inside the verified app context, which the
 * meeting-access check returns and Arlo's routes are served under. Give
 * createZoomSdk another `meetingUUID` (and send messages from
 * `serverMessagesFor(serverMeetingId)`) to make the SDK and the server disagree.
 */
export function mockFetch(routes = {}, { signedIn = true, serverMeetingId = MEETING } = {}) {
  // The app context is signed by Zoom for the meeting the client is in: the
  // access check answers with that meeting, unless the test makes the two
  // differ. Read without calling the mock, so its call count stays the app's.
  const sdkMeetingId = async () => {
    const answer = await window.zoomSdk?.getMeetingUUID?.getMockImplementation?.()?.();
    return answer?.meetingUUID || MEETING;
  };
  const verifiedMeetingId = async () => (serverMeetingId === MEETING ? sdkMeetingId() : serverMeetingId);
  const table = {
    '/api/auth/me': () => (signedIn
      ? json({ user: { id: 'user-1', displayName: 'Ana' } })
      : json({ error: 'Not authenticated' }, 401)),
    // Tests run with the deployment's auto-start flag ON unless a test overrides
    // this route, so `renderInMeeting({ autoStart })` alone decides the behaviour.
    // The same goes for "Use Arlo yourself" (ownStream), which a deployment has off by default.
    '/api/auth/settings': () => json({ demoMode: true, features: { autoStart: true, ownStream: true } }),
    '/api/auth/meeting-access': async () => json({ verified: true, isGuest: !signedIn, meetingId: await verifiedMeetingId() }),
    // Arlo's routes: not in the meeting, nobody's notes, until a test says otherwise
    [arloPath('state', serverMeetingId)]: () => json({ ...ARLO_ABSENT }),
    // The caller's state, as the server answers it: an owner the server has a name for
    [`PUT ${arloPath('settings', serverMeetingId)}`]: ({ body }) => json({
      ...ARLO_ABSENT, role: 'owner', ownerName: 'Ana', whoCanAsk: body?.whoCanAsk,
    }),
    [arloPath('notes', serverMeetingId)]: () => json({ notes: null }),
    [`POST ${arloPath('ask', serverMeetingId)}`]: () => json({ answer: 'Arlo answers from the transcript.' }),
    // Requests for the owner's approval: none open; asking and answering work
    [arloPath('approvals', serverMeetingId)]: () => json({ approvals: [] }),
    [`POST ${arloPath('approvals/', serverMeetingId)}`]: ({ url, body }) => json({
      id: url.split('/').pop(), outcome: body?.approve ? (body.done ? 'approved' : 'failed') : 'declined',
    }),
    [`POST ${arloPath('notes-request', serverMeetingId)}`]: () => json({
      id: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60000,
    }),
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

/** Messages the server sends about one meeting, in the shapes the backend uses. */
export const serverMessagesFor = (ofMeeting) => ({
  status: (status, extra = {}) => ({ type: 'meeting.status', data: { meetingId: ofMeeting, status, ...extra } }),
  requestStatus: (status) => ({ type: 'rtms.request_status', data: { meetingId: ofMeeting, status } }),
  // `state` may set `paused` (the meeting) and `myStreamPaused` (the receiver's
  // own stream); both are false unless given
  arloState: (state = {}, meetingId = ofMeeting) => ({
    type: 'arlo.state', data: { meetingId, ...ARLO_ABSENT, ...state },
  }),
  notes: (notes, meetingId = ofMeeting) => ({ type: 'notes.updated', data: { meetingId, notes } }),
  // A request for the owners' approval, as only their panels are told; it runs out in a minute unless given
  approval: ({ id, kind = 'share_notes', askedBy = null, expiresAt = Date.now() + 60000 }, meetingId = ofMeeting) => ({
    type: 'arlo.approval', data: { meetingId, id, kind, askedBy, expiresAt },
  }),
  // How it ended: 'approved' | 'declined' | 'failed' | 'expired'
  approvalClosed: (id, outcome, meetingId = ofMeeting) => ({
    type: 'arlo.approval.closed', data: { meetingId, id, outcome },
  }),
  timelineEvent: (event) => ({ type: 'participant.event', data: { meetingId: ofMeeting, event } }),
  suggestion: (suggestion) => ({ type: 'ai.suggestion', data: { meetingId: ofMeeting, suggestion } }),
  segment: (seqNo, text, extra = {}) => ({
    type: 'transcript.segment',
    data: {
      meetingId: ofMeeting,
      segment: {
        seqNo, text, speakerId: '1', speakerLabel: 'Ana', tStartMs: 1000 * seqNo, tEndMs: 1000 * seqNo, ...extra,
      },
    },
  }),
});

/** The server's messages about the test meeting. */
export const serverMessage = serverMessagesFor(MEETING);

/**
 * Render the real app inside a (fake) Zoom meeting, on the in-meeting route:
 * the single-action Arlo screens. `page: 'record'` opens the meeting record,
 * `page: 'classic'` the earlier dashboard.
 * Auto-start is off unless asked for, so each test decides when a start happens.
 * `routeMeetingId`: the meeting id in the address (the one the SDK reports).
 */
export function renderInMeeting({
  sdk = createZoomSdk(), autoStart = false, guest = false, page = null, routeMeetingId = MEETING,
} = {}) {
  window.zoomSdk = sdk;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-vertical', 'notes');
  localStorage.setItem('arlo-auto-start', autoStart ? 'true' : 'false');
  const route = guest ? 'guest-meeting' : 'meeting';
  window.location.hash = `#/${route}/${encodeURIComponent(routeMeetingId)}${page ? `/${page}` : ''}`;
  return { sdk, ...render(<App />) };
}

/** The earlier dashboard (InMeetingView), kept at the classic route. */
export const renderClassic = (options = {}) => renderInMeeting({ ...options, page: 'classic' });

/** Undo what renderInMeeting and mockFetch installed. */
export function resetHarness() {
  delete window.zoomSdk;
  vi.unstubAllGlobals();
  window.location.hash = '#/';
}
