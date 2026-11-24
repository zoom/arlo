import React from 'react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button';
import LoadingSpinner from '../ui/LoadingSpinner';
import AskArlo from './AskArlo';
import NotesDocument from './NotesDocument';
import { ownerWording, sharedNotesHeading, usableName } from '../../lib/ownerName';

const ONLY_USERS_ASK = 'Only people using Arlo can ask in this meeting.';

/**
 * A button that asks for a stream, on the click only. While the request is
 * unresolved its progress shows here, in place of the button, and the screen
 * stays. `start`:
 *   progress   'asking' (waiting on the host) | 'starting' | null
 *   secondsLeft, hint, mayAskAgain   for a request waiting on the host
 *   message    why the last request did not bring Arlo in, or null
 * Two uses: "Take notes yourself", one of a signed-in participant's two
 * choices while Arlo is here (several people can each run Arlo in a meeting),
 * and the one way to bring Arlo in under shared notes while Arlo is out.
 */
function StartArlo({ start, onStart, disabled, label, explanation = null }) {
  const { progress, secondsLeft, hint, mayAskAgain, message } = start;
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
          {mayAskAgain && <Button variant="outline" size="sm" onClick={onStart}>Try again</Button>}
        </>
      ) : (
        <>
          <Button variant="outline" onClick={onStart} disabled={disabled}>{label}</Button>
          {explanation && <p className="arlo-muted">{explanation}</p>}
        </>
      )}
      {message && <p className="arlo-error" role="alert">{message}</p>}
    </div>
  );
}

const NOTES_REQUEST_TEXT = {
  asked: 'Asked. The notes appear here if they agree.',
  // Until the notes render: from then on they speak for themselves
  shared: 'The notes are shared with everyone.',
  declined: 'They chose not to share the notes right now.',
  expired: 'No answer this time.',
  failed: 'The notes couldn\'t be shared.',
};

/**
 * "Ask <owner> to share notes with everyone": the other of a signed-in
 * participant's two choices. The owner answers in their own panel; if they
 * agree, the notes are shared and appear here, as in everyone's panel. Not
 * rendered while the notes are shared already.
 * `request`: null | { status, message?, retry? } (ArloContext `notesRequest`).
 * After the click the button and its explanation give way to a line saying
 * where the request is; they are back when the context clears the request, or
 * at once (`retry`) when the request could not be made.
 */
function AskToShareNotes({ ownerName, request, onAsk, disabled }) {
  const name = usableName(ownerName);
  const text = request ? (NOTES_REQUEST_TEXT[request.status] || request.message || '') : '';
  const showButton = request === null || request.retry === true;
  return (
    <div className="arlo-ask-notes">
      {showButton && (
        <>
          <Button variant="outline" onClick={onAsk} disabled={disabled}>
            {name ? `Ask ${name} to share notes with everyone` : 'Ask to share notes with everyone'}
          </Button>
          <p className="arlo-muted">They decide. If they agree, everyone with Arlo open sees the notes here.</p>
        </>
      )}
      {/* Always here, so a screen reader hears the text when it appears */}
      <p className="arlo-muted arlo-ask-notes-status" role="status">{text}</p>
    </div>
  );
}

