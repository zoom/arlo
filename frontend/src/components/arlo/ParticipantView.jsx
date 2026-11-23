import React from 'react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button';
import AskArlo from './AskArlo';
import { ownerWording } from '../../lib/ownerName';

/**
 * What someone who did not bring Arlo in sees: that Arlo is here and for whom,
 * the meeting record, and a private ask when the owner allows it. Never the notes,
 * and no controls: the stream belongs to the person who brought Arlo in.
 * `paused` is about the meeting (every live stream is paused): wording only.
 * `ownerName` can be missing or blank: the sentences then say it without a
 * name (lib/ownerName.js).
 */
export default function ParticipantView({
  present, paused = false, ownerName, whoCanAsk, guest, canBringIn = false, meetingEnded, showRecord, recordPath,
  onSignIn, signingIn, signInError,
}) {
  const wording = ownerWording(ownerName);
  const heading = present ? wording.heading : 'Arlo isn\'t in this meeting';

  return (
    <div className="arlo-screen">
      <div className="arlo-scroll arlo-participant">
        <h1 className="arlo-title" tabIndex={-1} data-arlo-focus>{heading}</h1>
        {present && paused && <p className="arlo-muted" role="status">Arlo is paused</p>}
        {present ? (
          <p className="arlo-muted">{wording.body}</p>
        ) : (
          <p className="arlo-muted">
            {meetingEnded ? 'Nothing is stored after the meeting ends.' : 'The host decides whether Arlo joins.'}
          </p>
        )}
        {showRecord && <Link className="arlo-link" to={recordPath}>Meeting record</Link>}
        {present && guest && (
          <div className="arlo-sign-in">
            <Button onClick={onSignIn} disabled={signingIn}>Sign in to ask Arlo</Button>
            {signInError && <p className="arlo-error" role="alert">{signInError}</p>}
          </div>
        )}
        {/* A guest who is the Zoom host or co-host could bring Arlo in, once signed in */}
        {!present && !meetingEnded && guest && canBringIn && (
          <div className="arlo-sign-in">
            <Button onClick={onSignIn} disabled={signingIn}>Sign in to bring Arlo in</Button>
            {signInError && <p className="arlo-error" role="alert">{signInError}</p>}
          </div>
        )}
        {present && !guest && whoCanAsk !== 'anyone' && (
          <p className="arlo-muted">{wording.askLine}</p>
        )}
      </div>
      {present && !guest && whoCanAsk === 'anyone' && <AskArlo />}
    </div>
  );
}
