import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ZoomSdkProvider, useZoomSdk } from './contexts/ZoomSdkContext';
import { MeetingProvider } from './contexts/MeetingContext';
import { ArloProvider } from './contexts/ArloContext';
import { ToastProvider } from './contexts/ToastContext';
import { VerticalProvider } from './contexts/VerticalContext';
import { ServerSettingsProvider } from './contexts/ServerSettingsContext';
import { DemoDataProvider } from './hooks/useDemoData';
import { FeatureLayoutProvider } from './hooks/useFeatureLayout';
import ErrorBoundary from './components/ErrorBoundary';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';
import CollaborateGuard from './components/CollaborateGuard';
import LoadingSpinner from './components/ui/LoadingSpinner';

// Views
import AuthView from './views/AuthView';
import HomeView from './views/HomeView';
import MeetingsListView from './views/MeetingsListView';
import MeetingDetailView from './views/MeetingDetailView';
import InMeetingView from './views/InMeetingView';
import ArloMeetingView from './views/ArloMeetingView';
import MeetingRecordView from './views/MeetingRecordView';
import SettingsView from './views/SettingsView';
import GuestNoMeetingView from './views/GuestNoMeetingView';
import GuestInMeetingView from './views/GuestInMeetingView';
import SearchResultsView from './views/SearchResultsView';
import UpcomingMeetingsView from './views/UpcomingMeetingsView';
import LandingPageView from './views/LandingPageView';
import OnboardingView from './views/OnboardingView';
import OAuthErrorView from './views/OAuthErrorView';
import NotFoundView from './views/NotFoundView';
import VerticalSelectorView from './views/VerticalSelectorView';


/**
 * Root route handler — decides what to show at "/".
 * - Inside Zoom: redirect to /auth (in-client PKCE flow)
 * - Browser + authenticated: redirect to /home
 * - Browser + unauthenticated: show marketing landing page
 */
function RootView() {
  const { isTestMode: isBrowser, isGuest, meetingContext, runningContext, sdkError } = useZoomSdk();
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isBrowser) {
      if (!isLoading && isAuthenticated) {
        navigate('/home', { replace: true });
      }
      return;
    }

    // If SDK configuration failed in Zoom, route to auth instead of hanging on spinner.
    if (sdkError) {
      navigate('/auth', { replace: true });
      return;
    }

    // Inside Zoom: wait for SDK to determine guest status and auth check to complete
    if (isGuest === null || isLoading) return; // SDK or auth still loading

    console.log('RootView routing:', { isGuest, runningContext, hasMeetingContext: !!meetingContext });

    if (isGuest) {
      // Guest user — route to the meeting view (the same screens as signed-in users)
      const inMeeting = runningContext === 'inMeeting';
      const meetingUUID = meetingContext?.meetingUUID;
      const meetingID = meetingContext?.meetingID;

      console.log('Guest routing check:', { inMeeting, hasMeetingId: !!(meetingUUID || meetingID) });

      // If we're in a meeting but don't have meeting context yet, wait for it
      // Give it a reasonable timeout (meetingContext should be set even if empty)
      if (inMeeting && meetingContext === null) {
        console.log('Guest in meeting, waiting for meetingContext to load...');
        return; // Wait for meetingContext to be populated
      }

      // Use meetingUUID or meetingID for routing
      const routeId = meetingUUID || meetingID;

      if (inMeeting && routeId) {
        // Guests get the Arlo screens too: the participant view
        console.log('Guest routing to the meeting view');
        navigate(`/guest-meeting/${encodeURIComponent(routeId)}`, { replace: true });
      } else {
        console.log('Guest has no meeting ID, routing to /guest');
        navigate('/guest', { replace: true });
      }
    } else {
      // Authorized user — check if already has a session to avoid re-auth
      if (isAuthenticated) {
        // User already has a valid session, skip auth view
        const inMeeting = runningContext === 'inMeeting';
        const routeId = meetingContext?.meetingUUID || meetingContext?.meetingID;
        if (inMeeting && routeId) {
          console.log('Authorized user with session, routing to meeting');
          navigate(`/meeting/${encodeURIComponent(routeId)}`, { replace: true });
        } else {
          navigate('/home', { replace: true });
        }
      } else {
        // Needs to complete OAuth flow to get session
        navigate('/auth', { replace: true });
      }
    }
  }, [isBrowser, isAuthenticated, isLoading, isGuest, runningContext, meetingContext, navigate, sdkError]);

  // Show spinner while loading
  // Wait for: auth check, SDK guest status, and meetingContext (if in meeting)
  const waitingForMeetingContext = !isBrowser && isGuest && runningContext === 'inMeeting' && meetingContext === null;
  const waitingForSdk = !isBrowser && (isGuest === null || isLoading);
  if (isLoading || waitingForSdk || waitingForMeetingContext) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!isBrowser) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <LoadingSpinner />
      </div>
    );
  }

  return <LandingPageView />;
}

