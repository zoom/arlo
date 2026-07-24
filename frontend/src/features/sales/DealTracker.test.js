import { renderToStaticMarkup } from 'react-dom/server';
import DealTracker from './DealTracker';

describe('DealTracker', () => {
  it('renders its empty state when demo data is disabled', () => {
    const markup = renderToStaticMarkup(<DealTracker showDemoData={false} />);

    expect(markup).toContain('No deal linked to this meeting.');
  });

  it('renders the demo deal when demo data is enabled', () => {
    const markup = renderToStaticMarkup(<DealTracker showDemoData />);

    expect(markup).toContain('Meridian Financial Group');
    expect(markup).toContain('Negotiation');
  });
});
