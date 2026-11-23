import { render, screen, act } from '@testing-library/react';
import { VerticalProvider, useVertical } from './VerticalContext';

let api;
function Probe() {
  api = useVertical();
  return <p>{`vertical:${api.verticalId} selected:${api.isVerticalSelected}`}</p>;
}
const renderProbe = () => render(<VerticalProvider><Probe /></VerticalProvider>);

afterEach(() => { localStorage.clear(); });

test('a first-time user is on Notes without choosing anything', () => {
  renderProbe();
  expect(screen.getByText('vertical:notes selected:true')).toBeInTheDocument();
});

test('a saved choice is kept', () => {
  localStorage.setItem('arlo-vertical', 'sales');
  renderProbe();
  expect(screen.getByText('vertical:sales selected:true')).toBeInTheDocument();
});

test('an unknown saved value falls back to Notes', () => {
  localStorage.setItem('arlo-vertical', 'not-a-vertical');
  renderProbe();
  expect(screen.getByText('vertical:notes selected:true')).toBeInTheDocument();
});

test('clearing the choice returns to Notes, never to "nothing selected"', () => {
  localStorage.setItem('arlo-vertical', 'sales');
  renderProbe();
  act(() => { api.clearVertical(); });
  expect(screen.getByText('vertical:notes selected:true')).toBeInTheDocument();
});
