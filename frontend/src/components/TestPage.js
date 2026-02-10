import React, { useState, useEffect } from 'react';
import { Tooltip, AlertDialog } from '@base-ui/react';
import AIPanel from './AIPanel';
import HighlightsPanel from './HighlightsPanel';
import './TestPage.css';

function TestPage() {
  const [meetings, setMeetings] = useState([]);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    fetchMeetings();
  }, []);

  const fetchMeetings = async () => {
    try {
      const response = await fetch('/api/meetings');
      const data = await response.json();
      setMeetings(data.meetings || []);
      if (data.meetings?.length > 0) {
        setSelectedMeeting(data.meetings[0]);
      }
    } catch (error) {
      console.error('Failed to fetch meetings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await response.json();
      setSearchResults(data);
    } catch (error) {
      console.error('Search failed:', error);
    }
  };

  const handleRename = async () => {
    if (!newTitle.trim() || !selectedMeeting) return;

    try {
      const response = await fetch(`/api/meetings/${selectedMeeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });

      if (response.ok) {
        const data = await response.json();
        // Update meeting in list
        setMeetings(meetings.map(m =>
          m.id === selectedMeeting.id ? { ...m, title: data.meeting.title } : m
        ));
        setSelectedMeeting({ ...selectedMeeting, title: data.meeting.title });
        setEditingTitle(false);
      }
    } catch (error) {
      console.error('Failed to rename meeting:', error);
    }
  };

  const handleExportVTT = () => {
    if (!selectedMeeting) return;
    window.open(`/api/meetings/${selectedMeeting.id}/vtt`, '_blank');
  };

  const handleDelete = async () => {
    if (!selectedMeeting) return;

    try {
      const response = await fetch(`/api/meetings/${selectedMeeting.id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        const updatedMeetings = meetings.filter(m => m.id !== selectedMeeting.id);
        setMeetings(updatedMeetings);
        setSelectedMeeting(updatedMeetings[0] || null);
      }
    } catch (error) {
      console.error('Failed to delete meeting:', error);
    }
  };

  if (loading) {
    return (
      <div className="test-page">
        <div className="loading">Loading meetings...</div>
      </div>
    );
  }

  return (
    <div className="test-page">
      <header className="test-header">
        <h1>Arlo AI Features Test</h1>
        <p>Test AI features without being in a Zoom meeting</p>
      </header>

      <div className="test-content">
        <div className="meetings-section">
          <h2>Select a Meeting</h2>
          {meetings.length === 0 ? (
            <p className="no-meetings">No meetings found. Start a Zoom meeting with Arlo to create transcript data.</p>
          ) : (
            <ul className="meetings-list">
              {meetings.map((meeting) => (
                <li
                  key={meeting.id}
                  className={`meeting-item ${selectedMeeting?.id === meeting.id ? 'selected' : ''}`}
                  onClick={() => setSelectedMeeting(meeting)}
                >
                  <div className="meeting-info">
                    <span className="meeting-title">{meeting.title}</span>
                    <span className="meeting-timestamp">
                      {new Date(meeting.startTime).toLocaleString()}
                    </span>
                  </div>
                  {meeting._count?.segments > 0 && (
                    <span className="meeting-transcript-status">
                      Has transcript
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="search-section">
          <h2>Search Transcripts</h2>
          <form onSubmit={handleSearch} className="search-form">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search across all meetings..."
            />
            <button type="submit">Search</button>
          </form>

          {searchResults && (
            <div className="search-results">
              <h3>Results for "{searchResults.query}" ({searchResults.total} found)</h3>
              {searchResults.results.length === 0 ? (
                <p>No results found</p>
              ) : (
                <ul>
                  {searchResults.results.map((result, i) => (
                    <li key={i} className="search-result">
                      <div className="result-meeting">{result.meetingTitle}</div>
                      <div className="result-speaker">{result.speaker || 'Unknown'}</div>
                      <div className="result-snippet">{result.snippet}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {selectedMeeting && (
          <div className="ai-section">
            <div className="meeting-header">
              {editingTitle ? (
                <div className="rename-form">
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Enter new title..."
                    autoFocus
                  />
                  <button onClick={handleRename}>Save</button>
                  <button onClick={() => setEditingTitle(false)} className="cancel-btn">Cancel</button>
                </div>
              ) : (
                <h2>
                  AI Features for: {selectedMeeting.title}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      render={
                        <button
                          className="edit-btn"
                          onClick={() => {
                            setNewTitle(selectedMeeting.title);
                            setEditingTitle(true);
                          }}
                        />
                      }
                    >
                      ✏️
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Positioner sideOffset={6}>
                        <Tooltip.Popup className="tooltip-popup">
                          Rename meeting
                        </Tooltip.Popup>
                      </Tooltip.Positioner>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </h2>
              )}
              <div className="meeting-actions">
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={<button onClick={handleExportVTT} className="export-btn" />}
                  >
                    Download VTT
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner sideOffset={6}>
                      <Tooltip.Popup className="tooltip-popup">
                        Download transcript as VTT
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
                <AlertDialog.Root>
                  <AlertDialog.Trigger className="delete-btn">
                    Delete
                  </AlertDialog.Trigger>
                  <AlertDialog.Portal>
                    <AlertDialog.Backdrop className="dialog-backdrop" />
                    <AlertDialog.Popup className="dialog-popup">
                      <AlertDialog.Title className="dialog-title">Delete Meeting</AlertDialog.Title>
                      <AlertDialog.Description className="dialog-description">
                        Delete &ldquo;{selectedMeeting.title}&rdquo;? This cannot be undone.
                      </AlertDialog.Description>
                      <div className="dialog-actions">
                        <AlertDialog.Close className="dialog-cancel-btn">Cancel</AlertDialog.Close>
                        <AlertDialog.Close
                          className="dialog-delete-btn"
                          onClick={handleDelete}
                        >
                          Delete
                        </AlertDialog.Close>
                      </div>
                    </AlertDialog.Popup>
                  </AlertDialog.Portal>
                </AlertDialog.Root>
              </div>
            </div>
            <AIPanel meetingId={selectedMeeting.id} />
            <HighlightsPanel meetingId={selectedMeeting.id} />
          </div>
        )}
      </div>
    </div>
  );
}

export default TestPage;
