import React, { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button';

/**
 * The owner's switch for sharing the notes with everyone in the meeting who
 * has Arlo open: live in their panels, not a chat post. One quiet button; when
 * the notes are shared, a line says so and the button stops it. There is no
 * confirm step: it can be undone with the same click.
 *
 * `shared` is what the server holds, so a change that failed reads as it was.
 * `onChange(next)` saves and resolves when the server has answered; the caller
 * says so when it could not. The button is disabled meanwhile.
 */
export default function ShareNotes({ shared, onChange }) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const change = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onChange(!shared);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className="arlo-share">
      {/* Always here, so a screen reader hears the text when it appears */}
      <span className="arlo-share-status" role="status">{shared ? 'Shared with everyone in the meeting' : ''}</span>
      <Button variant="link" size="sm" onClick={change} disabled={saving}>
        {shared ? 'Stop sharing' : 'Share notes with everyone'}
      </Button>
    </div>
  );
}
