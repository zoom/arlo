import { isZoomLink, requestDeeplink } from './openInZoom';

describe('isZoomLink', () => {
  test.each([
    'https://zoom.us/launch/chatapp/Zx_abc.def',
    'https://marketplace.zoom.us/zoomapp/abc/context/panel/target/launch/deeplink',
    'https://applications.zoom.us/x',
    'https://app.zoom.com/x',
  ])('accepts %s', (url) => {
    expect(isZoomLink(url)).toBe(true);
  });

  test.each([
    'http://zoom.us/launch/x',                 // not https
    'https://zoom.us.evil.example/launch/x',   // look-alike host
    'https://evilzoom.us/launch/x',
    'https://evil.example/?next=https://zoom.us',
    'javascript:alert(1)',
    'zoommtg://zoom.us/join',                  // only web links the server issued
    '',
    null,
    42,
  ])('rejects %j', (url) => {
    expect(isZoomLink(url)).toBe(false);
  });
});

describe('requestDeeplink', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  test('asks the server and returns the link', async () => {
    respond({ deeplink: 'https://zoom.us/launch/chatapp/Zx_abc', source: 'zoom' });
    await expect(requestDeeplink()).resolves.toBe('https://zoom.us/launch/chatapp/Zx_abc');
    expect(fetch).toHaveBeenCalledWith('/api/auth/deeplink', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });

  test('refuses a link that is not Zoom\'s, whatever the server said', async () => {
    respond({ deeplink: 'https://evil.example/launch' });
    await expect(requestDeeplink()).rejects.toThrow();
  });

  test('fails when the server refuses (for example, not signed in)', async () => {
    respond({ error: 'Unauthorized' }, 401);
    await expect(requestDeeplink()).rejects.toThrow();
  });
});
