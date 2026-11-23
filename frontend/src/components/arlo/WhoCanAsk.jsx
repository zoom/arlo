import React, { useState } from 'react';
import Button from '../ui/Button';
import WhoCanAskChoice from './WhoCanAskChoice';

const SUMMARY = { owner: 'Only me', anyone: 'Anyone' };

/**
 * The owner's "who can ask Arlo" setting, under the ask input: one quiet line
 * that says what it is, and opens the two choices on request. The line shows
 * what the server holds, so a change that failed reads as it was.
 * `onChange(value)` saves and resolves when the server has answered.
 */
export default function WhoCanAsk({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const choose = async (next) => {
    if (saving) return;
    if (next !== value) {
      setSaving(true);
      try {
        await onChange(next);
      } finally {
        setSaving(false);
      }
    }
    setOpen(false);
  };

  if (open) {
    return (
      <div className="arlo-who-can-ask">
        <WhoCanAskChoice value={value} onChange={choose} disabled={saving} />
      </div>
    );
  }
  return (
    <p className="arlo-who-can-ask arlo-muted">
      <span>Who can ask: {SUMMARY[value] || SUMMARY.owner}</span>
      <span aria-hidden="true">·</span>
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>Change</Button>
    </p>
  );
}
