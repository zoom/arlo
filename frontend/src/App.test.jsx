import { render, screen } from '@testing-library/react';
import App from './App';

// Smoke test: the whole module graph loads and the app renders outside Zoom.
// Catches build/tooling breakage (missing module, bad import) that unit tests miss.
describe('App outside Zoom', () => {
  beforeEach(() => {
    delete window.zoomSdk;
    window.location.hash = '#/';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/auth/settings')) {
        return new Response(JSON.stringify({ demoMode: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('shows the landing page to a signed-out browser visitor', async () => {
    render(<App />);
    expect(await screen.findByText('Everything you need')).toBeInTheDocument();
    expect(await screen.findByText('How it works')).toBeInTheDocument();
  });
});
