import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import LoadingSpinner from './ui/LoadingSpinner';

// Explicit dev mode: only bypass auth when ?test=true is in the URL
const isDevMode = window.location.search.includes('test=true');

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  const { isTestMode: isBrowser, runningContext, isGuest, meetingContext } = useZoomSdk();

  // Dev mode: bypass auth for local development with ?test=true
  if (isDevMode) return children;

  // While restoring session, show spinner
  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <LoadingSpinner />
      </div>
    );
  }

  // In Zoom mode, also wait for SDK context to be ready
  if (!isBrowser && runningContext === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    if (isBrowser) {
      return <Navigate to="/" replace />;
    }
    // Guest in Zoom — redirect to guest views instead of auth
    if (isGuest) {
      const inMeeting = runningContext === 'inMeeting';
      const meetingUUID = meetingContext?.meetingUUID;
      if (inMeeting && meetingUUID) {
        return <Navigate to={`/guest/${encodeURIComponent(meetingUUID)}`} replace />;
      }
      return <Navigate to="/guest" replace />;
    }
    // AuthView returns the user to this page of the meeting after signing in again
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return children;
}
