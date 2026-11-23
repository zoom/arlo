import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Search, Settings } from 'lucide-react';
import { useServerSettings } from '../contexts/ServerSettingsContext';
import ArloLogo from './ArloLogo';
import Button from './ui/Button';
import LiveMeetingBanner from './LiveMeetingBanner';
import './AppShell.css';

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showSearch } = useServerSettings();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const searchRef = useRef(null);
  const searchAbortRef = useRef(null);

  // Show back arrow on sub-pages (not /home)
  const showBack = location.pathname !== '/home' && location.pathname !== '/';

  // The logo goes home. The vertical is changed in Settings, nowhere else.
  const handleLogoClick = useCallback(() => {
    navigate('/home');
  }, [navigate]);

  // Close search on outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchResults([]);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
      searchAbortRef.current = new AbortController();

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&limit=5`, {
          credentials: 'include',
          signal: searchAbortRef.current.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setSearchResults((data.results || []).slice(0, 5));
        }
      } catch (err) {
        if (err.name === 'AbortError') return; // Ignore aborted requests
        // Search failed silently
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleBack = useCallback(() => {
    // From the meeting record or the classic dashboard, back is the meeting screen
    const subPage = location.pathname.match(/^(\/meeting\/[^/]+)\/(record|classic)$/);
    if (subPage) {
      navigate(subPage[1]);
      return;
    }
    // From the meeting view, back goes home (history may be empty inside Zoom)
    if (location.pathname === '/meeting' || location.pathname.startsWith('/meeting/')) {
      navigate('/home');
      return;
    }
    // Otherwise use browser history
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/home');
    }
  }, [navigate, location.pathname]);

  const handleResultClick = (result) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    navigate(`/meetings/${result.meetingId}`);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          {showBack ? (
            <Button variant="ghost" size="icon" onClick={handleBack} aria-label="Back">
              <ArrowLeft size={16} />
            </Button>
          ) : (
            <button
              className="header-brand"
              onClick={handleLogoClick}
              title="Switch experience"
            >
              <ArloLogo size={20} />
            </button>
          )}
        </div>

        <div className="header-right" ref={searchRef}>
          {showSearch && searchOpen && (
            <div className="search-container">
              <input
                type="text"
                className="input search-input"
                placeholder="Search meetings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchQuery.trim()) {
                    setSearchOpen(false);
                    setSearchResults([]);
                    navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
                    setSearchQuery('');
                  }
                }}
                autoFocus
              />
              {searchResults.length > 0 && (
                <div className="search-dropdown card">
                  {searchResults.map((result, i) => (
                    <button
                      key={i}
                      className="search-result"
                      onClick={() => handleResultClick(result)}
                    >
                      <span className="search-result-title text-serif">
                        {result.meetingTitle}
                        {result.type === 'title' && <span className="search-type-badge">Title</span>}
                        {result.type === 'summary' && <span className="search-type-badge">Summary</span>}
                      </span>
                      <span className="search-result-snippet text-muted text-xs">
                        {result.snippet || (result.type === 'title' ? `${result.segmentCount} segments` : '')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Search needs stored meetings: without them it only leads to an empty page */}
          {showSearch && (
            <Button variant="ghost" size="icon" aria-label="Search" onClick={() => setSearchOpen(!searchOpen)}>
              <Search size={16} />
            </Button>
          )}

          <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => navigate('/settings')}>
            <Settings size={16} />
          </Button>
        </div>
      </header>

      <LiveMeetingBanner />

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
