import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../App';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, resetHarness, arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';

// Settings → Connectors → GitHub, through the real app inside a (fake) Zoom
// meeting: the row's three states, connecting through the system browser,
// the wait for word that the account is connected, and disconnecting.

const TICKET = 'tK3'.repeat(14) + 'Q';
const START = `${window.location.origin}/api/connectors/github/start?ticket=${TICKET}`;
const NOT_SET_UP = { available: false, connected: false, login: null };
const NOT_CONNECTED = { available: true, connected: false, login: null };
const CONNECTED = { available: true, connected: true, login: 'octo-ana' };

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const CONNECTORS_UPDATED = { type: 'connectors.updated', data: { github: { connected: true } } };

/**
 * Open Settings. `connectors`: what GET /api/connectors answers, as a value
 * the test can change (`current.github = …`); `current.reply`, when set,
 * answers instead (a slow read).
 */
async function openSettings({
  github = NOT_CONNECTED, sdk = createZoomSdk(), signedIn = true, routes = {}, ticket = () => json({ url: START }), viaMeeting = false,
} = {}) {
  const current = { github };
  const fetchMock = mockFetch({
    '/api/connectors': () => {
      if (current.reply) return current.reply();
      return signedIn ? json({ github: current.github }) : json({ error: 'Not authenticated' }, 401);
    },
    'POST /api/connectors/github/ticket': ticket,
    'DELETE /api/connectors/github': () => { current.github = NOT_CONNECTED; return json({ connected: false }); },
    [arloPath('state')]: () => json({ ...ARLO_ABSENT }),
    ...routes,
  }, { signedIn });
  window.zoomSdk = sdk;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-vertical', 'notes');
  localStorage.setItem('arlo-auto-start', 'false');
  // The socket is the meeting's: it is opened by the meeting's screen and stays when Settings is opened from there
  window.location.hash = viaMeeting ? `#/meeting/${encodeURIComponent(MEETING)}` : '#/settings';
  const view = render(<App />);
  if (viaMeeting) {
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await act(async () => { window.location.hash = '#/settings'; });
  }
  if (signedIn) await screen.findByRole('heading', { name: 'Settings' });
  return { sdk, current, fetchMock, unmount: view.unmount };
}

