import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { useAuth } from '../contexts/AuthContext';
import { useMeeting } from '../contexts/MeetingContext';
import { collaborateRedirect } from '../lib/collaborate';

/**
 * While the app runs in Zoom's Collaborate mode the owner's view is shared
 * with the whole meeting as a screen, so the app stays on the meeting's Arlo
 * screen: Settings, Home, the meeting record, the classic dashboard and every
 * other route go back to it (lib/collaborate.js `collaborateRedirect`). The
 * one guard for all routes; it renders nothing.
 */
export default function CollaborateGuard() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { inCollaborate } = useZoomSdk();
  const { isAuthenticated, isLoading } = useAuth();
  const { meetingId } = useMeeting();
  const target = collaborateRedirect({
    inCollaborate, pathname, meetingId, isAuthenticated, authLoading: isLoading,
  });
  useEffect(() => {
    if (target !== null) navigate(target, { replace: true });
  }, [target, navigate]);
  return null;
}