/**
 * What someone who did not bring Arlo in sees: that Arlo is here and for whom,
 * the meeting record, and a private ask when the owner allows it. No controls:
 * a stream, and the decision to share its notes, belong to the person who
 * started it.
 *
 * The notes are here only while an owner shares them with everyone
 * (`notesShared`): then the heading says who shares them and the same notes
 * document follows, read-only, for a signed-in participant and a guest alike.
 * `notes` is null until the first ones are written. With the notes comes what
 * Arlo did (`actions`: the public ones, which is all the server gives here).
 *
 * A signed-in participant has two choices while Arlo is here, two secondary
 * buttons of equal weight: ask the owner to share the notes with everyone
 * (`onRequestNotes`; gone while they are shared), or take notes themselves
 * (`ownStart`; they get the notes screen once the server says they are an
 * owner too). A guest has neither: they can sign in.
 *
 * Shared notes stay while Arlo is out of the meeting and the meeting goes on
 * (`notesShared` and `notes`, not `present`): a status line says that Arlo has
 * left, and below the notes there is the one way to bring Arlo in. For a
 * signed-in person that is `bringIn`: { label, start } with `start` as for
 * `ownStart` (the view passes the same start the bring-in and ask-host
 * screens use, `onUseArlo`). A guest who is the Zoom host or co-host can sign
 * in; another guest has no action. The two choices and the ask are not
 * offered: there is no stream to ask anything of.
 * `paused` is about the meeting (every live stream is paused): wording only.
 * `ownerName` can be missing or blank: the sentences then say it without a
 * name (lib/ownerName.js).
 */
export default function ParticipantView({
  present, paused = false, ownerName, whoCanAsk, guest, canBringIn = false, meetingEnded, showRecord, recordPath,
  onSignIn, signingIn, signInError, ownStart = null, onUseArlo, useArloDisabled = false,
  notesRequest = null, onRequestNotes, requestingNotes = false, notesShared = false, notes = null, bringIn = null,
  actions = null,
}) {
  const wording = ownerWording(ownerName);
  // The notes show only while an owner shares them: live while Arlo is here,
  // and the ones written so far while Arlo is out of the meeting
  const sharing = present && notesShared === true;
  const keptNotes = !present && !meetingEnded && notesShared === true && Boolean(notes);
  const heading = sharing || keptNotes
    ? sharedNotesHeading(ownerName)
    : (present ? wording.heading : 'Arlo isn\'t in this meeting');
  const signedInHere = present && !guest && !meetingEnded;
  const canAskToShare = signedInHere && !sharing && Boolean(onRequestNotes);
  const canTakeNotes = signedInHere && Boolean(ownStart);

  return (
    <div className="arlo-screen">
      <div className="arlo-scroll arlo-participant">
        <h1 className="arlo-title" tabIndex={-1} data-arlo-focus>{heading}</h1>
        {present && paused && <p className="arlo-muted" role="status">Arlo is paused</p>}
        {sharing && (notes ? <NotesDocument notes={notes} actions={actions} /> : <p className="arlo-muted">Notes appear after the first minute or so.</p>)}
        {present && !sharing && <p className="arlo-muted">{wording.body}</p>}
        {keptNotes && (
          <>
            <p className="arlo-muted" role="status">Arlo has left the meeting. These are the notes so far.</p>
            <NotesDocument notes={notes} actions={actions} />
          </>
        )}
        {!present && !keptNotes && (
          <p className="arlo-muted">
            {meetingEnded ? 'Nothing is stored after the meeting ends.' : 'The host decides whether Arlo joins.'}
          </p>
        )}
        {(showRecord || keptNotes) && <Link className="arlo-link" to={recordPath}>Meeting record</Link>}
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
        {(canAskToShare || canTakeNotes) && (
          <div className="arlo-choices">
            {canAskToShare && (
              <AskToShareNotes ownerName={ownerName} request={notesRequest} onAsk={onRequestNotes} disabled={requestingNotes} />
            )}
            {canTakeNotes && (
              <StartArlo
                start={ownStart}
                onStart={onUseArlo}
                disabled={useArloDisabled}
                label="Take notes yourself"
                explanation="Starts Arlo for you too, under your own permission."
              />
            )}
          </div>
        )}
        {keptNotes && !guest && bringIn && (
          <div className="arlo-choices">
            <StartArlo start={bringIn.start} onStart={onUseArlo} disabled={useArloDisabled} label={bringIn.label} />
          </div>
        )}
      </div>
      {present && !guest && whoCanAsk === 'anyone' && <AskArlo />}
    </div>
  );
}
