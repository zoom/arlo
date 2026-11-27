import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useMeeting } from './MeetingContext';
import { useZoomSdk } from './ZoomSdkContext';
import {
  CONNECT_POLL_MS, CONNECT_WAIT_MS, disconnectGithub as disconnectOnServer, readConnectors, startGithubConnect,
} from '../lib/connectGithub';

const ConnectorsContext = createContext();

/**
 * The signed-in person's connected accounts (GET /api/connectors): today one,
 * GitHub. Read when someone signs in, dropped at once when they sign out or
 * someone else is signed in, and read again when the server says it changed
 * (`connectors.updated` on the meeting's socket: about the person, not about
 * a meeting, and nothing in it is used) and when the panel comes back into
 * view or gets the focus back. While it waits for the browser it also asks
 * every CONNECT_POLL_MS: the account is connected in the system browser,
 * outside a meeting there is no socket to say so, and inside Zoom the panel
 * may never lose the focus.
 *
 *   github          null (not known), or { available, connected, login }
 *   githubConnect   null | 'starting' (a ticket is asked for) | 'waiting'
 *                   (the browser was opened: "Finish in your browser…") |
 *                   'timeout' (CONNECT_WAIT_MS passed without word)
 *   connectGithub() 'opened' | 'failed' | 'refused' | 'busy'
 *   disconnectGithub() true when the server disconnected the account
 *
 * The wait ends only when a read says the account is connected, or when
 * CONNECT_WAIT_MS has passed. A read that says "not connected" (someone
 * glanced back at the panel before finishing) or that fails changes nothing.
 * The GitHub login is for Settings only: no meeting view reads this context.
 */
export function ConnectorsProvider({ children }) {
  const { isAuthenticated, user } = useAuth();
  const { ws } = useMeeting();
  const { zoomSdk, isTestMode } = useZoomSdk();
  // Who is signed in; null when nobody is
  const identity = isAuthenticated ? String(user?.id ?? '') : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const zoomSdkRef = useRef(zoomSdk);
  zoomSdkRef.current = zoomSdk;
  const inZoomRef = useRef(!isTestMode);
  inZoomRef.current = !isTestMode;

  const [github, setGithub] = useState(null);
  const [githubConnect, setGithubConnect] = useState(null);
  const connectRef = useRef(null);
  const putConnect = useCallback((value) => {
    connectRef.current = value;
    setGithubConnect(value);
  }, []);

  // One read at a time; a change reported while one runs is read after it
  const readingRef = useRef(null);
  const againRef = useRef(false);
  const refresh = useCallback(() => {
    if (readingRef.current) {
      againRef.current = true;
      return readingRef.current;
    }
    const run = async () => {
      do {
        againRef.current = false;
        const asked = identityRef.current;
        if (asked === null) return;
        const answer = await readConnectors();
        // Signed out or someone else meanwhile: not theirs
        if (identityRef.current !== asked) continue;
        if (answer === 'signed_out') setGithub(null);
        else if (answer !== null) {
          setGithub(answer.github);
          // Word that the account is connected: the wait for the browser is over
          if (answer.github.connected && connectRef.current === 'waiting') putConnect(null);
        }
      } while (againRef.current);
    };
    readingRef.current = run().finally(() => { readingRef.current = null; });
    return readingRef.current;
  }, [putConnect]);

  // Signed in: read. Signed out, or another person: nothing of the one before stays
  useEffect(() => {
    setGithub(null);
    putConnect(null);
    if (identity !== null) refresh();
  }, [identity, refresh, putConnect]);

  // The server says this person's connectors changed
  useEffect(() => {
    if (!ws || identity === null) return undefined;
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event?.data);
      } catch {
        return;
      }
      if (message?.type === 'connectors.updated') refresh();
    };
    ws.addEventListener('message', onMessage);
    return () => ws.removeEventListener('message', onMessage);
  }, [ws, identity, refresh]);

  // Back from the browser
  useEffect(() => {
    if (identity === null) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [identity, refresh]);

  // Waiting for the browser: ask now and then, and give up after CONNECT_WAIT_MS.
  // Over (connected, timed out, signed out, unmounted): nothing is asked any more
  useEffect(() => {
    if (githubConnect !== 'waiting') return undefined;
    const poll = setInterval(() => {
      // Never two at once, and a slow read is not followed by one more for each tick it took
      if (!readingRef.current) refresh();
    }, CONNECT_POLL_MS);
    const timer = setTimeout(() => putConnect('timeout'), CONNECT_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [githubConnect, putConnect, refresh]);

  const connectGithub = useCallback(async () => {
    const asked = identityRef.current;
    if (asked === null || connectRef.current === 'starting' || connectRef.current === 'waiting') return 'busy';
    putConnect('starting');
    const went = await startGithubConnect({ zoomSdk: zoomSdkRef.current, inZoom: inZoomRef.current });
    if (identityRef.current !== asked) return 'busy';
    putConnect(went === 'opened' ? 'waiting' : null);
    return went;
  }, [putConnect]);

  const disconnectGithub = useCallback(async () => {
    const asked = identityRef.current;
    if (asked === null) return false;
    const done = await disconnectOnServer();
    if (identityRef.current !== asked) return false;
    if (done) setGithub((prev) => (prev ? { ...prev, connected: false, login: null } : prev));
    refresh();
    return done;
  }, [refresh]);

  const value = useMemo(() => ({
    github: identity === null ? null : github,
    githubConnect: identity === null ? null : githubConnect,
    connectGithub,
    disconnectGithub,
  }), [identity, github, githubConnect, connectGithub, disconnectGithub]);

  return (
    <ConnectorsContext.Provider value={value}>
      {children}
    </ConnectorsContext.Provider>
  );
}

export function useConnectors() {
  const context = useContext(ConnectorsContext);
  if (!context) {
    throw new Error('useConnectors must be used within a ConnectorsProvider');
  }
  return context;
}
