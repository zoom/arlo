import React from 'react';

/**
 * Arlo owl icon with fixed colors for consistent branding.
 * Face is always dark (#0a0a0a), eyes/beak are always white.
 * Identical appearance in light and dark modes.
 */
export default function OwlIcon({ size = 24, className = '' }) {
  const faceColor = '#0a0a0a';
  const detailColor = '#fafafa';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Owl face */}
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      {/* Eye whites */}
      <circle cx="9.5" cy="11" r="3.2" fill={detailColor} />
      <circle cx="14.5" cy="11" r="3.2" fill={detailColor} />
      {/* Pupils */}
      <circle cx="9.5" cy="11" r="1.25" fill={faceColor} />
      <circle cx="14.5" cy="11" r="1.25" fill={faceColor} />
      {/* Eye highlights */}
      <circle cx="10.1" cy="10.35" r="0.45" fill={detailColor} />
      <circle cx="15.1" cy="10.35" r="0.45" fill={detailColor} />
      {/* Beak */}
      <path d="M 10.5 15 L 12 17 L 13.5 15 Z" fill={detailColor} />
    </svg>
  );
}
