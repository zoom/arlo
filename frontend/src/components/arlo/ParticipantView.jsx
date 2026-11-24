import React from 'react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button';
import LoadingSpinner from '../ui/LoadingSpinner';
import AskArlo from './AskArlo';
import { ownerWording, usableName } from '../../lib/ownerName';

const ONLY_USERS_ASK = 'Only people using Arlo can ask in this meeting.';

/**
 * "Use Arlo yourself": the one secondary action of a signed-in participant.
 * Several people can each run Arlo in a meeting; this starts theirs, on the
 * click only. While the request is unresolved its progress shows here, in
 * place of the button, and the screen stays. `ownStart`:
 *   progress   'asking' (waiting on the host) | 'starting' | null
 *   secondsLeft, hint, mayAskAgain   for a request waiting on the host
 *   message    why the last request did not bring Arlo in, or null
 */
function UseArloYourself({ ownStart, onUseArlo, disabled }) {
  const { progress, secondsLeft, hint, mayAskAgain, message } = ownStart;
  return (
    <div className="arlo-use-yourself">
      {progress ? (
        <>
          <p className="arlo-waiting" role="status" aria-live="polite">
            <span className="arlo-waiting-spinner" aria-hidden="true"><LoadingSpinner size={16} /></span>
            <span>
              {progress === 'asking'
                ? `Waiting for the host to allow Arlo…${secondsLeft !== null && secondsLeft !== undefined ? ` ${secondsLeft}s` : ''}`
                : 'Bringing Arlo in…'}
            </span>
          </p>
          {hint && <p className="arlo-muted">{hint}</p>}
          {mayAskAgain && <Button variant="outline" size="sm" onClick={onUseArlo}>Try again</Button>}
        </>
      ) : (
        <>
          <Button variant="outline" onClick={onUseArlo} disabled={disabled}>Use Arlo yourself</Button>
          <p className="arlo-muted">Starts Arlo for you too. You get the notes and can ask.</p>
        </>
      )}
      {message && <p className="arlo-error" role="alert">{message}</p>}
    </div>
  );
}

const NOTES_REQUEST_TEXT = {
  asked: 'Asked. The notes appear in the chat if they agree.',
  shared: 'The notes are in the meeting chat.',
  declined: 'They chose not to share the notes right now.',
  expired: 'No answer this time.',
  failed: 'The notes couldn\'t be posted to the chat.',
};

/**
 * "Ask <owner> for the notes": a signed-in participant asks the person who
 * brought Arlo in to share the notes. The owner answers in their own panel and
 * the notes, if they agree, appear in the meeting chat: never here.
 * `request`: null | { status, message?, retry? } (ArloContext `notesRequest`).
 * After the click the button gives way to a line saying where the request is;
 * it is back when the context clears the request, or at once (`retry`) when
 * the request could not be made.
 */
function AskForNotes({ ownerName, request, onAsk, disabled }) {
  const name = usableName(ownerName);
  const text = request ? (NOTES_REQUEST_TEXT[request.status] || request.message || '') : '';
  const showButton = request === null || request.retry === true;
  return (
    <div className="arlo-ask-notes">
      {showButton && (
        <Button variant="outline" size="sm" onClick={onAsk} disabled={disabled}>
          {name ? `Ask ${name} for the notes` : 'Ask for the notes'}
        </Button>
      )}
      {/* Always here, so a screen reader hears the text when it appears */}
      <p className="arlo-muted arlo-ask-notes-status" role="status">{text}</p>
    </div>
  );
}

/**
 * What someone who did not bring Arlo in sees: that Arlo is here and for whom,
 * the meeting record, and a private ask when the owner allows it. Never the notes,
 * and no controls: a stream belongs to the person who started it. A signed-in
 * participant can start one of their own ("Use Arlo yourself") and gets the
 * notes screen once the server says they are an owner too. Independently of
 * that, they can ask the owner to share the notes in the chat (`onRequestNotes`).
 * `paused` is about the meeting (every live stream is paused): wording only.
 * `ownerName` can be missing or blank: the sentences then say it without a
 * name (lib/ownerName.js).
 */
export default function ParticipantView({
  present, paused = false, ownerName, whoCanAsk, guest, canBringIn = false, meetingEnded, showRecord, recordPath,
  onSignIn, signingIn, signInError, ownStart = null, onUseArlo, useArloDisabled = false,
  notesRequest = null, onRequestNotes, requestingNotes = false,
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
        {present && whoCanAsk !== 'anyone' && <p className="arlo-muted">{ONLY_USERS_ASK}</p>}
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
        {present && !guest && !meetingEnded && onRequestNotes && (
          <AskForNotes ownerName={ownerName} request={notesRequest} onAsk={onRequestNotes} disabled={requestingNotes} />
        )}
        {present && !guest && !meetingEnded && ownStart && (
          <UseArloYourself ownStart={ownStart} onUseArlo={onUseArlo} disabled={useArloDisabled} />
        )}
      </div>
      {present && !guest && whoCanAsk === 'anyone' && <AskArlo />}
    </div>
  );
}
