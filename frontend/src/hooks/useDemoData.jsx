import { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react';
import { useServerSettings } from '../contexts/ServerSettingsContext';

// Context for demo data setting
const DemoDataContext = createContext(null);

/**
 * Sample data exists only in demo mode, and only for a user who asked for it:
 * it is off until turned on in Settings. Outside demo mode it is never shown.
 */
export function DemoDataProvider({ children }) {
  const { demoMode, loaded } = useServerSettings();
  const [wanted, setWanted] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('arlo-show-demo-data')) === true;
    } catch {
      return false;
    }
  });

  // Persist to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('arlo-show-demo-data', JSON.stringify(wanted));
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