const becomeVisible = () => act(async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const connectorReads = (fetchMock) => fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/connectors' && !init?.method).length;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('the GitHub row', () => {
  test('GitHub is not set up on the server: it says so, with no button', async () => {
    await openSettings({ github: NOT_SET_UP });
    expect(await screen.findByRole('heading', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.getByText('GitHub is not set up on this server.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  test('available and not connected: "Not connected" and "Connect GitHub"', async () => {
    await openSettings();
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  });

  test('connected: the login and "Disconnect"', async () => {
    await openSettings({ github: CONNECTED });
    expect(await screen.findByText('Connected as octo-ana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  test('a login that is no GitHub login is not shown', async () => {
    await openSettings({ github: { ...CONNECTED, login: '<img src=x onerror=alert(1)>' } });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  test('the request is made with the session cookie', async () => {
    const { fetchMock } = await openSettings();
    await screen.findByText('Not connected');
    expect(fetchMock).toHaveBeenCalledWith('/api/connectors', { credentials: 'include' });
  });

  test('no section while the server has not said how things stand', async () => {
    await openSettings({ routes: { '/api/connectors': () => json({ error: 'x' }, 500) } });
    await screen.findByRole('heading', { name: 'Transcription Preferences' });
    expect(screen.queryByRole('heading', { name: 'Connectors' })).not.toBeInTheDocument();
  });
});

describe('connecting', () => {
  test('asks for a ticket and opens exactly that URL with Zoom; the row then waits', async () => {
    const { sdk, fetchMock } = await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText('Finish in your browser…')).toBeInTheDocument();
    expect(sdk.openUrl).toHaveBeenCalledTimes(1);
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: START });
    expect(fetchMock).toHaveBeenCalledWith('/api/connectors/github/ticket', expect.objectContaining({ method: 'POST', credentials: 'include', body: '{}' }));
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    // Neither the URL nor the ticket is on the page
    expect(document.body.textContent).not.toContain(TICKET);
    expect(document.body.textContent).not.toContain('/api/connectors/github/start');
  });

  test.each([
    ['another origin', `https://evil.example/api/connectors/github/start?ticket=${TICKET}`],
    ['an extra query', `${START}&redirect=https://evil.example`],
    ['a short ticket', START.slice(0, -5)],
  ])('%s from the server: nothing is opened, and an error toast', async (_name, url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { sdk } = await openSettings({ ticket: () => json({ url }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText('Couldn\'t connect GitHub. Try again.')).toBeInTheDocument();
    expect(sdk.openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  });

  test('the server gives no ticket: an error toast', async () => {
    const { sdk } = await openSettings({ ticket: () => json({ error: 'x' }, 503) });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('Couldn\'t connect GitHub. Try again.')).toBeInTheDocument();
    expect(sdk.openUrl).not.toHaveBeenCalled();
  });

  test('Zoom refuses to open the browser: it says so, and the button is back', async () => {
    const sdk = createZoomSdk();
    sdk.openUrl = vi.fn(async () => { throw Object.assign(new Error(`not allowed: ${START}`), { code: '10015' }); });
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await openSettings({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText('Zoom could not open the browser.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(screen.queryByText('Finish in your browser…')).not.toBeInTheDocument();
    const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')).join('\n');
    expect(logged).not.toContain(TICKET);
  });

  test('"connectors.updated" on the socket: the server is asked again and the row says who is connected', async () => {
    const { current, fetchMock } = await openSettings({ viaMeeting: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('Finish in your browser…');
    const before = connectorReads(fetchMock);

    current.github = CONNECTED;
    // What the message carries is not believed: only the server's answer is
    await send({ type: 'connectors.updated', data: { github: { connected: true, login: 'someone-else' } } });

    expect(await screen.findByText('Connected as octo-ana')).toBeInTheDocument();
    expect(connectorReads(fetchMock)).toBe(before + 1);
    expect(screen.queryByText('Finish in your browser…')).not.toBeInTheDocument();
    expect(screen.queryByText('someone-else')).not.toBeInTheDocument();
  });

  test('the panel comes back into view: the server is asked again', async () => {
    const { current } = await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('Finish in your browser…');

    current.github = CONNECTED;
    await becomeVisible();
    expect(await screen.findByText('Connected as octo-ana')).toBeInTheDocument();
  });

  test('back in view and still not connected: the server is asked, and the row keeps waiting', async () => {
    const { sdk, fetchMock } = await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('Finish in your browser…');
    const before = connectorReads(fetchMock);

    await becomeVisible();
    await waitFor(() => expect(connectorReads(fetchMock)).toBe(before + 1));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
    expect(sdk.openUrl).toHaveBeenCalledTimes(1);
  });

  test('five minutes without word: "That took too long. Try again.", not before', async () => {
    await openSettings();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await screen.findByRole('button', { name: 'Connect GitHub' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('Finish in your browser…');

    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 - 2000); });
    expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('That took too long. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(screen.queryByText('Finish in your browser…')).not.toBeInTheDocument();
  });

  describe('asking the server while it waits (no socket, the panel never loses the focus)', () => {
    /** Settings outside a meeting, "Connect GitHub" clicked, the clock in the test's hands. */
    async function waiting(options) {
      const opened = await openSettings(options);
      await screen.findByRole('button', { name: 'Connect GitHub' });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
      expect(FakeWebSocket.instances).toHaveLength(0);
      return { ...opened, reads: () => connectorReads(opened.fetchMock) };
    }
    const pass = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    test('every 3 seconds; connected on the third read, and then it stops asking', async () => {
      const { current, reads } = await waiting();
      const before = reads();

      await pass(2900);
      expect(reads()).toBe(before);
      await pass(100);
      expect(reads()).toBe(before + 1);
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
      await pass(3000);
      expect(reads()).toBe(before + 2);
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();

      current.github = CONNECTED;
      await pass(3000);
      expect(reads()).toBe(before + 3);
      expect(screen.getByText('Connected as octo-ana')).toBeInTheDocument();
      expect(screen.queryByText('Finish in your browser…')).not.toBeInTheDocument();

      await pass(30000);
      expect(reads()).toBe(before + 3);
    });

    test('a read that fails is passed over without a word, and the next one is still made', async () => {
      const { current, reads } = await waiting();
      const before = reads();
      current.reply = () => json({ error: 'Internal error' }, 500);
      await pass(3000);
      current.reply = () => { throw new TypeError('Failed to fetch'); };
      await pass(3000);
      expect(reads()).toBe(before + 2);
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
      expect(screen.queryByText(/Couldn't/)).not.toBeInTheDocument();

      current.reply = null;
      current.github = CONNECTED;
      await pass(3000);
      expect(screen.getByText('Connected as octo-ana')).toBeInTheDocument();
    });

    test('a slow read: no second one is sent while it is out, and none is owed after it', async () => {
      const { current, reads } = await waiting();
      const before = reads();
      let answer;
      current.reply = () => new Promise((resolve) => { answer = resolve; });

      await pass(3000);
      expect(reads()).toBe(before + 1);
      await pass(12000);
      expect(reads()).toBe(before + 1);

      current.reply = null;
      await act(async () => { answer(json({ github: NOT_CONNECTED })); await vi.advanceTimersByTimeAsync(0); });
      expect(reads()).toBe(before + 1);
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
      await pass(3000);
      expect(reads()).toBe(before + 2);
    });

    test('five minutes of "not connected": it took too long, and nothing is asked after that', async () => {
      const { reads } = await waiting();
      await pass(5 * 60 * 1000 - 1000);
      expect(screen.getByText('Finish in your browser…')).toBeInTheDocument();
      await pass(1000);
      expect(screen.getByText('That took too long. Try again.')).toBeInTheDocument();

      const after = reads();
      await pass(30000);
      expect(reads()).toBe(after);
    });

    test('signed out while it waits: nothing is asked any more', async () => {
      const { fetchMock, reads } = await waiting();
      // The session is gone: the next API call is refused and the app checks who is signed in
      fetchMock.mockImplementation(async () => json({ error: 'Not authenticated' }, 401));
      await pass(3000);
      await pass(0);
      expect(screen.queryByText('Finish in your browser…')).not.toBeInTheDocument();

      const after = reads();
      await pass(30000);
      expect(reads()).toBe(after);
    });

    test('the app goes away while it waits: nothing is asked any more', async () => {
      const { unmount, reads } = await waiting();
      await pass(3000);
      const after = reads();
      unmount();
      await pass(30000);
      expect(reads()).toBe(after);
    });
  });

  test('a change told on the socket without a connect under way is read too (connected elsewhere)', async () => {
    const { current } = await openSettings({ viaMeeting: true });
    await screen.findByText('Not connected');
    current.github = CONNECTED;
    await send(CONNECTORS_UPDATED);
    expect(await screen.findByText('Connected as octo-ana')).toBeInTheDocument();
  });
});

describe('disconnecting', () => {
  test('the first click only asks; "Cancel" and Escape leave the account connected', async () => {
    const { fetchMock } = await openSettings({ github: CONNECTED });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    const group = screen.getByRole('group', { name: 'Disconnect GitHub?' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Disconnect GitHub?' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Disconnect GitHub?' })).not.toBeInTheDocument();
    expect(screen.getByText('Connected as octo-ana')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  test('"Disconnect" in the question disconnects, with the session cookie', async () => {
    const { fetchMock } = await openSettings({ github: CONNECTED });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('GitHub disconnected')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/connectors/github', { method: 'DELETE', credentials: 'include' });
    expect(screen.queryByText('Connected as octo-ana')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  });

  test('the server refuses: an error toast, and the account stays as it is', async () => {
    await openSettings({ github: CONNECTED, routes: { 'DELETE /api/connectors/github': () => json({ error: 'x' }, 500) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Couldn\'t disconnect GitHub. Try again.')).toBeInTheDocument();
    expect(screen.getByText('Connected as octo-ana')).toBeInTheDocument();
  });
});

describe('who has connectors', () => {
  test('a signed-out person is never asked about and sees no row', async () => {
    const { fetchMock } = await openSettings({ signedIn: false });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.anything()));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(connectorReads(fetchMock)).toBe(0);
    expect(screen.queryByRole('heading', { name: 'Connectors' })).not.toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
  });

  test('signing out drops what was known at once', async () => {
    const { fetchMock } = await openSettings({ github: CONNECTED });
    await screen.findByText('Connected as octo-ana');
    // The session is gone: the next API call is refused and the app checks who is signed in
    fetchMock.mockImplementation(async () => json({ error: 'Not authenticated' }, 401));
    await becomeVisible();
    await waitFor(() => expect(screen.queryByText('Connected as octo-ana')).not.toBeInTheDocument());
  });
});
