import React, { useId } from 'react';
import Button from '../ui/Button';

const CHOICES = [
  { value: 'owner', label: 'Only I can ask' },
  { value: 'anyone', label: 'Anyone can ask' },
];

/** The host's first screen: one action. Nothing is requested before the click. */
export default function BringArloIn({ whoCanAsk, onWhoCanAskChange, onBringIn, disabled, message }) {
  const groupId = useId();
  return (
    <div className="arlo-center">
      <h1 className="arlo-title">Bring Arlo into this meeting</h1>
      <p className="arlo-muted">
        Arlo listens through Zoom&apos;s transcript and takes notes for you. Everyone in the meeting can see that Arlo is here.
      </p>
      <Button onClick={onBringIn} disabled={disabled}>Bring Arlo into this meeting</Button>
      {message && <p className="arlo-error" role="alert">{message}</p>}
      <div className="arlo-choice" role="radiogroup" aria-labelledby={`${groupId}-label`}>
        <span className="arlo-choice-label" id={`${groupId}-label`}>Who can ask Arlo</span>
        <div className="arlo-choice-options">
          {CHOICES.map((choice) => (
            <label key={choice.value} className="arlo-choice-option">
              <input
                type="radio"
                name={`${groupId}-who-can-ask`}
                value={choice.value}
                checked={whoCanAsk === choice.value}
                onChange={() => onWhoCanAskChange(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
