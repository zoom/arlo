import React from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../contexts/ToastContext';
import { notesToText } from '../../lib/notesText';
import { copyText } from '../../lib/copyText';
import Button from '../ui/Button';
import NotesDocument from './NotesDocument';

/**
 * The meeting has ended: the same notes, now the meeting's page, with one
 * action. `heading` is what the page is called when that is not the meeting's
 * title (a participant's shared notes); copied notes carry the title either way.
 * `actions`: what Arlo did, still listed under the notes.
 */
export default function AfterMeeting({ title, heading = title, notes, demoMode, recordPath, actions = null }) {
  const { addToast } = useToast();

  const copyNotes = async () => {
    // False when this webview has no way to copy, or refused
    const copied = await copyText(notesToText(notes, { title }));
    if (copied) addToast('Notes copied', 'success');
    else addToast('Could not copy the notes', 'error');
  };

  return (
    <div className="arlo-screen">
      <h1 className="arlo-title arlo-after-title" tabIndex={-1} data-arlo-focus>{heading}</h1>
      <div className="arlo-scroll">
        <NotesDocument notes={notes} listening={false} actions={actions} />
      </div>
      {demoMode && <p className="arlo-muted">Demo mode: meetings and notes are not stored.</p>}
      <Link className="arlo-link" to={recordPath}>Meeting record</Link>
      <Button onClick={copyNotes}>Copy notes</Button>
    </div>
  );
}
