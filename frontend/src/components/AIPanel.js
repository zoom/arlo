import React, { useState } from 'react';
import { Tabs } from '@base-ui/react';
import './AIPanel.css';

function AIPanel({ meetingId }) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [actionItems, setActionItems] = useState(null);
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatAnswer, setChatAnswer] = useState(null);
  const [error, setError] = useState(null);

  const generateSummary = async () => {
    if (!meetingId) {
      setError('No meeting ID available');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to generate summary');
      }

      const data = await response.json();
      setSummary(data.summary);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const extractActionItems = async () => {
    if (!meetingId) {
      setError('No meeting ID available');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ai/action-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to extract action items');
      }

      const data = await response.json();
      setActionItems(data.actionItems);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const askQuestion = async (e) => {
    e.preventDefault();
    if (!chatQuestion.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meetingId, question: chatQuestion }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to get answer');
      }

      const data = await response.json();
      setChatAnswer(data.answer);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const clearError = () => setError(null);

  return (
    <div className="ai-panel">
      <Tabs.Root defaultValue="summary" onValueChange={clearError}>
        <Tabs.List className="ai-tabs">
          <Tabs.Tab value="summary" className="ai-tab">Summary</Tabs.Tab>
          <Tabs.Tab value="actions" className="ai-tab">Action Items</Tabs.Tab>
          <Tabs.Tab value="chat" className="ai-tab">Ask AI</Tabs.Tab>
        </Tabs.List>

        <div className="ai-content">
          {error && (
            <div className="ai-error">
              <span className="error-icon">⚠️</span>
              <span className="error-message">{error}</span>
              <button className="error-dismiss" onClick={clearError}>×</button>
            </div>
          )}

          <Tabs.Panel value="summary" className="ai-section">
            {loading && !summary ? (
              <div className="ai-loading">
                <div className="loading-spinner"></div>
                <span>Analyzing transcript and generating summary...</span>
              </div>
            ) : !summary ? (
              <button
                className="ai-generate-btn"
                onClick={generateSummary}
                disabled={loading}
              >
                Generate Summary
              </button>
            ) : (
              <div className="summary-content">
                <h4>Overview</h4>
                <p>{summary.overview}</p>

                {summary.keyPoints?.length > 0 && (
                  <>
                    <h4>Key Points</h4>
                    <ul>
                      {summary.keyPoints.map((point, i) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  </>
                )}

                {summary.decisions?.length > 0 && (
                  <>
                    <h4>Decisions</h4>
                    <ul>
                      {summary.decisions.map((decision, i) => (
                        <li key={i}>{decision}</li>
                      ))}
                    </ul>
                  </>
                )}

                {summary.nextSteps?.length > 0 && (
                  <>
                    <h4>Next Steps</h4>
                    <ul>
                      {summary.nextSteps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </>
                )}

                <button
                  className="ai-refresh-btn"
                  onClick={generateSummary}
                  disabled={loading}
                >
                  {loading ? 'Regenerating...' : 'Regenerate'}
                </button>
              </div>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="actions" className="ai-section">
            {loading && !actionItems ? (
              <div className="ai-loading">
                <div className="loading-spinner"></div>
                <span>Analyzing transcript for action items...</span>
              </div>
            ) : !actionItems ? (
              <button
                className="ai-generate-btn"
                onClick={extractActionItems}
                disabled={loading}
              >
                Extract Action Items
              </button>
            ) : (
              <div className="actions-content">
                {actionItems.length === 0 ? (
                  <p className="no-items">No action items found</p>
                ) : (
                  <ul className="action-items-list">
                    {actionItems.map((item, i) => (
                      <li key={i} className={`action-item priority-${item.priority}`}>
                        <span className="task">{item.task}</span>
                        {item.owner && item.owner !== 'null' && (
                          <span className="owner">Assigned to: {item.owner}</span>
                        )}
                        <span className={`priority ${item.priority}`}>
                          {item.priority}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  className="ai-refresh-btn"
                  onClick={extractActionItems}
                  disabled={loading}
                >
                  {loading ? 'Re-extracting...' : 'Re-extract'}
                </button>
              </div>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="chat" className="ai-section chat-section">
            <form onSubmit={askQuestion} className="chat-form">
              <input
                type="text"
                value={chatQuestion}
                onChange={(e) => setChatQuestion(e.target.value)}
                placeholder="Ask a question about this meeting..."
                disabled={loading}
              />
              <button type="submit" disabled={loading || !chatQuestion.trim()}>
                {loading ? (
                  <span className="button-spinner"></span>
                ) : (
                  'Ask'
                )}
              </button>
            </form>

            {loading && !chatAnswer && (
              <div className="ai-loading chat-loading">
                <div className="loading-spinner"></div>
                <span>Thinking...</span>
              </div>
            )}

            {chatAnswer && (
              <div className="chat-answer">
                <h4>Answer</h4>
                <p>{chatAnswer}</p>
              </div>
            )}
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </div>
  );
}

export default AIPanel;
