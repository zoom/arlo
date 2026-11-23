/** Leave the app for another URL. Kept in its own module so tests can observe it. */
export function goTo(url) {
  window.location.assign(url);
}
