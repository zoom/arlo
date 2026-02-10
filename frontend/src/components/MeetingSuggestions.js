import React, { useState, useEffect, useCallback } from 'react';
import { Progress, Toggle, ToggleGroup, Tooltip } from '@base-ui/react';
import './MeetingSuggestions.css';

const DEFAULT_DURATION_MIN = 60;
const SUGGESTION_THRESHOLD = 0.80;

function MeetingSuggestions({ rtmsActive, meetingStartTime, meetingId, scheduledDuration }) {
  const [suggestions, setSuggestions] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [customDuration, setCustomDuration] = useState(null);
  const [showDurationPicker, setShowDurationPicker] = useState(false);

  const meetingDurationMs = (customDuration || scheduledDuration || DEFAULT_DURATION_MIN) * 60 * 1000;
  const suggestionTimeMs = meetingDurationMs * SUGGESTION_THRESHOLD;

  useEffect(() => {
    if (!meetingStartTime) {
      setElapsedTime(0);
      return;
    }

    const interval = setInterval(() => {
      const totalElapsed = Date.now() - meetingStartTime;
      setElapsedTime(totalElapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [meetingStartTime]);

  const progressPercent = Math.min((elapsedTime / meetingDurationMs) * 100, 100);

  const fetchSuggestions = useCallback(async () => {
    if (!meetingId || loading) return;

    setLoading(true);
    try {
      const response = await fetch('/api/ai/action-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId }),
      });

      if (response.ok) {
        const data = await response.json();
        const newSuggestions = [];

        const percentDone = Math.round((elapsedTime / meetingDurationMs) * 100);
        newSuggestions.push({
          type: 'time',
          text: `${percentDone}% of your scheduled meeting time has passed. Consider wrapping up soon!`,
          icon: '⏰',
        });

        if (data.actionItems && data.actionItems.length > 0) {
          newSuggestions.push({
            type: 'action-items',
            text: `${data.actionItems.length} action item(s) identified so far`,
            icon: '✅',
            items: data.actionItems.slice(0, 3),
          });
        }

        newSuggestions.push({
          type: 'review',
          text: 'Review key decisions before ending the meeting',
          icon: '📋',
        });

        setSuggestions(newSuggestions);
      }
    } catch (error) {
      console.error('Failed to fetch suggestions:', error);
      const percentDone = Math.round((elapsedTime / meetingDurationMs) * 100);
      setSuggestions([{
        type: 'time',
        text: `${percentDone}% of your scheduled meeting time has passed. Consider wrapping up!`,
        icon: '⏰',
      }]);
    } finally {
      setLoading(false);
    }
  }, [meetingId, loading, elapsedTime, meetingDurationMs]);

  useEffect(() => {
    if (
      rtmsActive &&
      elapsedTime >= suggestionTimeMs &&
      suggestions.length === 0 &&
      !dismissed &&
      !loading
    ) {
      fetchSuggestions();
    }
  }, [rtmsActive, elapsedTime, suggestionTimeMs, suggestions.length, dismissed, loading, fetchSuggestions]);

  useEffect(() => {
    if (!rtmsActive) {
      setSuggestions([]);
      setDismissed(false);
    }
  }, [rtmsActive]);

  const handleDismiss = () => {
    setDismissed(true);
    setSuggestions([]);
  };

  const formatTime = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const currentDuration = customDuration || scheduledDuration || DEFAULT_DURATION_MIN;

  const handleDurationChange = (newDuration) => {
    setCustomDuration(newDuration);
    setShowDurationPicker(false);
    if (elapsedTime < newDuration * 60 * 1000 * SUGGESTION_THRESHOLD) {
      setSuggestions([]);
      setDismissed(false);
    }
  };

  if (!meetingStartTime) return null;

  return (
    <div className="meeting-suggestions">
      {/* Timer display with progress */}
      <div className="meeting-timer">
        <div className="timer-info">
          <span className="timer-label">Meeting time:</span>
          <span className="timer-value">{formatTime(elapsedTime)}</span>
          <span className="timer-duration">
            / {currentDuration} min
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <button
                    className="duration-edit-btn"
                    onClick={() => setShowDurationPicker(!showDurationPicker)}
                  />
                }
              >
                ⚙️
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Positioner sideOffset={6}>
                  <Tooltip.Popup className="tooltip-popup">
                    Change meeting duration
                  </Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>
          </span>
        </div>
        <Progress.Root
          value={progressPercent}
          aria-label="Meeting progress"
          className="progress-bar"
        >
          <Progress.Track className="progress-track">
            <Progress.Indicator
              className={`progress-fill ${progressPercent >= 80 ? 'warning' : ''}`}
              style={{ width: `${progressPercent}%` }}
            />
          </Progress.Track>
        </Progress.Root>
      </div>

      {/* Duration picker */}
      {showDurationPicker && (
        <div className="duration-picker">
          <span className="picker-label">Set meeting duration:</span>
          <ToggleGroup
            value={[String(currentDuration)]}
            onValueChange={(vals) => {
              if (vals.length > 0) {
                handleDurationChange(Number(vals[0]));
              }
            }}
            className="duration-options"
          >
            {[15, 30, 45, 60, 90, 120].map((min) => (
              <Toggle
                key={min}
                value={String(min)}
                aria-label={`${min} minutes`}
                className="duration-option"
              >
                {min} min
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      )}

      {/* Suggestions panel */}
      {suggestions.length > 0 && !dismissed && (
        <div className="suggestions-panel">
          <div className="suggestions-header">
            <span className="suggestions-title">Suggestions</span>
            <button className="dismiss-btn" onClick={handleDismiss}>
              Dismiss
            </button>
          </div>
          <ul className="suggestions-list">
            {suggestions.map((suggestion, index) => (
              <li key={index} className={`suggestion-item suggestion-${suggestion.type}`}>
                <span className="suggestion-icon">{suggestion.icon}</span>
                <div className="suggestion-content">
                  <span className="suggestion-text">{suggestion.text}</span>
                  {suggestion.items && (
                    <ul className="suggestion-subitems">
                      {suggestion.items.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="suggestions-loading">
          <span className="loading-spinner"></span>
          <span>Generating suggestions...</span>
        </div>
      )}
    </div>
  );
}

export default MeetingSuggestions;
