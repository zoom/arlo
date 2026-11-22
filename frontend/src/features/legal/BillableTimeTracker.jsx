import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Clock, Play, Pause, Square, Plus, Download, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import './BillableTimeTracker.css';

/**
 * BillableTimeTracker — Auto-log billable segments during depositions and calls.
 */

// Demo activity codes for legal billing
const ACTIVITY_CODES = [
  { code: 'DEP', label: 'Deposition', rate: 450 },
  { code: 'INT', label: 'Client Interview', rate: 350 },
  { code: 'WIT', label: 'Witness Prep', rate: 400 },
  { code: 'DOC', label: 'Document Review', rate: 300 },
  { code: 'RES', label: 'Legal Research', rate: 325 },
  { code: 'TRV', label: 'Travel Time', rate: 200 },
  { code: 'ADM', label: 'Administrative', rate: 0 },
];

// Demo billable entries with realistic non-round durations
const DEMO_ENTRIES = [
  {
    id: 1,
    activityCode: 'DEP',
    description: 'Deposition of Patricia Johnson (HR Director)',
    startTime: Date.now() - 5832000, // 1h 37m 12s ago
    endTime: null,
    matter: 'Thompson v. Nexus Technologies',
    matterNumber: '2025-0342',
    notes: 'Direct examination regarding termination decision',
    status: 'active',
    accumulatedMs: 0,
  },
  {
    id: 2,
    activityCode: 'DOC',
    description: 'Review exhibits prior to deposition',
    startTime: Date.now() - 10800000,
    endTime: Date.now() - 6480000,
    matter: 'Thompson v. Nexus Technologies',
    matterNumber: '2025-0342',
    notes: 'Exhibits A-F, personnel file, email correspondence',
    status: 'completed',
    accumulatedMs: 0,
  },
  {
    id: 3,
    activityCode: 'WIT',
    description: 'Prepare client for cross-examination',
    startTime: Date.now() - 86400000 - 7200000,
    endTime: Date.now() - 86400000,
    matter: 'Thompson v. Nexus Technologies',
    matterNumber: '2025-0342',
    notes: 'Reviewed potential impeachment areas',
    status: 'completed',
    accumulatedMs: 0,
  },
  {
    id: 4,
    activityCode: 'RES',
    description: 'Research disparate treatment precedents',
    startTime: Date.now() - 172800000,
    endTime: Date.now() - 172800000 + 2700000,
    matter: 'Thompson v. Nexus Technologies',
    matterNumber: '2025-0342',
    notes: '',
    status: 'completed',
    accumulatedMs: 0,
  },
];

// Format duration in h:mm:ss
function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Format hours for billing (e.g., "1.62 hrs")
function formatBillableHours(ms) {
  if (!ms || ms < 0) return '0.00';
  const hours = ms / 3600000;
  return hours.toFixed(2);
}

