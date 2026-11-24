/**
 * Puts everything in the document outside `element` out of reach, for a modal
 * surface: every sibling of the element and of each of its ancestors, up to
 * the body, gets `inert` (the browser then keeps focus and clicks away from
 * it) and `aria-hidden="true"` (for assistive technology, and where `inert`
 * is not implemented).
 *
 * Returns a function that gives back exactly what was set here. An attribute
 * that was there already is left alone, then and now: it is someone else's.
 * The function is safe to call more than once.
 */
export function makeOutsideInert(element) {
  const changed = [];
  for (let node = element; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node) continue;
      const setInert = !sibling.hasAttribute('inert');
      const setHidden = !sibling.hasAttribute('aria-hidden');
      if (setInert) sibling.setAttribute('inert', '');
      if (setHidden) sibling.setAttribute('aria-hidden', 'true');
      if (setInert || setHidden) changed.push({ sibling, setInert, setHidden });
    }
  }
  return () => {
    changed.splice(0).forEach(({ sibling, setInert, setHidden }) => {
      if (setInert) sibling.removeAttribute('inert');
      if (setHidden) sibling.removeAttribute('aria-hidden');
    });
  };
}
