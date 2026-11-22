import React, { useEffect, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import useZoomAuth from '../hooks/useZoomAuth';
import { shouldSilentReauth } from '../lib/silentReauth';
import OwlIcon from '../components/OwlIcon';
import Button from '../components/ui/Button';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import './AuthView.css';

// At most one silent sign-in attempt per minute. Module-level so a remount of
// AuthView (route change, StrictMode) cannot retry a failing authorize() in a
// loop, while a session that expires hours later can still be renewed.
const SILENT_REAUTH_INTERVAL_MS = 60000;
let lastSilentReauthAt = -Infinity;

export default function AuthView() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, login } = useAuth();
  const {
    isTestMode: isBrowser,
    sdkConfigured,
    sdkError,
    runningContext,
    meetingContext,
    userContextStatus,
    isGuest,
  } = useZoomSdk();
  const { authorize, isAuthorizing, error } = useZoomAuth();
  // 'idle' | 'running' | 'failed' — silent sign-in for users Zoom already reports as authorized
  const [silentState, setSilentState] = useState('idle');

  // Some marketplace app types lack in-client authorize; detect and use browser OAuth instead.
  const isAuthorizeApiUnsupported = (err) => {
    if (!err) return false;
    const message = String(err.message || '');
    return (
      err.code === 80004 ||
      err.reason === 'app_not_support' ||
      /80004/.test(message) ||
      /app_not_support/i.test(message)
    );
  };

  const getPostAuthDestination = useCallback(() => {
    if (runningContext === 'inMeeting' && meetingContext?.meetingUUID) {
      return `/meeting/${encodeURIComponent(meetingContext.meetingUUID)}`;
    }
    return '/home';
  }, [runningContext, meetingContext]);

  // Redirect if already authenticated and SDK context is ready
  useEffect(() => {
    if (!isAuthenticated) return;
    if (runningContext === null) return; // SDK still loading
    // Wait for meeting context when in a meeting (fetched async after runningContext)
    if (runningContext === 'inMeeting' && !meetingContext?.meetingUUID) return;
    navigate(getPostAuthDestination(), { replace: true });
  }, [isAuthenticated, runningContext, meetingContext, navigate, getPostAuthDestination]);

  // In explicit dev mode (?test=true), allow auth bypass
  useEffect(() => {
    if (window.location.search.includes('test=true')) {
      login({ displayName: 'Test User' });
      navigate('/home', { replace: true });
    }
  }, [login, navigate]);

  // Zoom says the app is authorized but Arlo has no session (backend restarted):
  // sign in without asking. authorize() is non-interactive in this state.
  useEffect(() => {
    if (window.location.search.includes('test=true')) return;
    if (!shouldSilentReauth({
      isBrowser,
      authLoading: isLoading,
      isAuthenticated,
      sdkConfigured,
      sdkError,
      userContextStatus,
      alreadyAttempted: Date.now() - lastSilentReauthAt < SILENT_REAUTH_INTERVAL_MS,
    })) return;

    lastSilentReauthAt = Date.now();
    setSilentState('running');
    authorize()
      .then(() => setSilentState('idle'))
      .catch((err) => {
        // Fall back to the Connect button; the user decides what happens next.
        console.warn('Silent sign-in failed:', err?.message || err);
        setSilentState('failed');
      });
  }, [isBrowser, isLoading, isAuthenticated, sdkConfigured, sdkError, userContextStatus, authorize]);

  const handleConnect = async () => {
    setSilentState('idle');
    console.log('handleConnect called:', {
      isBrowser,
      runningContext,
      zoomSdkAvailable: !!window.zoomSdk,
    });
    if (isBrowser) {
      // Outside Zoom — redirect to web OAuth flow
      console.log('Redirecting to web OAuth (isBrowser=true)');
      window.location.href = '/api/auth/start';
      return;
    }
    if (!sdkConfigured) {
      console.warn('Zoom SDK authorization blocked until config completes');
      return;
    }
    console.log('Using in-client OAuth');
    try {
      await authorize();
      // Navigation handled by the useEffect above after login sets isAuthenticated
    } catch (err) {
      if (isAuthorizeApiUnsupported(err)) {
        // In-meeting OAuth unavailable for this app type; use the browser redirect flow.
        console.warn('Zoom authorize API not supported for this app/client, falling back to web OAuth');
        window.location.href = '/api/auth/start';
        return;
      }
      console.error('Authentication error:', err);
    }
  };

  // Show spinner while session is being restored or authenticated but waiting for SDK
  if (
    isLoading ||
    (isAuthenticated && runningContext === null) ||
    (!isBrowser && !sdkConfigured && !sdkError) ||
    // SDK configured but user status not read yet: don't flash the Connect button
    (!isBrowser && sdkConfigured && isGuest === null)
  ) {
    return (
      <div className="auth-view">
        <div className="auth-content">
          <LoadingSpinner size={48} />
        </div>
      </div>
    );
  }

  if (silentState === 'running') {
    return (
      <div className="auth-view">
        <div className="auth-content" role="status" aria-live="polite">
          <LoadingSpinner size={48} />
          <p className="text-muted">Signing you in…</p>
        </div>
      </div>
    );
  }

  const errorMessage = silentState === 'failed'
    ? 'Could not sign you in automatically. Connect with Zoom to continue.'
    : (sdkError || error);

  return (
    <div className="auth-view">
      <div className="auth-content">
        <div className="auth-owl">
          <OwlIcon size={64} />
        </div>

        <div className="auth-text text-serif">
          <h1 className="text-3xl">Arlo</h1>
          <p className="text-muted">
            In-meeting AI assistant — real-time transcripts, summaries, and action items.
          </p>
        </div>

        {errorMessage && (
          <p className="text-sm" style={{ color: 'var(--color-danger, #ef4444)' }}>
            {errorMessage}
          </p>
        )}

        <Button
          size="lg"
          onClick={handleConnect}
          disabled={isAuthorizing || (!isBrowser && !sdkConfigured)}
          className="auth-btn"
        >
          {isAuthorizing ? 'Connecting...' : 'Connect with Zoom'}
        </Button>
      </div>
    </div>
  );
}
