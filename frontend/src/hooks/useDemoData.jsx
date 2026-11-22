import { useState, useEffect, useCallback, createContext, useContext } from 'react';

// Context for demo data setting
const DemoDataContext = createContext(null);

/**
 * Provider component for demo data setting.
 * Wrap your app with this to enable the useDemoData hook.
 */
export function DemoDataProvider({ children }) {
  const [showDemoData, setShowDemoDataState] = useState(() => {
    // Default to true (show demo data) for first-time users
    const stored = localStorage.getItem('arlo-show-demo-data');
    return stored === null ? true : JSON.parse(stored);
  });

  // Persist to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('arlo-show-demo-data', JSON.stringify(showDemoData));
  }, [showDemoData]);

  const setShowDemoData = useCallback((value) => {
    setShowDemoDataState(value);
  }, []);

  const toggleDemoData = useCallback(() => {
    setShowDemoDataState(prev => !prev);
  }, []);

  return (
    <DemoDataContext.Provider value={{ showDemoData, setShowDemoData, toggleDemoData }}>
      {children}
    </DemoDataContext.Provider>
  );
}

/**
 * Hook to access demo data setting.
 * Returns { showDemoData, setShowDemoData, toggleDemoData }
 */
export function useDemoData() {
  const context = useContext(DemoDataContext);
  if (!context) {
    throw new Error('useDemoData must be used within a DemoDataProvider');
  }
  return context;
}

export default useDemoData;
