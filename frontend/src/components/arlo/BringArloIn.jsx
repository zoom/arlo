import React from 'react';
import Button from '../ui/Button';
import WhoCanAskChoice from './WhoCanAskChoice';

/** The host's first screen: one action. Nothing is requested before the click. */
export default function BringArloIn({ whoCanAsk, onWhoCanAskChange, onBringIn, disabled, message }) {
  return (
    <div className="arlo-center">
      <h1 className="arlo-title" tabIndex={-1} data-arlo-focus>Bring Arlo into this meeting</h1>
      <p className="arlo-muted">
        Arlo listens through Zoom&apos;s transcript and takes notes for you. Everyone in the meeting can see that Arlo is here.
      </p>
      <Button onClick={onBringIn} disabled={disabled}>Bring Arlo into this meeting</Button>
      {message && <p className="arlo-error" role="alert">{message}</p>}
      <WhoCanAskChoice value={whoCanAsk} onChange={onWhoCanAskChange} />
    </div>
  );
}
