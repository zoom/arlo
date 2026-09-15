import { useState, useEffect } from 'react';

/**
 * Hook to access the "Show AI Prompts" setting.
 * Returns { showAIPrompts, setShowAIPrompts }
 */
export function useShowAIPrompts() {
  const [showAIPrompts, setShowAIPrompts] = useState(() => {
    try {
      const cached = localStorage.getItem('arlo-show-ai-prompts');
      return cached !== null ? JSON.parse(cached) : false;
    } catch {
      return false;
    }
  });

  // Listen for storage changes (cross-tab sync)
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'arlo-show-ai-prompts') {
        try {
          setShowAIPrompts(JSON.parse(e.newValue));
        } catch {
          setShowAIPrompts(false);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Also listen for custom events (same-tab sync)
  useEffect(() => {
    const handleCustomEvent = () => {
      try {
        const cached = localStorage.getItem('arlo-show-ai-prompts');
        setShowAIPrompts(cached !== null ? JSON.parse(cached) : false);
      } catch {
        setShowAIPrompts(false);
      }
    };

    window.addEventListener('arlo-settings-changed', handleCustomEvent);
    return () => window.removeEventListener('arlo-settings-changed', handleCustomEvent);
  }, []);

  return { showAIPrompts, setShowAIPrompts };
}

export default useShowAIPrompts;
