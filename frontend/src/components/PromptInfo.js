import React, { useState, useEffect, useRef } from 'react';
import { Info, X, Copy, Check } from 'lucide-react';
import { useShowAIPrompts } from '../hooks/useShowAIPrompts';
import './PromptInfo.css';

/**
 * PromptInfo - Shows an info icon that reveals the AI prompt powering a feature.
 *
 * @param {string} promptId - The ID of the prompt (e.g., 'summary', 'sentiment', 'soapNotes')
 * @param {string} className - Optional additional CSS class
 * @param {string} size - Icon size (default: 14)
 */
export default function PromptInfo({ promptId, className = '', size = 14 }) {
  const { showAIPrompts } = useShowAIPrompts();
  const [isOpen, setIsOpen] = useState(false);
  const [promptData, setPromptData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  // Fetch prompt data when opened
  useEffect(() => {
    if (!showAIPrompts) return;
    if (isOpen && !promptData && !loading) {
      setLoading(true);
      fetch(`/api/ai/prompts/${promptId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          setPromptData(data);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    }
  }, [isOpen, promptId, promptData, loading, showAIPrompts]);

  // Close on click outside
  useEffect(() => {
    if (!showAIPrompts || !isOpen) return;

    const handleClickOutside = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, showAIPrompts]);

  // Close on Escape key
  useEffect(() => {
    if (!showAIPrompts || !isOpen) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, showAIPrompts]);

  // Calculate panel position when opened
  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const panelWidth = 400;
    const panelHeight = 400;
    const padding = 16;

    // Position below the trigger, aligned to the right edge
    let top = rect.bottom + 8;
    let left = rect.right - panelWidth;

    // Keep panel within viewport
    if (left < padding) {
      left = padding;
    }
    if (left + panelWidth > window.innerWidth - padding) {
      left = window.innerWidth - panelWidth - padding;
    }
    if (top + panelHeight > window.innerHeight - padding) {
      // Position above if not enough space below
      top = rect.top - panelHeight - 8;
      if (top < padding) {
        top = padding;
      }
    }

    setPanelPosition({ top, left });
  }, [isOpen]);

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Don't render anything if the setting is disabled
  if (!showAIPrompts) {
    return null;
  }

  return (
    <div className={`prompt-info ${className}`}>
      <button
        ref={triggerRef}
        className="prompt-info-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="View AI prompt"
        aria-label="View AI prompt"
      >
        <Info size={size} />
      </button>

      {isOpen && (
        <div
          className="prompt-info-panel"
          ref={panelRef}
          style={{ top: panelPosition.top, left: panelPosition.left }}
        >
          <div className="prompt-info-header">
            <h4 className="text-sans font-medium">
              {promptData?.name || 'AI Prompt'}
            </h4>
            <button
              className="prompt-info-close"
              onClick={() => setIsOpen(false)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {loading && (
            <div className="prompt-info-loading">
              <span className="text-sans text-sm text-muted">Loading...</span>
            </div>
          )}

          {promptData && !loading && (
            <div className="prompt-info-content">
              <p className="text-sans text-sm text-muted prompt-info-description">
                {promptData.description}
              </p>

              <div className="prompt-info-section">
                <div className="prompt-info-section-header">
                  <span className="text-sans text-xs font-medium">System Prompt</span>
                  <button
                    className="prompt-info-copy"
                    onClick={() => handleCopy(promptData.systemPrompt)}
                    title="Copy to clipboard"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <pre className="prompt-info-code">
                  {promptData.systemPrompt}
                </pre>
              </div>

              <div className="prompt-info-section">
                <span className="text-sans text-xs font-medium">User Prompt Template</span>
                <pre className="prompt-info-code prompt-info-code-small">
                  {promptData.userPromptTemplate}
                </pre>
              </div>

              <div className="prompt-info-meta">
                <span className="text-sans text-xs text-muted">
                  Feature: {promptData.feature}
                </span>
                <span className="text-sans text-xs text-muted">
                  Output: {promptData.outputFormat}
                </span>
              </div>
            </div>
          )}

          {!promptData && !loading && (
            <div className="prompt-info-error">
              <span className="text-sans text-sm text-muted">
                Could not load prompt information.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
