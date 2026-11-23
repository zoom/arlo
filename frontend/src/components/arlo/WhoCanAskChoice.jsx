import React, { useId } from 'react';

const CHOICES = [
  { value: 'owner', label: 'Only I can ask' },
  { value: 'anyone', label: 'Anyone can ask' },
];

/** The two answers to "Who can ask Arlo", as one radio group. */
export default function WhoCanAskChoice({ value, onChange, disabled = false }) {
  const groupId = useId();
  return (
    <div className="arlo-choice" role="radiogroup" aria-labelledby={`${groupId}-label`}>
      <span className="arlo-choice-label" id={`${groupId}-label`}>Who can ask Arlo</span>
      <div className="arlo-choice-options">
        {CHOICES.map((choice) => (
          <label key={choice.value} className="arlo-choice-option">
            <input
              type="radio"
              name={`${groupId}-who-can-ask`}
              value={choice.value}
              checked={value === choice.value}
              disabled={disabled}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
