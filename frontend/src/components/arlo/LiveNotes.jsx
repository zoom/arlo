import React from 'react';
import { Link } from 'react-router-dom';
import StatusLine from './StatusLine';
import NotesDocument from './NotesDocument';
import AskArlo from './AskArlo';
import WhoCanAsk from './WhoCanAsk';
import PostNotesToChat from './PostNotesToChat';
import ShareNotes from './ShareNotes';

/**
 * The owner's screen while Arlo is (or was) in the meeting: the notes, and one
 * input. The status line says where Arlo is, also while it is on its way back.
 * Under the notes, next to the record link, an owner can share them with
 * everyone in the meeting (live in their panels, until the owner stops) and
 * post them to the chat (a one-time copy).
 * When someone asks the owner for something, a sheet rises over this screen
 * as over any other (components/arlo/ApprovalHost.jsx, in the app shell).
 * `actions`: what Arlo was asked and did, listed at the end of the notes.
 * `thinking`: Arlo is handling a request right now; the status line says so.
 */
export default function LiveNotes({
  notes, present, paused, myStreamPaused, myStreamLive, canControl, recordPath, whoCanAsk, onWhoCanAskChange,
  notesShared = false, onShareNotesChange, actions = null, thinking = false,
}) {
  return (
    <div className="arlo-screen">
      <h1 className="arlo-sr-only" tabIndex={-1} data-arlo-focus>Your notes</h1>
      <StatusLine
        present={present}
        paused={paused}
        myStreamPaused={myStreamPaused}
        myStreamLive={myStreamLive}
        canControl={canControl}
        thinking={thinking}
      />
      <div className="arlo-scroll">
        <NotesDocument notes={notes} listening={present} actions={actions} />
      </div>
      <div className="arlo-notes-actions">
        <Link className="arlo-link" to={recordPath}>Meeting record</Link>
        {canControl && onShareNotesChange && <ShareNotes shared={notesShared} onChange={onShareNotesChange} />}
        {canControl && <PostNotesToChat notes={notes} />}
      </div>
      <AskArlo />
      {canControl && <WhoCanAsk value={whoCanAsk} onChange={onWhoCanAskChange} />}
    </div>
  );
}
