import { vi } from 'vitest';
import { connectStartUrl, parseConnectors, startGithubConnect, disconnectGithub, readConnectors } from './connectGithub';

const ORIGIN = window.location.origin;
const TICKET = 'A'.repeat(20) + '-_' + 'b'.repeat(21);
const GOOD = `${ORIGIN}/api/connectors/github/start?ticket=${TICKET}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('connectStartUrl: the one URL the connect step opens', () => {
  test('this origin, the start path, a ticket of 43 base64url characters', () => {
    expect(TICKET).toHaveLength(43);
    expect(connectStartUrl(GOOD)).toBe(GOOD);
  });

  test.each([
    ['another origin', `https://evil.example/api/connectors/github/start?ticket=${TICKET}`],
    ['an origin that only starts like it', `${ORIGIN}.evil.example/api/connectors/github/start?ticket=${TICKET}`],
    ['credentials before another host', `${ORIGIN}@evil.example/api/connectors/github/start?ticket=${TICKET}`],
    ['another path', `${ORIGIN}/api/connectors/github/callback?ticket=${TICKET}`],
    ['an extra query', `${GOOD}&next=https://evil.example`],
    ['a fragment', `${GOOD}#x`],
    ['a short ticket', GOOD.slice(0, -1)],
    ['a long ticket', `${GOOD}A`],
    ['a ticket with other characters', `${GOOD.slice(0, -1)}+`],
    ['a ticket with a line break', `${GOOD.slice(0, -1)}\n`],
    ['a relative URL', `/api/connectors/github/start?ticket=${TICKET}`],
    ['javascript:', 'javascript:alert(1)'],
    ['nothing', undefined],
    ['an object', { toString: () => GOOD }],
  ])('%s is not opened', (_name, url) => {
    expect(connectStartUrl(url)).toBeNull();
  });
});

describe('startGithubConnect', () => {
  const ticketRoute = (answer) => vi.stubGlobal('fetch', vi.fn(async () => answer()));

  test('in Zoom: asks for a ticket, then openUrl with exactly the URL', async () => {
    ticketRoute(() => json({ url: GOOD }));
    const zoomSdk = { openUrl: vi.fn(async () => ({})) };
    expect(await startGithubConnect({ zoomSdk, inZoom: true })).toBe('opened');
    expect(fetch).toHaveBeenCalledWith('/api/connectors/github/ticket', expect.objectContaining({ method: 'POST', credentials: 'include', body: '{}' }));
    expect(zoomSdk.openUrl).toHaveBeenCalledWith({ url: GOOD });
  });

  test('outside Zoom: a new tab without an opener', async () => {
    ticketRoute(() => json({ url: GOOD }));
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await startGithubConnect({ zoomSdk: null, inZoom: false })).toBe('opened');
    expect(open).toHaveBeenCalledWith(GOOD, '_blank', 'noopener,noreferrer');
  });

  test.each([
    ['another origin', () => json({ url: `https://evil.example/api/connectors/github/start?ticket=${TICKET}` })],
    ['an extra query', () => json({ url: `${GOOD}&x=1` })],
    ['a short ticket', () => json({ url: GOOD.slice(0, -3) })],
    ['no URL', () => json({})],
    ['a refusal', () => json({ error: 'nope' }, 503)],
    ['no JSON', () => new Response('<html>', { status: 200 })],
  ])('%s from the server: nothing is opened', async (_name, answer) => {
    ticketRoute(answer);
    const zoomSdk = { openUrl: vi.fn(async () => ({})) };
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await startGithubConnect({ zoomSdk, inZoom: true })).toBe('failed');
    expect(await startGithubConnect({ zoomSdk, inZoom: false })).toBe('failed');
    expect(zoomSdk.openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test('a network failure is "failed"; Zoom refusing, or a client without openUrl, is "refused"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await startGithubConnect({ zoomSdk: {}, inZoom: true })).toBe('failed');
    ticketRoute(() => json({ url: GOOD }));
    expect(await startGithubConnect({ zoomSdk: { openUrl: vi.fn(async () => { throw new Error('10015'); }) }, inZoom: true })).toBe('refused');
    expect(await startGithubConnect({ zoomSdk: {}, inZoom: true })).toBe('refused');
  });

  test('the URL and the ticket are never logged', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    ticketRoute(() => json({ url: GOOD }));
    await startGithubConnect({ zoomSdk: { openUrl: vi.fn(async () => { throw new Error(`refused ${GOOD}`); }) }, inZoom: true });
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });
});

describe('parseConnectors', () => {
  test('the three states', () => {
    expect(parseConnectors({ github: { available: false, connected: false, login: null } })).toEqual({ github: { available: false, connected: false, login: null } });
    expect(parseConnectors({ github: { available: true, connected: false, login: null } })).toEqual({ github: { available: true, connected: false, login: null } });
    expect(parseConnectors({ github: { available: true, connected: true, login: 'octo-cat' } })).toEqual({ github: { available: true, connected: true, login: 'octo-cat' } });
  });

  test('not connected where GitHub is not set up; a login that is none is dropped', () => {
    expect(parseConnectors({ github: { available: false, connected: true, login: 'x' } }).github).toEqual({ available: false, connected: false, login: null });
    expect(parseConnectors({ github: { available: true, connected: true, login: '<b>x</b>' } }).github.login).toBeNull();
    expect(parseConnectors({ github: { available: true, connected: true, login: 'a'.repeat(40) } }).github.login).toBeNull();
    expect(parseConnectors({ github: { available: true, connected: false, login: 'left-over' } }).github.login).toBeNull();
  });

  test.each([[null], [{}], [{ github: null }], [{ github: [] }], [{ github: { available: 'yes', connected: false } }], [{ github: { available: true } }]])(
    '%j is not an answer', (value) => { expect(parseConnectors(value)).toBeNull(); },
  );
});

describe('reading and disconnecting', () => {
  test('readConnectors: the answer, "signed_out" for 401, null otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ github: { available: true, connected: false, login: null } })));
    expect(await readConnectors()).toEqual({ github: { available: true, connected: false, login: null } });
    expect(fetch).toHaveBeenCalledWith('/api/connectors', { credentials: 'include' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'x' }, 401)));
    expect(await readConnectors()).toBe('signed_out');
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    expect(await readConnectors()).toBeNull();
  });

  test('disconnectGithub: true only when the server says it is disconnected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ connected: false })));
    expect(await disconnectGithub()).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/connectors/github', { method: 'DELETE', credentials: 'include' });
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    expect(await disconnectGithub()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ connected: false }, 500)));
    expect(await disconnectGithub()).toBe(false);
  });
});
