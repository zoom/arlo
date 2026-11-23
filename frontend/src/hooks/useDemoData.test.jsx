import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ServerSettingsProvider } from '../contexts/ServerSettingsContext';
import { DemoDataProvider, useDemoData } from './useDemoData';

function Probe() {
  const { showDemoData, demoDataAvailable } = useDemoData();
  return <p>{`show:${showDemoData} available:${demoDataAvailable}`}</p>;
}

function renderWith({ demoMode, stored }) {
  if (stored === undefined) localStorage.removeItem('arlo-show-demo-data');
  else localStorage.setItem('arlo-show-demo-data', JSON.stringify(stored));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ demoMode }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })));
  return render(<ServerSettingsProvider><DemoDataProvider><Probe /></DemoDataProvider></ServerSettingsProvider>);
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test('sample data is off for a first-time user, even in demo mode', async () => {
  renderWith({ demoMode: true });
  expect(await screen.findByText('show:false available:true')).toBeInTheDocument();
});

test('in demo mode a user who turned it on sees it', async () => {
  renderWith({ demoMode: true, stored: true });
  expect(await screen.findByText('show:true available:true')).toBeInTheDocument();
});

test('outside demo mode sample data is never shown, whatever was saved', async () => {
  renderWith({ demoMode: false, stored: true });
  await waitFor(() => expect(screen.getByText('show:false available:false')).toBeInTheDocument());
});
