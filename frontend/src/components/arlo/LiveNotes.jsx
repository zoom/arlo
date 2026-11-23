import React from 'react';
import { Link } from 'react-router-dom';
import StatusLine from './StatusLine';
import NotesDocument from './NotesDocument';
import AskArlo from './AskArlo';

/** The owner's screen while Arlo is (or was) in the meeting: the notes, and one input. */
export default function LiveNotes({ notes, present, paused, canControl, recordPath }) {
  return (
    <div className="arlo-screen">
      <StatusLine present={present} paused={paused} canControl={canControl} />
      <div className="arlo-scroll">
        <NotesDocument notes={notes} />
      </div>
      <Link className="arlo-link" to={recordPath}>Meeting record</Link>
      <AskArlo />
    </div>
  );
}
