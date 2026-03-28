import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ZoomSdkProvider, useZoomSdk } from './contexts/ZoomSdkContext';
import { MeetingProvider } from './contexts/MeetingContext';
import { ToastProvider } from './contexts/ToastContext';
import { VerticalProvider, useVertical } from './contexts/VerticalContext';
import { DemoDataProvider } from './hooks/useDemoData';
import { FeatureLayoutProvider } from './hooks/useFeatureLayout';
import ErrorBoundary from './components/ErrorBoundary';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';
import LoadingSpinner from './components/ui/LoadingSpinner';

// Views
import AuthView from './views/AuthView';
import HomeView from './views/HomeView';
import MeetingsListView from './views/MeetingsListView';
import MeetingDetailView from './views/MeetingDetailView';
import InMeetingView from './views/InMeetingView';
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
 * - Browser + authenticated: redirect to /home (or /select-vertical if not selected)
 * - Browser + unauthenticated: show marketing landing page
 */
function RootView() {
  const { isTestMode: isBrowser, isGuest, meetingContext, runningContext } = useZoomSdk();
  const { isAuthenticated, isLoading } = useAuth();
  const { isVerticalSelected } = useVertical();
  const navigate = useNavigate();

  useEffect(() => {
    if (isBrowser) {
      if (!isLoading && isAuthenticated) {
        // Check if vertical is selected, if not go to selector
        if (!isVerticalSelected) {
          navigate('/select-vertical', { replace: true });
        } else {
          navigate('/home', { replace: true });
        }
      }
      return;
    }

    // Inside Zoom: wait for SDK to determine guest status
    if (isGuest === null) return; // SDK still loading

    if (isGuest) {
      // Guest user — route to guest views
      const inMeeting = runningContext === 'inMeeting';
      const meetingUUID = meetingContext?.meetingUUID;
      if (inMeeting && meetingUUID) {
        navigate(`/guest/${encodeURIComponent(meetingUUID)}`, { replace: true });
      } else {
        navigate('/guest', { replace: true });
      }
    } else {
      // Authorized user — route to auth for token exchange
      navigate('/auth', { replace: true });
    }
  }, [isBrowser, isAuthenticated, isLoading, isGuest, runningContext, meetingContext, navigate, isVerticalSelected]);

  // Show spinner while loading
  if (isLoading || (!isBrowser && isGuest === null)) {
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

/**
 * Protected route that also requires vertical selection.
 * Redirects to /select-vertical if no vertical is chosen.
 */
function VerticalProtectedRoute({ children }) {
  const { isVerticalSelected } = useVertical();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isVerticalSelected) {
      navigate('/select-vertical', { replace: true });
    }
  }, [isVerticalSelected, navigate]);

  if (!isVerticalSelected) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <LoadingSpinner />
      </div>
    );
  }

  return children;
}

function App() {
  return (
    <ThemeProvider>
      <ZoomSdkProvider>
        <AuthProvider>
          <VerticalProvider>
            <DemoDataProvider>
              <FeatureLayoutProvider>
                <MeetingProvider>
                <ToastProvider>
                <ErrorBoundary>
                  <HashRouter>
                    <Routes>
                      {/* Root: landing page (browser) or redirect to /auth (Zoom) */}
                      <Route path="/" element={<RootView />} />

                      {/* In-client Zoom OAuth (PKCE) */}
                      <Route path="/auth" element={<AuthView />} />

                      {/* Web OAuth flow */}
                      <Route path="/welcome" element={<OnboardingView />} />
                      <Route path="/auth-error" element={<OAuthErrorView />} />

                      {/* Vertical selector (after auth, before main app) */}
                      <Route path="/select-vertical" element={
                        <ProtectedRoute>
                          <VerticalSelectorView />
                        </ProtectedRoute>
                      } />

                      {/* Guest routes */}
                      <Route path="/guest" element={<GuestNoMeetingView />} />
                      <Route path="/guest/:id" element={<GuestInMeetingView />} />

                      {/* Authenticated routes (inside AppShell, requires vertical selection) */}
                      <Route element={
                        <ProtectedRoute>
                          <VerticalProtectedRoute>
                            <AppShell />
                          </VerticalProtectedRoute>
                        </ProtectedRoute>
                      }>
                        <Route path="/home" element={<HomeView />} />
                        <Route path="/meetings" element={<MeetingsListView />} />
                        <Route path="/meetings/:id" element={<MeetingDetailView />} />
                        <Route path="/meeting/:id" element={<InMeetingView />} />
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
                </MeetingProvider>
              </FeatureLayoutProvider>
            </DemoDataProvider>
          </VerticalProvider>
        </AuthProvider>
      </ZoomSdkProvider>
    </ThemeProvider>
  );
}

export default App;
