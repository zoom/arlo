/**
 * Does the meeting-access check take the screen's place?
 *
 * Before the first verification, yes: nothing about the meeting may show until
 * the server has confirmed this person is in it. Once access was verified for
 * this meeting, a re-check (every socket reconnect runs one) keeps the screen
 * mounted, so notes, a half-typed question or an answer are not lost. A check
 * that got no verdict (network down, server restarting) is tried again and
 * keeps the screen too. A refusal always replaces it.
 */
export function accessHidesScreen(access) {
  const status = access?.status;
  if (status === 'verified') return false;
  if (access?.everVerified === true) {
    if (status === 'verifying') return false;
    if (status === 'denied' && access.transient === true) return false;
  }
  return true;
}
