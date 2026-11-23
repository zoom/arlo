import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { goTo } from '../lib/navigate';
import { json, mockFetch } from '../test/harness';

vi.mock('../lib/navigate', () => ({ goTo: vi.fn() }));

// The page a user lands on after signing in from a browser. Its job is to get
// them into the Zoom client with Arlo open.

const LINK = 'https://zoom.us/launch/chatapp/Zx_abc123';

function openWelcome(query = '', routes = {}) {
  delete window.zoomSdk; // a normal browser, not the Zoom client
  const fetchMock = mockFetch({ 'POST /api/auth/deeplink': () => json({ deeplink: LINK, source: 'zoom' }), ...routes });
  window.location.hash = `#/welcome${query}`;
  render(<App />);
  return fetchMock;
}
const deeplinkCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/deeplink'));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(goTo).mockClear();
  window.location.hash = '#/';
});

test('right after signing in, it opens Arlo in Zoom without a click', async () => {
  openWelcome('?first=true&launch=1');
  await waitFor(() => expect(goTo).toHaveBeenCalledWith(LINK));
  expect(goTo).toHaveBeenCalledTimes(1);
});

test('coming back to the page does not launch Zoom a second time', async () => {
  openWelcome('?launch=1');
  await waitFor(() => expect(goTo).toHaveBeenCalledTimes(1));
  document.body.innerHTML = '';
  const fetchMock = openWelcome('?launch=1');
  await screen.findByRole('button', { name: /Open Arlo in Zoom/ });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(deeplinkCalls(fetchMock)).toHaveLength(0);
  expect(goTo).toHaveBeenCalledTimes(1);
});

test('without the launch flag nothing happens until the user clicks the button', async () => {
  const fetchMock = openWelcome();
  const button = await screen.findByRole('button', { name: /Open Arlo in Zoom/ });
  expect(deeplinkCalls(fetchMock)).toHaveLength(0);

  await userEvent.click(button);
  await waitFor(() => expect(goTo).toHaveBeenCalledWith(LINK));
});

test('if no link can be made, it says what to do instead of sending the user nowhere', async () => {
  openWelcome('', { 'POST /api/auth/deeplink': () => json({ error: 'nope' }, 500) });
  await userEvent.click(await screen.findByRole('button', { name: /Open Arlo in Zoom/ }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/open Zoom yourself/i);
  expect(goTo).not.toHaveBeenCalled();
});

test('a link that is not Zoom\'s is never followed', async () => {
  openWelcome('', { 'POST /api/auth/deeplink': () => json({ deeplink: 'https://evil.example/launch' }) });
  await userEvent.click(await screen.findByRole('button', { name: /Open Arlo in Zoom/ }));

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(goTo).not.toHaveBeenCalled();
});

test('the help link points at this project', async () => {
  openWelcome();
  const link = await screen.findByRole('link', { name: /documentation/i });
  expect(link).toHaveAttribute('href', 'https://github.com/zoom/arlo-meeting-assistant');
});
