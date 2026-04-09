import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const ServerSettingsContext = createContext();

export function ServerSettingsProvider({ children }) {
  const [settings, setSettings] = useState({
    meetingPersistenceEnabled: true, // Default to true until we know
    demoMode: false,
    loaded: false,
  });

  useEffect(() => {
    async function fetchSettings() {
      try {
        const response = await fetch('/api/auth/settings');
        if (response.ok) {
          const data = await response.json();
          setSettings({
            meetingPersistenceEnabled: data.meetingPersistenceEnabled,
            demoMode: data.demoMode,
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
    showMeetingHistory: settings.meetingPersistenceEnabled,
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
