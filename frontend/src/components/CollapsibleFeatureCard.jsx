import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useFeatureLayout } from '../hooks/useFeatureLayout';
import './CollapsibleFeatureCard.css';

/**
 * CollapsibleFeatureCard - Wrapper that adds collapse/expand to any feature card
 *
 * Props:
 * - featureId: Unique identifier (used for persisting collapse state)
 * - title: Title shown in the header
 * - icon: Icon component
 * - badge: Optional badge element (count, live indicator, etc.)
 * - accentColor: Color for the header icon
 * - children: The full feature content
 * - className: Additional classes
 */
export default function CollapsibleFeatureCard({
  featureId,
  title,
  icon: Icon,
  badge,
  accentColor,
  children,
  className = '',
}) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed(featureId);

  return (
    <div
      className={`collapsible-feature-card ${collapsed ? 'collapsed' : 'expanded'} ${className}`}
      style={{ '--feature-accent': accentColor }}
    >
      <button
        className="collapsible-feature-header"
        onClick={() => toggleCollapsed(featureId)}
        aria-expanded={!collapsed}
      >
        <div className="collapsible-feature-header-left">
          {Icon && (
            <div className="collapsible-feature-icon">
              <Icon size={16} />
            </div>
          )}
          <span className="collapsible-feature-title text-serif font-medium">{title}</span>
          {badge}
        </div>
        <div className="collapsible-feature-header-right">
          {collapsed ? (
            <ChevronDown size={16} className="collapsible-feature-chevron" />
          ) : (
            <ChevronUp size={16} className="collapsible-feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && (
        <div className="collapsible-feature-content">
          {children}
        </div>
      )}
    </div>
  );
}
