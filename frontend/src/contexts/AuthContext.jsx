import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { watchForSessionLoss } from '../lib/sessionWatch';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setIsAuthenticated(true);
        return data.user;
      }
    } catch {
      // Not authenticated
    }
    setIsAuthenticated(false);
    setUser(null);
    return null;
  }, []);

  // Restore session from cookie on mount
  useEffect(() => {
    checkAuth().finally(() => setIsLoading(false));
  }, [checkAuth]);

  // A session can end while the panel is open (it lasts 24 hours). When an API
  // call is refused, ask the server; if the session really is gone the app
  // falls back to the sign-in screen, which signs in silently inside Zoom.
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  useEffect(() => watchForSessionLoss(() => {
    if (isAuthenticatedRef.current) checkAuth();
  }), [checkAuth]);

  // The session itself is an httpOnly cookie; JavaScript only keeps who is signed in.
  const login = useCallback((userData) => {
    setUser(userData);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const contextValue = useMemo(() => ({
    isAuthenticated, user, isLoading, checkAuth, login, logout,
  }), [isAuthenticated, user, isLoading, checkAuth, login, logout]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
