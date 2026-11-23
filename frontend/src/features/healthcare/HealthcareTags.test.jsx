import { render, screen } from '@testing-library/react';
import { HealthcareTagsSummary } from './HealthcareTags';

const line = (seqNo, text) => ({ seqNo, text, speakerId: '1', speakerLabel: 'Dr. Ana', tStartMs: seqNo, tEndMs: seqNo });

test('no sample medical terms appear unless sample data is asked for', () => {
  const { container, rerender } = render(<HealthcareTagsSummary segments={[line(1, 'Good morning.')]} onTagClick={() => {}} />);
  for (const sample of ['Headache', 'Insomnia', 'Ibuprofen', 'Amitriptyline']) {
    expect(screen.queryByText(new RegExp(sample, 'i'))).not.toBeInTheDocument();
  }

  rerender(<HealthcareTagsSummary segments={[line(1, 'Good morning.')]} onTagClick={() => {}} demoMode />);
  expect(container.textContent).toMatch(/Headache|Ibuprofen|Insomnia/i);
});
