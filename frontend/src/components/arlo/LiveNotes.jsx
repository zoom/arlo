import React from 'react';
import { Link } from 'react-router-dom';
import StatusLine from './StatusLine';
import NotesDocument from './NotesDocument';
import AskArlo from './AskArlo';
import WhoCanAsk from './WhoCanAsk';
import PostNotesToChat from './PostNotesToChat';

/**
 * The owner's screen while Arlo is (or was) in the meeting: the notes, and one
 * input. The status line says where Arlo is, also while it is on its way back.
 * Under the notes, next to the record link, an owner can post them to the chat.
 */
export default function LiveNotes({
  notes, present, paused, myStreamPaused, myStreamLive, canControl, recordPath, whoCanAsk, onWhoCanAskChange,
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
      />
      <div className="arlo-scroll">
        <NotesDocument notes={notes} listening={present} />
      </div>
      <div className="arlo-notes-actions">
        <Link className="arlo-link" to={recordPath}>Meeting record</Link>
        {canControl && <PostNotesToChat notes={notes} />}
      </div>
      <AskArlo />
      {canControl && <WhoCanAsk value={whoCanAsk} onChange={onWhoCanAskChange} />}
    </div>
  );
}