// Format time (12-hour)
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// Format date
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function BillableTimeTracker({ meetingId, meetingStartTime, showDemoData = true }) {
  const [entries, setEntries] = useState(showDemoData ? DEMO_ENTRIES : []);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isAddingEntry, setIsAddingEntry] = useState(false);
  const [newEntry, setNewEntry] = useState({
    activityCode: 'DEP',
    description: '',
    matter: 'Thompson v. Nexus Technologies',
    matterNumber: '2025-0342',
    notes: '',
  });

  // Force re-render every second for running timers
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Find active entry
  const activeEntry = useMemo(() => entries.find(e => e.status === 'active'), [entries]);

  // Find paused entries
  const pausedEntries = useMemo(() => entries.filter(e => e.status === 'paused'), [entries]);

  // Get entry duration (handles paused and active states)
  const getEntryDuration = useCallback((entry) => {
    if (!entry) return 0;
    if (entry.finalDuration) return entry.finalDuration;
    if (entry.status === 'paused') return entry.accumulatedMs || 0;
    if (entry.status === 'active') return (entry.accumulatedMs || 0) + (Date.now() - entry.startTime);
    if (entry.endTime) return entry.endTime - entry.startTime;
    return 0;
  }, []);

  // Calculate totals
  const totals = useMemo(() => {
    let totalMs = 0;
    let totalBillable = 0;

    entries.forEach(entry => {
      const duration = getEntryDuration(entry);
      totalMs += duration;
      const hours = duration / 3600000;
      const activity = ACTIVITY_CODES.find(a => a.code === entry.activityCode);
      totalBillable += hours * (activity?.rate || 0);
    });

    return { totalMs, totalBillable };
  }, [entries, getEntryDuration]);

  // Start new entry
  const startEntry = useCallback(() => {
    const entry = {
      id: Date.now(),
      ...newEntry,
      startTime: Date.now(),
      endTime: null,
      status: 'active',
      accumulatedMs: 0,
    };
    // Pause any currently active entry
    setEntries(prev => [
      entry,
      ...prev.map(e => e.status === 'active'
        ? { ...e, status: 'paused', accumulatedMs: (e.accumulatedMs || 0) + (Date.now() - e.startTime) }
        : e
      )
    ]);
    setIsAddingEntry(false);
    setNewEntry({
      activityCode: 'DEP',
      description: '',
      matter: 'Thompson v. Nexus Technologies',
      matterNumber: '2025-0342',
      notes: '',
    });
  }, [newEntry]);

  // Pause entry (keeps accumulated time)
  const pauseEntry = useCallback((id) => {
    setEntries(prev => prev.map(entry =>
      entry.id === id
        ? { ...entry, status: 'paused', accumulatedMs: (entry.accumulatedMs || 0) + (Date.now() - entry.startTime) }
        : entry
    ));
  }, []);

  // Resume entry
  const resumeEntry = useCallback((id) => {
    setEntries(prev => prev.map(entry => {
      if (entry.id === id) {
        return { ...entry, status: 'active', startTime: Date.now() };
      }
      // Pause any other active entry
      if (entry.status === 'active') {
        return { ...entry, status: 'paused', accumulatedMs: (entry.accumulatedMs || 0) + (Date.now() - entry.startTime) };
      }
      return entry;
    }));
  }, []);

  // Stop entry (finalize)
  const stopEntry = useCallback((id) => {
    setEntries(prev => prev.map(entry =>
      entry.id === id
        ? {
            ...entry,
            status: 'completed',
            endTime: Date.now(),
            finalDuration: (entry.accumulatedMs || 0) + (entry.status === 'active' ? Date.now() - entry.startTime : 0),
            justRecorded: true, // Flag for visual feedback
          }
        : entry
    ));
    // Clear "just recorded" flag after 5 seconds
    setTimeout(() => {
      setEntries(prev => prev.map(entry =>
        entry.id === id ? { ...entry, justRecorded: false } : entry
      ));
    }, 5000);
  }, []);

  // Delete entry
  const deleteEntry = useCallback((id) => {
    setEntries(prev => prev.filter(entry => entry.id !== id));
  }, []);

  // Export to CSV
  const exportToCSV = useCallback(() => {
    const headers = ['Date', 'Code', 'Description', 'Matter #', 'Matter', 'Start', 'End', 'Hours', 'Rate', 'Amount', 'Notes'];
    const rows = entries.map(entry => {
      const duration = getEntryDuration(entry);
      const hours = (duration / 3600000).toFixed(2);
      const activity = ACTIVITY_CODES.find(a => a.code === entry.activityCode);
      const amount = (hours * (activity?.rate || 0)).toFixed(2);

      return [
        new Date(entry.startTime).toLocaleDateString(),
        entry.activityCode,
        `"${entry.description}"`,
        entry.matterNumber,
        `"${entry.matter}"`,
        formatTime(entry.startTime),
        entry.endTime ? formatTime(entry.endTime) : 'In Progress',
        hours,
        activity?.rate || 0,
        amount,
        `"${entry.notes || ''}"`,
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `billable-time-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [entries, getEntryDuration]);

  const completedEntries = entries.filter(e => e.status === 'completed');

  return (
    <div className="billable-tracker">
      {/* Collapsible Header */}
      <button
        className="billable-tracker-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="billable-tracker-title">
          <Clock size={18} className="billable-tracker-icon" />
          <h3 className="text-serif font-medium">Billable Time</h3>
          {activeEntry && (
            <span className="billable-tracker-live">
              <span className="billable-live-dot" />
              {formatDuration(getEntryDuration(activeEntry))}
            </span>
          )}
        </div>
        <div className="billable-tracker-meta">
          <span className="billable-tracker-totals">
            {formatBillableHours(totals.totalMs)} hrs · ${totals.totalBillable.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </span>
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      {isExpanded && (
        <div className="billable-tracker-content">
          {/* Actions Bar */}
          <div className="billable-tracker-actions">
            <button
              className="billable-action-btn"
              onClick={exportToCSV}
              title="Export to CSV"
            >
              <Download size={14} />
              Export CSV
            </button>
            {!isAddingEntry && !activeEntry && (
              <button
                className="billable-action-btn add"
                onClick={() => setIsAddingEntry(true)}
              >
                <Plus size={14} />
                Start Timer
              </button>
            )}
          </div>

          {/* Active Entry Banner */}
          {activeEntry && (
            <div className="billable-active-banner">
              <div className="billable-active-left">
                <span className="billable-active-dot" />
                <span className="billable-active-code">{activeEntry.activityCode}</span>
                <span className="billable-active-desc">
                  {activeEntry.description || ACTIVITY_CODES.find(a => a.code === activeEntry.activityCode)?.label}
                </span>
              </div>
              <div className="billable-active-right">
                <span className="billable-active-duration">{formatDuration(getEntryDuration(activeEntry))}</span>
                <button
                  className="billable-control-btn pause"
                  onClick={() => pauseEntry(activeEntry.id)}
                  title="Pause"
                >
                  <Pause size={14} />
                </button>
                <button
                  className="billable-control-btn stop"
                  onClick={() => stopEntry(activeEntry.id)}
                  title="Stop"
                >
                  <Square size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Paused Entry Banners */}
          {pausedEntries.map(entry => (
            <div key={entry.id} className="billable-paused-banner">
              <div className="billable-active-left">
                <span className="billable-paused-indicator">PAUSED</span>
                <span className="billable-active-code">{entry.activityCode}</span>
                <span className="billable-active-desc">
                  {entry.description || ACTIVITY_CODES.find(a => a.code === entry.activityCode)?.label}
                </span>
              </div>
              <div className="billable-active-right">
                <span className="billable-paused-duration">{formatDuration(getEntryDuration(entry))}</span>
                <button
                  className="billable-control-btn resume"
                  onClick={() => resumeEntry(entry.id)}
                  title="Resume"
                >
                  <Play size={14} />
                </button>
                <button
                  className="billable-control-btn stop"
                  onClick={() => stopEntry(entry.id)}
                  title="Stop"
                >
                  <Square size={14} />
                </button>
              </div>
            </div>
          ))}

          {/* Add New Entry Form */}
          {isAddingEntry && (
            <div className="billable-new-entry">
              <div className="billable-form-row">
                <label className="billable-form-label">Activity</label>
                <select
                  value={newEntry.activityCode}
                  onChange={(e) => setNewEntry(prev => ({ ...prev, activityCode: e.target.value }))}
                  className="billable-form-select"
                >
                  {ACTIVITY_CODES.map(activity => (
                    <option key={activity.code} value={activity.code}>
                      {activity.code} - {activity.label} (${activity.rate}/hr)
                    </option>
                  ))}
                </select>
              </div>

              <div className="billable-form-row">
                <label className="billable-form-label">Description</label>
                <input
                  type="text"
                  value={newEntry.description}
                  onChange={(e) => setNewEntry(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of activity"
                  className="billable-form-input"
                />
              </div>

              <div className="billable-form-actions">
                <button
                  className="billable-form-cancel"
                  onClick={() => setIsAddingEntry(false)}
                >
                  Cancel
                </button>
                <button
                  className="billable-form-start"
                  onClick={startEntry}
                >
                  <Play size={14} />
                  Start Timer
                </button>
              </div>
            </div>
          )}

          {/* Entry List */}
          <div className="billable-entries">
            <div className="billable-entries-header">
              <span className="billable-entries-label">Time Entries</span>
              <span className="billable-entries-count">{completedEntries.length}</span>
            </div>

            {completedEntries.map(entry => {
              const activity = ACTIVITY_CODES.find(a => a.code === entry.activityCode);
              const duration = getEntryDuration(entry);
              const hours = duration / 3600000;
              const amount = hours * (activity?.rate || 0);

              return (
                <div key={entry.id} className={`billable-entry ${entry.justRecorded ? 'just-recorded' : ''}`}>
                  {entry.justRecorded && (
                    <div className="billable-recorded-badge">
                      <span className="billable-recorded-dot" />
                      Recorded
                    </div>
                  )}
                  <div className="billable-entry-row">
                    <div className="billable-entry-left">
                      <span className="billable-entry-code">{entry.activityCode}</span>
                      <span className="billable-entry-desc">{entry.description || activity?.label}</span>
                    </div>
                    <div className="billable-entry-right">
                      <span className="billable-entry-duration">{formatBillableHours(duration)} hrs</span>
                      {activity?.rate > 0 && (
                        <span className="billable-entry-amount">${amount.toFixed(0)}</span>
                      )}
                      <button
                        className="billable-entry-delete"
                        onClick={() => deleteEntry(entry.id)}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="billable-entry-meta">
                    <span>{formatDate(entry.startTime)}</span>
                    <span>{formatTime(entry.startTime)} – {entry.endTime ? formatTime(entry.endTime) : 'In Progress'}</span>
                    <span>{entry.matterNumber}</span>
                  </div>
                </div>
              );
            })}

            {completedEntries.length === 0 && (
              <p className="billable-empty">
                No completed entries yet. Start a timer to track billable time.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
