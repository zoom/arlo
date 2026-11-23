import { useEffect, useRef } from 'react';

/**
 * Keeps Zoom's Dynamic Indicator in step with `text` (null = no indicator).
 * Does nothing when the Zoom client did not accept the API. Failures are
 * logged and never reach the user: the indicator is an extra, not a feature
 * anything depends on.
 */
export function useDynamicIndicator({ zoomSdk, supported, text }) {
  const shownRef = useRef(null); // what this client last asked Zoom to show
  const sdkRef = useRef(zoomSdk);
  sdkRef.current = zoomSdk;

  useEffect(() => {
    if (!supported || !zoomSdk || text === shownRef.current) return;
    shownRef.current = text;
    const call = text
      ? zoomSdk.setDynamicIndicator({ text })
      : zoomSdk.removeDynamicIndicator();
    // Status texts only (no meeting content), so they are safe to log
    const action = text ? `set "${text}"` : 'remove';
    Promise.resolve(call)
      .then((result) => console.log(`[indicator] ${action}: Zoom answered`, result?.message ?? result))
      .catch((error) => console.warn(`[indicator] ${action} failed:`, error?.code, error?.message));
  }, [zoomSdk, supported, text]);

  // The panel is closing: an indicator this client set would otherwise stay
  useEffect(() => {
    if (!supported) return undefined;
    const clear = () => {
      if (!shownRef.current) return;
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
}

export default useDynamicIndicator;
