import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const ServerSettingsContext = createContext();

/**
 * Default feature flags for demo mode
 */
const defaultFeatures = {
  liveTranscription: true,
  realtimeAISuggestions: true,
  demoData: true,
  meetingHistory: false,
  search: false,
  upcomingMeetings: false,
  autoOpen: false,
  aiChat: false,
};

export function ServerSettingsProvider({ children }) {
  const [settings, setSettings] = useState({
    demoMode: true, // Default to demo mode
    meetingPersistenceEnabled: false,
    features: defaultFeatures,
    privacyNotice: '',
    loaded: false,
  });

  useEffect(() => {
    async function fetchSettings() {
      try {
        const response = await fetch('/api/auth/settings');
        if (response.ok) {
          const data = await response.json();
          setSettings({
            demoMode: data.demoMode ?? true,
            meetingPersistenceEnabled: data.meetingPersistenceEnabled ?? false,
            features: data.features ?? defaultFeatures,
            privacyNotice: data.privacyNotice ?? '',
            loaded: true,
          });
        }
      } catch {
        // Use defaults if fetch fails
        setSettings(prev => ({ ...prev, loaded: true }));
      }
    }
    fetchSettings();
  }, []);

  const contextValue = useMemo(() => ({
    ...settings,
    // Helper to check if meeting history feature should be shown
    showMeetingHistory: settings.features?.meetingHistory ?? false,
    // Helper to check if search is available
    showSearch: settings.features?.search ?? false,
    // Helper to check if upcoming meetings is available
    showUpcomingMeetings: settings.features?.upcomingMeetings ?? false,
  }), [settings]);

  return (
    <ServerSettingsContext.Provider value={contextValue}>
      {children}
    </ServerSettingsContext.Provider>
  );
}

export function useServerSettings() {
  const context = useContext(ServerSettingsContext);
  if (!context) {
    throw new Error('useServerSettings must be used within a ServerSettingsProvider');
  }
  return context;
}
