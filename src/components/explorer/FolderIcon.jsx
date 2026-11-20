import { useId } from 'react';

export default function FolderIcon({ size = 32, className = '' }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 64 56" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x2="0" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#6cdbff" />
          <stop offset=".48" stopColor="#43c0fb" />
          <stop offset="1" stopColor="#2197e9" />
        </linearGradient>
      </defs>
      <path d="M4 13a5 5 0 0 1 5-5h14c2 0 3 .5 4.4 2l3 3.4c.9 1 2 1.6 3.6 1.6h20a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6Z" fill="#178cdb" />
      <path d="M6 16h17l3 3h31v8H6z" fill="#a5ecff" opacity=".8" />
      <rect x="4" y="20" width="56" height="31" rx="6" fill={`url(#${gradient})`} stroke="#248fd6" strokeOpacity=".55" />
      <path d="M10 21h44" stroke="white" strokeOpacity=".45" strokeLinecap="round" />
    </svg>
  );
}