function App() {
  return (
    <ThemeProvider>
      <ZoomSdkProvider>
        <AuthProvider>
          <ServerSettingsProvider>
            <VerticalProvider>
              <DemoDataProvider>
                <FeatureLayoutProvider>
                  <MeetingProvider>
                  <ArloProvider>
                  <ToastProvider>
                <ErrorBoundary>
                  <HashRouter>
                    {/* In Zoom's Collaborate mode the only screen is the meeting's Arlo screen */}
                    <CollaborateGuard />
                    <Routes>
                      {/* Root: landing page (browser) or redirect to /auth (Zoom) */}
                      <Route path="/" element={<RootView />} />

                      {/* In-client Zoom OAuth (PKCE) */}
                      <Route path="/auth" element={<AuthView />} />

                      {/* Web OAuth flow */}
                      <Route path="/welcome" element={<OnboardingView />} />
                      <Route path="/auth-error" element={<OAuthErrorView />} />

                      {/* Vertical selector, reached from Settings */}
                      <Route path="/select-vertical" element={
                        <ProtectedRoute>
                          <VerticalSelectorView />
                        </ProtectedRoute>
                      } />

                      {/* Guest routes */}
                      <Route path="/guest" element={<GuestNoMeetingView />} />
                      <Route path="/guest/:id" element={<GuestInMeetingView />} />
                      {/* A guest in a meeting: the single-action Arlo screens and the meeting record */}
                      <Route path="/guest-meeting/:id" element={<ArloMeetingView isGuestMode />} />
                      <Route path="/guest-meeting/:id/record" element={<MeetingRecordView isGuestMode />} />
                      {/* The earlier dashboard for a guest. Nothing links here; kept so its tests keep running */}
                      <Route path="/guest-meeting/:id/classic" element={<InMeetingView isGuestMode={true} />} />

                      {/* Authenticated routes (inside AppShell) */}
                      <Route element={
                        <ProtectedRoute>
                          <AppShell />
                        </ProtectedRoute>
                      }>
                        <Route path="/home" element={<HomeView />} />
                        <Route path="/meetings" element={<MeetingsListView />} />
                        <Route path="/meetings/:id" element={<MeetingDetailView />} />
                        {/* In a meeting: the single-action Arlo screens and the meeting record */}
                        <Route path="/meeting/:id" element={<ArloMeetingView />} />
                        <Route path="/meeting/:id/record" element={<MeetingRecordView />} />
                        {/* The earlier dashboard, linked from Settings only */}
                        <Route path="/meeting/:id/classic" element={<InMeetingView />} />
                        <Route path="/search" element={<SearchResultsView />} />
                        <Route path="/settings" element={<SettingsView />} />
                        <Route path="/upcoming" element={<UpcomingMeetingsView />} />
                      </Route>

                      {/* 404 */}
                      <Route path="*" element={<NotFoundView />} />
                    </Routes>
                  </HashRouter>
                </ErrorBoundary>
                </ToastProvider>
                  </ArloProvider>
                  </MeetingProvider>
                </FeatureLayoutProvider>
              </DemoDataProvider>
            </VerticalProvider>
          </ServerSettingsProvider>
        </AuthProvider>
      </ZoomSdkProvider>
    </ThemeProvider>
  );
}

export default App;
