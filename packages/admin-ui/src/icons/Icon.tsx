import type { CSSProperties, ReactNode } from 'react';

const I_STROKE = 1.5;

interface IconProps {
  size?: number;
  style?: CSSProperties;
}

interface IconBaseProps extends IconProps {
  children: ReactNode;
}

function IconBase({ size = 16, children, style }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={I_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'inline-block', flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

type Dir = 'up' | 'down' | 'left' | 'right';

interface DirIconProps extends IconProps {
  dir?: Dir;
}

const chevronRot: Record<Dir, number> = { down: 0, up: 180, left: 90, right: 270 };
const arrowRot: Record<Dir, number> = { right: 0, down: 90, left: 180, up: 270 };

export const Icon = {
  Search: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconBase>
  ),
  Plus: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  ),
  Check: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </IconBase>
  ),
  X: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M6 6l12 12M18 6L6 18" />
    </IconBase>
  ),
  Chevron: ({ size, dir = 'down', style }: DirIconProps) => (
    <IconBase size={size} style={{ transform: `rotate(${chevronRot[dir]}deg)`, ...style }}>
      <path d="M6 9l6 6 6-6" />
    </IconBase>
  ),
  Arrow: ({ size, dir = 'right', style }: DirIconProps) => (
    <IconBase size={size} style={{ transform: `rotate(${arrowRot[dir]}deg)`, ...style }}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </IconBase>
  ),
  Dot: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </IconBase>
  ),
  Circle: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="12" r="8" />
    </IconBase>
  ),
  Pulse: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </IconBase>
  ),
  Alert: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M12 4l10 17H2L12 4z" />
      <path d="M12 10v5M12 18.5v.1" />
    </IconBase>
  ),
  Clock: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  ),
  GitBranch: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 8v8M8 9c4 0 8 1 8 8" />
    </IconBase>
  ),
  Repo: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5z" />
      <path d="M4 17h15M9 3v14" />
    </IconBase>
  ),
  Inbox: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M3 13l4-9h10l4 9v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z" />
      <path d="M3 13h5l1 2h6l1-2h5" />
    </IconBase>
  ),
  Settings: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </IconBase>
  ),
  Filter: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M3 5h18l-7 9v6l-4-2v-4L3 5z" />
    </IconBase>
  ),
  Refresh: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </IconBase>
  ),
  ExternalLink: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </IconBase>
  ),
  More: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </IconBase>
  ),
  User: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </IconBase>
  ),
  Bot: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <rect x="4" y="6" width="16" height="14" rx="3" />
      <path d="M12 2v4" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M9 17h6" />
    </IconBase>
  ),
  Sparkle: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M12 3l1.6 5L19 9.5l-5.4 1.5L12 16l-1.6-5L5 9.5 10.4 8 12 3z" />
    </IconBase>
  ),
  Sun: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
    </IconBase>
  ),
  Moon: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z" />
    </IconBase>
  ),
  Anchor: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v15M5 17a7 7 0 0 0 14 0M3 17h4M17 17h4M8 12h8" />
    </IconBase>
  ),
  Slack: ({ size, style }: IconProps) => (
    <IconBase size={size} style={style}>
      <rect x="3" y="9" width="6" height="2" rx="1" />
      <rect x="9" y="3" width="2" height="6" rx="1" />
      <rect x="15" y="13" width="6" height="2" rx="1" />
      <rect x="13" y="15" width="2" height="6" rx="1" />
    </IconBase>
  ),
};
