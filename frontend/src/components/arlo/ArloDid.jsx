import React from 'react';
import { actionLine, doneActions } from '../../lib/arloDid';

/**
 * "Arlo did": what Arlo was asked and did in this meeting, one line each,
 * oldest first, at the end of the notes. Only what was done: what was
 * declined, ran out or failed is in the meeting record. `actions` is what the
 * server gave this person (ArloContext `actions`): the public ones, and an
 * owner's own private ones. Not rendered when there is nothing to list.
 */
export default function ArloDid({ actions }) {
  const done = doneActions(actions);
  if (done.length === 0) return null;
  return (
    <section>
      <h2 className="arlo-notes-heading">Arlo did</h2>
      <ul>
        {done.map((action) => (
          <li key={action.id}>{actionLine(action)}</li>
        ))}
      </ul>
    </section>
  );
}
