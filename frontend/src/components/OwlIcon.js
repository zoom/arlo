import React from 'react';

/**
 * Arlo owl icon with fixed colors for consistent branding.
 * Face is always black (#0B0B0C), eyes/mouth are always white.
 * Identical appearance in light and dark modes.
 */
export default function OwlIcon({ size = 24, className = '' }) {
  const faceColor = '#0B0B0C';
  const detailColor = '#FFFFFF';

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
      <circle cx="9" cy="11" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11" r="2.5" fill={detailColor} />
      {/* Pupils */}
      <circle cx="9" cy="11" r="1" fill={faceColor} />
      <circle cx="15" cy="11" r="1" fill={faceColor} />
      {/* Smile */}
      <path
        d="M 10 15 Q 12 16 14 15"
        stroke={detailColor}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
      {/* Ear tufts */}
      <path d="M 4 8 L 6 10 L 5 11 Z" fill={faceColor} />
      <path d="M 20 8 L 18 10 L 19 11 Z" fill={faceColor} />
    </svg>
  );
}
