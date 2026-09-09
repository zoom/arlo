import { useState, useEffect, useRef } from 'react';

/**
 * useComplianceSettings - Hook for managing compliance advisor settings
 *
 * Persists to localStorage and syncs across tabs.
 */
export function useComplianceSettings() {
  const [complianceEnabled, setComplianceEnabled] = useState(() => {
    const stored = localStorage.getItem('arlo-compliance-enabled');
    return stored !== null ? JSON.parse(stored) : true; // Enabled by default
  });

  const mountedRef = useRef(false);

  // Persist to localStorage
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    localStorage.setItem('arlo-compliance-enabled', JSON.stringify(complianceEnabled));
  }, [complianceEnabled]);

  // Sync across tabs
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'arlo-compliance-enabled' && e.newValue !== null) {
        setComplianceEnabled(JSON.parse(e.newValue));
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return {
    complianceEnabled,
    setComplianceEnabled,
  };
}

export default useComplianceSettings;
