import { watchForSessionLoss } from './sessionWatch';

const respond = (status) => async () => new Response('{}', { status });

describe('watchForSessionLoss', () => {
  let stop;
  let onLost;
  const originalFetch = globalThis.fetch;

  function install(impl) {
    globalThis.fetch = vi.fn(impl);
    onLost = vi.fn();
    stop = watchForSessionLoss(onLost);
  }

  afterEach(() => {
    stop?.();
    globalThis.fetch = originalFetch;
  });

  test('a 401 from an API call reports that the session is gone', async () => {
    install(respond(401));
    const res = await fetch('/api/ai/summary-live', { method: 'POST' });
    expect(res.status).toBe(401); // the caller still gets its response
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test('a burst of failing calls reports once', async () => {
    install(respond(401));
    await Promise.all([fetch('/api/ai/suggest'), fetch('/api/preferences'), fetch('/api/highlights')]);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test.each([
    '/api/auth/me',               // the session check itself
    '/api/auth/callback',
    '/api/auth/meeting-access',   // 401 here is about the meeting, not the session
    '/api/meetings/by-zoom-id/M%3D%3D/transcript',
  ])('a 401 from %s is not a lost session', async (url) => {
    install(respond(401));
    await fetch(url);
    expect(onLost).not.toHaveBeenCalled();
  });

  test.each([200, 403, 404, 429, 500])('status %i is not a lost session', async (status) => {
    install(respond(status));
    await fetch('/api/ai/suggest');
    expect(onLost).not.toHaveBeenCalled();
  });

  test('other origins are ignored', async () => {
    install(respond(401));
    await fetch('https://example.test/api/thing');
    expect(onLost).not.toHaveBeenCalled();
  });

  test('network errors still reach the caller', async () => {
    install(async () => { throw new TypeError('Failed to fetch'); });
    await expect(fetch('/api/ai/suggest')).rejects.toThrow('Failed to fetch');
    expect(onLost).not.toHaveBeenCalled();
  });

  test('stopping restores the original fetch', async () => {
    install(respond(401));
    const patched = globalThis.fetch;
    stop();
    stop = null;
    expect(globalThis.fetch).not.toBe(patched);
    await fetch('/api/ai/suggest');
    expect(onLost).not.toHaveBeenCalled();
  });
});
