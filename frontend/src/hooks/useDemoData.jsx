import { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react';
import { useServerSettings } from '../contexts/ServerSettingsContext';

// Context for demo data setting
// 'true' only after the user turned sample data on in Settings
const STORAGE_KEY = 'arlo-sample-data';
const DemoDataContext = createContext(null);

/**
 * Sample data exists only in demo mode, and only for a user who asked for it:
 * it is off until turned on in Settings. Outside demo mode it is never shown.
 */
export function DemoDataProvider({ children }) {
  const { demoMode, loaded } = useServerSettings();
  const [wanted, setWanted] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  // The old key was written as "true" for every user without anyone asking
  // for sample data, so it says nothing about what the user wants. Drop it.
  useEffect(() => {
    try {
      localStorage.removeItem('arlo-show-demo-data');
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Persist to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, wanted ? 'true' : 'false');
    } catch {
      // localStorage unavailable
    }
  }, [wanted]);

  const setShowDemoData = useCallback((value) => {
    setWanted(value === true);
  }, []);

  const toggleDemoData = useCallback(() => {
    setWanted((prev) => !prev);
  }, []);

  // Until the server has answered, assume the stricter case: no sample data
  const demoDataAvailable = loaded && demoMode === true;
  const value = useMemo(() => ({
    showDemoData: demoDataAvailable && wanted,
    demoDataAvailable,
    setShowDemoData,
    toggleDemoData,
  }), [demoDataAvailable, wanted, setShowDemoData, toggleDemoData]);

  return (
    <DemoDataContext.Provider value={value}>
      {children}
    </DemoDataContext.Provider>
  );
}

/**
 * Hook to access demo data setting.
 * Returns { showDemoData, demoDataAvailable, setShowDemoData, toggleDemoData }
 */
export function useDemoData() {
  const context = useContext(DemoDataContext);
  if (!context) {
    throw new Error('useDemoData must be used within a DemoDataProvider');
  }
  return context;
}

export default useDemoData;
