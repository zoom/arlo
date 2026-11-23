import React from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../contexts/ToastContext';
import { notesToText } from '../../lib/notesText';
import { copyText } from '../../lib/copyText';
import Button from '../ui/Button';
import NotesDocument from './NotesDocument';

/** The meeting has ended: the same notes, now the meeting's page, with one action. */
export default function AfterMeeting({ title, notes, demoMode, recordPath }) {
  const { addToast } = useToast();

  const copyNotes = async () => {
    // False when this webview has no way to copy, or refused
    const copied = await copyText(notesToText(notes, { title }));
    if (copied) addToast('Notes copied', 'success');
    else addToast('Could not copy the notes', 'error');
  };

  return (
    <div className="arlo-screen">
      <h1 className="arlo-title arlo-after-title">{title}</h1>
      <div className="arlo-scroll">
        <NotesDocument notes={notes} />
      </div>
      {demoMode && <p className="arlo-muted">Demo mode: meetings and notes are not stored.</p>}
      <Link className="arlo-link" to={recordPath}>Meeting record</Link>
      <Button onClick={copyNotes}>Copy notes</Button>
    </div>
  );
}
