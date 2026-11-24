import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { indicatorState, hasDidText } from '../lib/dynamicIndicator';

/** Changes of state within this time are one call to Zoom: the last one. */
export const COALESCE_MS = 250;
/** How long "Arlo posted to the chat" and the like are shown. */
export const DID_MS = 4000;

// What Zoom was last asked to show, as text: the sentence and its style
const signatureOf = (state, textOnly) => (
  state === null ? null : `${state.text}\n${!textOnly && state.style ? JSON.stringify(state.style) : ''}`
);
// Nothing is known about what Zoom shows (a timer was on it): whatever is sent next is sent
const UNKNOWN = Symbol('unknown');

/**
 * Keeps Zoom's Dynamic Indicator in step with Arlo's state
 * (lib/dynamicIndicator.js `indicatorState`; no state = no indicator).
 * Does nothing when the Zoom client did not accept the API. Failures are
 * logged and never reach the user: the indicator is an extra, not a feature
 * anything depends on.
 *
 *   inputs      what indicatorState() takes, but for `didTool`
 *   did         { id, tool }: the newest action of this meeting that ended as
 *               done while this panel was open, or null. Each id is shown
 *               once, for DID_MS, when its tool has a sentence. One timer,
 *               cleared when the panel goes; dropped when there is no
 *               indicator to show it on
 *   timer       the panel's countdown on the indicator (lib/indicatorTimer.js)
 *   meetingKey  the meeting the panel is in, or null: a timer does not
 *               outlive it
 *
 * Zoom is called only when the text or the style changed, COALESCE_MS after
 * the last change, so a state that comes and goes within that time is never
 * sent.
 *
 * A style Zoom refuses: the same text is sent again without one, and this
 * panel sends text only from then on. A refused text is logged and left.
 *
 * While a timer this panel started runs, nothing is sent: a status text might
 * end the countdown (not known). When the timer is over the state of that
 * moment is set, whatever was shown before; a panel that has no state to show
 * (it does not own the indicator) takes the indicator down instead, unless a
 * "stop the timer" did that already. The stream this panel started stopping
 * ends the timer with it.
 */
