import { useEffect, useState } from 'react';

const secondsUntil = (expiresAt) => (
  expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : null
);

/** Whole seconds until `expiresAt` (ms epoch), updated every second. null when there is no deadline. */
export default function useSecondsLeft(expiresAt) {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(expiresAt));

  useEffect(() => {
    setSecondsLeft(secondsUntil(expiresAt));
    if (!expiresAt) return undefined;
    const interval = setInterval(() => setSecondsLeft(secondsUntil(expiresAt)), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return secondsLeft;
}
