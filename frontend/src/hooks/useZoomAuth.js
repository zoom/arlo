import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';

/**
 * Shared hook for Zoom in-client OAuth using PKCE.
 * Registers onAuthorized listener inside authorize() — after SDK is configured
 * but before calling zoomSdk.authorize() — to avoid race conditions.
 *
 * Note: The Zoom SDK's onAuthorized event returns { code, result, redirectUri, timestamp }
 * but does NOT return the state. We use the state from our own PKCE request instead.
 */
export default function useZoomAuth() {
  const { login } = useAuth();
  const { zoomSdk } = useZoomSdk();
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState(null);

  // Track active listener for cleanup on unmount
  const cleanupRef = useRef(null);

  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const authorize = useCallback(async () => {
    if (!zoomSdk) throw new Error('Zoom SDK not available');

    setIsAuthorizing(true);
    setError(null);

    try {
      // 1. Get PKCE challenge from backend
      console.log('Fetching PKCE challenge from backend...');
      const response = await fetch('/api/auth/authorize');
      if (!response.ok) throw new Error('Failed to get auth challenge');
      const { codeChallenge, state } = await response.json();
      console.log('Got PKCE challenge, state:', state);

      // Helper to exchange code for session
      const exchangeCode = async (code) => {
        const callbackResponse = await fetch('/api/auth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ code, state }),
        });

        if (!callbackResponse.ok) {
          const data = await callbackResponse.json().catch(() => ({}));
          throw new Error(data.error || `Auth callback failed (${callbackResponse.status})`);
        }

        const data = await callbackResponse.json();
        login(data.user, data.wsToken);
        return data;
      };

      // 2. Register listener BEFORE calling authorize (SDK is configured by now)
      console.log('Registering onAuthorized listener...');
      const authPromise = new Promise((resolve, reject) => {
        let resolved = false;
        let pollIntervalId = null;

        // Poll for code as fallback (in case browser callback completes but onAuthorized doesn't fire)
        const startPolling = () => {
          console.log('Starting poll for authorization code...');
          pollIntervalId = setInterval(async () => {
            if (resolved) {
              clearInterval(pollIntervalId);
              return;
            }
            try {
              const pollResponse = await fetch(`/api/auth/poll-code?state=${encodeURIComponent(state)}`);
              const pollData = await pollResponse.json();
              if (pollData.ready && pollData.code) {
                console.log('Poll received code, exchanging...');
                clearInterval(pollIntervalId);
                if (!resolved) {
                  resolved = true;
                  zoomSdk.removeEventListener('onAuthorized', handler);
                  cleanupRef.current = null;
                  try {
                    const result = await exchangeCode(pollData.code);
                    resolve(result);
                  } catch (err) {
                    reject(err);
                  }
                }
              }
            } catch (err) {
              // Polling error - continue trying
              console.warn('Poll error:', err);
            }
          }, 1000); // Poll every second
        };

        // Timeout after 60 seconds
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            console.error('Authorization timeout after 60s');
            clearInterval(pollIntervalId);
            zoomSdk.removeEventListener('onAuthorized', handler);
            cleanupRef.current = null;
            reject(new Error('Authorization timed out'));
          }
        }, 60000);

        const handler = async (event) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          clearInterval(pollIntervalId);
          console.log('onAuthorized event received:', event);
          zoomSdk.removeEventListener('onAuthorized', handler);
          cleanupRef.current = null;

          const { code } = event;
          if (!code) {
            reject(new Error('No authorization code received'));
            return;
          }

          try {
            const result = await exchangeCode(code);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        };

        cleanupRef.current = () => {
          clearTimeout(timeoutId);
          clearInterval(pollIntervalId);
          zoomSdk.removeEventListener('onAuthorized', handler);
        };

        zoomSdk.addEventListener('onAuthorized', handler);

        // Start polling after a short delay (give onAuthorized a chance to fire first)
        setTimeout(startPolling, 2000);
      });

      // 3. Trigger Zoom OAuth (listener is already registered)
      console.log('Calling zoomSdk.authorize with challenge...');
      try {
        const authorizeResult = await zoomSdk.authorize({ codeChallenge, state });
        console.log('zoomSdk.authorize returned:', authorizeResult);
      } catch (authError) {
        console.error('zoomSdk.authorize failed:', authError);
        throw authError;
      }
      console.log('Waiting for onAuthorized event...');

      // 4. Wait for the onAuthorized handler to complete the exchange
      return await authPromise;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setIsAuthorizing(false);
    }
  }, [zoomSdk, login]);

  return { authorize, isAuthorizing, error };
}