export function useDynamicIndicator({
  zoomSdk, supported, inputs, did = null, timer = null, meetingKey = null,
}) {
  const [didTool, setDidTool] = useState(null);
  const state = indicatorState({ ...inputs, didTool });
  const shown = state !== null;

  const shownRef = useRef(null); // what this client last asked Zoom to show (signatureOf)
  const textOnlyRef = useRef(false); // Zoom refused a style: none is sent any more
  const flushRef = useRef(null);
  const didTimerRef = useRef(null);
  const seenDidRef = useRef(null);
  const sdkRef = useRef(zoomSdk);
  sdkRef.current = zoomSdk;
  const supportedRef = useRef(supported);
  supportedRef.current = supported;
  const stateRef = useRef(state);
  stateRef.current = state;
  const timerRef = useRef(timer);
  timerRef.current = timer;

  const timed = () => timerRef.current?.running() === true;

  const remove = useCallback(() => {
    shownRef.current = null;
    new Promise((resolve) => { resolve(sdkRef.current.removeDynamicIndicator()); })
      .then((result) => console.log('[indicator] remove: Zoom answered', result?.message ?? result))
      .catch((error) => console.warn('[indicator] remove failed:', error?.code, error?.message));
  }, []);

  /** Ask Zoom for the state of this moment, when it is not what was asked last. */
  const apply = useCallback(() => {
    const sdk = sdkRef.current;
    if (!supportedRef.current || !sdk || timed()) return;
    const now = stateRef.current;
    const signature = signatureOf(now, textOnlyRef.current);
    if (signature === shownRef.current) return;
    if (now === null) {
      remove();
      return;
    }
    shownRef.current = signature;
    const { text } = now;
    const style = textOnlyRef.current ? null : now.style;
    // Status texts only (fixed sentences, no meeting content), so they are safe to log
    const answered = (result) => console.log(`[indicator] set "${text}": Zoom answered`, result?.message ?? result);
    const failed = (error) => console.warn(`[indicator] set "${text}" failed:`, error?.code, error?.message);
    const send = (options) => new Promise((resolve) => { resolve(sdk.setDynamicIndicator(options)); });
    send(style ? { text, ...style } : { text })
      .then(answered)
      .catch((error) => {
        if (!style) {
          failed(error);
          return undefined;
        }
        // The colors' format is a guess (lib/dynamicIndicator.js): text only from here on
        textOnlyRef.current = true;
        console.warn('[indicator] Zoom refused the style; text only from now on:', error?.code, error?.message);
        // Not over a timer that started meanwhile, and not when something newer was asked for
        if (timed() || shownRef.current !== signature) return undefined;
        shownRef.current = signatureOf(now, true);
        return send({ text }).then(answered).catch(failed);
      });
  }, [remove]);

  // The panel is closing: an indicator this client set would otherwise stay.
  // Declared first, so on unmount it runs before the effects below clean up
  useEffect(() => {
    if (!supported) return undefined;
    const clear = () => {
      clearTimeout(flushRef.current);
      flushRef.current = null;
      const hadTimer = timed();
      if (hadTimer) timerRef.current.end('closed');
      if (!shownRef.current && !hadTimer) return;
      shownRef.current = null;
      try {
        Promise.resolve(sdkRef.current?.removeDynamicIndicator()).catch(() => {});
      } catch {
        // best effort
      }
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, [supported]);

  // What Arlo just did: each action once, for DID_MS
  useEffect(() => {
    const id = did?.id;
    if (typeof id !== 'string' || id === seenDidRef.current) return;
    seenDidRef.current = id;
    if (!hasDidText(did.tool)) return;
    clearTimeout(didTimerRef.current);
    setDidTool(did.tool);
    didTimerRef.current = setTimeout(() => {
      didTimerRef.current = null;
      setDidTool(null);
    }, DID_MS);
  }, [did]);
  // Nothing to show it on: it is not kept for when there is
  useEffect(() => {
    if (shown || didTool === null) return;
    clearTimeout(didTimerRef.current);
    didTimerRef.current = null;
    setDidTool(null);
  }, [shown, didTool]);
  useEffect(() => () => clearTimeout(didTimerRef.current), []);

  // The state changed: Zoom is asked once things have been still for COALESCE_MS
  const wanted = signatureOf(state, false);
  useEffect(() => {
    if (!supported || !zoomSdk) return undefined;
    clearTimeout(flushRef.current);
    flushRef.current = setTimeout(() => {
      flushRef.current = null;
      apply();
    }, COALESCE_MS);
    return undefined;
  }, [zoomSdk, supported, wanted, apply]);
  useEffect(() => () => clearTimeout(flushRef.current), []);

  // A timer of this panel is over: Zoom shows the countdown's end, or nothing
  useEffect(() => {
    if (!timer) return undefined;
    return timer.onEnd((reason) => {
      // The panel is closing: the indicator is removed there
      if (reason === 'closed' || !supportedRef.current || !sdkRef.current) return;
      if (stateRef.current === null) {
        // No status of this panel's to put back. A stop took the indicator down already
        if (reason === 'stopped') shownRef.current = null;
        else remove();
        return;
      }
      shownRef.current = UNKNOWN;
      apply();
    });
  }, [timer, apply, remove]);

  // The stream this panel started stopped (the indicator goes): its timer goes with it
  const wasShownRef = useRef(false);
  useEffect(() => {
    if (wasShownRef.current && !shown && timed()) timerRef.current.end('stream');
    wasShownRef.current = shown;
  }, [shown]);

  // Another meeting, or none: a timer is the meeting's it was started in
  useEffect(() => () => {
    if (timed()) timerRef.current.end('meeting');
  }, [meetingKey]);
}

export default useDynamicIndicator;
