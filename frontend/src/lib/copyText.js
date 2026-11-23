/**
 * Copy text to the clipboard. Resolves to true when it was copied, false when
 * it could not be; never rejects.
 *
 * Zoom's embedded webview can lack `navigator.clipboard` or refuse it, so a
 * failed or missing clipboard API falls back to selecting the text in a hidden
 * textarea and asking the page to copy it.
 */
export async function copyText(text) {
  if (typeof text !== 'string' || text === '') return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not available here or permission refused: try the page's own copy
  }
  return copyThroughTextarea(text);
}

function copyThroughTextarea(text) {
  const hadFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  // Off screen, and no scroll jump when it takes focus
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (hadFocus && typeof hadFocus.focus === 'function') hadFocus.focus({ preventScroll: true });
  }
}
