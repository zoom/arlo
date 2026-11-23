import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';

// Where the app lands: the single-action Arlo screens are the in-meeting view,
// the meeting record sits next to them, and the earlier dashboard is reached
// from Settings only.

const ID = encodeURIComponent(MEETING);
const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const socketOpen = () => waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS');
const ANA_BROUGHT_ARLO = { ...ARLO_ABSENT, present: true, role: 'participant', ownerName: 'Ana' };

/** Open the app the way Zoom does: at the root, which decides where to go. */
function openApp({ sdk = createZoomSdk(), hash = '#/' } = {}) {
  window.zoomSdk = sdk;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-vertical', 'notes');
  localStorage.setItem('arlo-auto-start', 'false');
  window.location.hash = hash;
  return { sdk, ...render(<App />) };
}

afterEach(() => { resetHarness(); localStorage.clear(); });

describe('opening Arlo in a meeting', () => {
  test('a signed-in host lands on "Bring Arlo into this meeting", and nothing is requested', async () => {
    mockFetch();
    const { sdk } = openApp();
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
    expect(screen.queryByText('Transcription not started')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(startCalls(sdk)).toHaveLength(0);
  });

  test('a guest lands on the participant screen, not the dashboard', async () => {
    mockFetch({ [arloPath('state')]: () => json(ANA_BROUGHT_ARLO) }, { signedIn: false });
    openApp({ sdk: createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' }) });
    expect(await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/guest-meeting/${ID}`);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  test('the temporary routes are gone', async () => {
    mockFetch();
    openApp({ hash: `#/arlo/${ID}` });
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();
  });
});

describe('the meeting record link', () => {
  test('signed in: the link opens the record and Back returns to the Arlo screen', async () => {
    mockFetch({ [arloPath('state')]: () => json({ ...ANA_BROUGHT_ARLO, role: 'owner' }) });
    renderInMeeting();
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said in the meeting.'));
    await screen.findByText('Arlo is in the meeting');

    await userEvent.click(screen.getByRole('link', { name: 'Meeting record' }));
    expect(await screen.findByRole('heading', { name: 'Meeting record' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}/record`);
    expect(screen.getByText('Said in the meeting.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
    expect(screen.queryByText('Said in the meeting.')).not.toBeInTheDocument();
  });

  test('the header back arrow on the record returns to the Arlo screen, not home', async () => {
    mockFetch();
    renderInMeeting({ page: 'record' });
    await screen.findByRole('heading', { name: 'Meeting record' });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('guest: the link opens the record and Back returns to the guest screen', async () => {
    mockFetch({ [arloPath('state')]: () => json(ANA_BROUGHT_ARLO) }, { signedIn: false });
    renderInMeeting({ guest: true, sdk: createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' }) });
    await socketOpen();
    await send(serverMessage.segment(1, 'Said in the meeting.'));

    await userEvent.click(await screen.findByRole('link', { name: 'Meeting record' }));
    expect(await screen.findByRole('heading', { name: 'Meeting record' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/guest-meeting/${ID}/record`);
    expect(screen.getByText('Said in the meeting.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/guest-meeting/${ID}`);
  });
});

describe('home', () => {
  const openHome = (routes, sdkOptions) => {
    const fetchMock = mockFetch(routes);
    const result = openApp({ sdk: createZoomSdk(sdkOptions), hash: '#/home' });
    return { ...result, fetchMock };
  };

  test('in demo mode: the name, the demo line and how to bring Arlo in; no list, search or ask input', async () => {
    const { fetchMock } = openHome({}, { runningContext: 'inMainClient' });
    expect(await screen.findByRole('heading', { name: 'Arlo' })).toBeInTheDocument();
    expect(screen.getByText('Demo mode: meetings and notes are not stored.')).toBeInTheDocument();
    expect(screen.getByText('Open Arlo from a Zoom meeting to bring it in.')).toBeInTheDocument();

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View all meetings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Hi, /)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to the meeting' })).not.toBeInTheDocument();
    // Nothing is asked of the routes that are stubs in demo mode
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked.filter((url) => url.startsWith('/api/home') || url.startsWith('/api/zoom-meetings'))).toEqual([]);
  });

  test('in demo mode inside a meeting, one link leads back to the Arlo screen', async () => {
    openHome();
    await userEvent.click(await screen.findByRole('link', { name: 'Back to the meeting' }));
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('with demo mode off the existing home stays, with search in the header', async () => {
    openHome(
      { '/api/auth/settings': () => json({ demoMode: false, features: { meetingHistory: true, search: true } }) },
      { runningContext: 'inMainClient' },
    );
    expect(await screen.findByRole('heading', { name: 'Hi, Ana' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View all meetings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByText('Demo mode: meetings and notes are not stored.')).not.toBeInTheDocument();
  });
});

describe('the classic dashboard', () => {
  test('Settings in a meeting has one row that opens it', async () => {
    mockFetch();
    openApp({ hash: '#/settings' });
    expect(await screen.findByText('The earlier dashboard, kept while the new screens are tried.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Classic dashboard' }));

    expect(await screen.findByText('Transcription not started')).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}/classic`);
    expect(screen.queryByRole('heading', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();
  });

  test('Settings outside a meeting has no such row', async () => {
    mockFetch();
    openApp({ sdk: createZoomSdk({ runningContext: 'inMainClient' }), hash: '#/settings' });
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('link', { name: 'Classic dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText(/The earlier dashboard/)).not.toBeInTheDocument();
  });

  test('it stays put while the meeting goes on, and its back arrow returns to the Arlo screen', async () => {
    mockFetch();
    renderInMeeting({ page: 'classic' });
    await screen.findByText('Transcription not started');
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState({ present: true, role: 'owner', ownerName: 'Ana' }));
    await send(serverMessage.segment(1, 'Said in the meeting.'));
    await screen.findByText('Transcribing');
    expect(window.location.hash).toBe(`#/meeting/${ID}/classic`);

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('the "live meeting" banner leads to the Arlo screen, never the classic dashboard', async () => {
    mockFetch({ [arloPath('state')]: () => json({ ...ANA_BROUGHT_ARLO, role: 'owner' }) });
    renderInMeeting();
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await screen.findByText('Arlo is in the meeting');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

    await userEvent.click(await screen.findByText('Live meeting in progress'));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });
});
