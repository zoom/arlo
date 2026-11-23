import React from 'react';
import Button from '../ui/Button';

/** A signed-in participant who is not the host: the request goes to the host on this click only. */
export default function AskHost({ onAsk, disabled, message }) {
  return (
    <div className="arlo-center">
      <h1 className="arlo-title">Arlo isn&apos;t in this meeting yet</h1>
      <p className="arlo-muted">The host decides whether Arlo joins.</p>
      <Button onClick={onAsk} disabled={disabled}>Ask the host to bring Arlo in</Button>
      {message && <p className="arlo-error" role="alert">{message}</p>}
    </div>
  );
}
