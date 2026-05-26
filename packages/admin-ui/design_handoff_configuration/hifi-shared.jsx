// hifi-shared.jsx — primitives + brand mark for Quay hi-fi

// ── Brand mark ───────────────────────────────────────────────
// A small geometric mark: horizontal dock-bar with a boat resting on it.
function QuayMark({ size = 24, color = 'currentColor', style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={{ display: 'block', ...style }}>
      {/* Dock / water line */}
      <rect x="2" y="16" width="20" height="2.6" rx="1.3" />
      {/* Boat at dock */}
      <rect x="12.5" y="6" width="7.5" height="7.5" rx="1.8" />
    </svg>
  );
}

function QuayWordmark({ size = 22, color = 'currentColor', style = {} }) {
  return (
    <span style={{
      fontFamily: "var(--sans)",
      fontWeight: 600,
      fontSize: size,
      letterSpacing: '-0.012em',
      color, lineHeight: 1, display: 'inline-flex', alignItems: 'center', gap: size * 0.36,
      ...style,
    }}>
      <QuayMark size={size * 0.92} />
      <span style={{ paddingTop: 1 }}>Quay</span>
    </span>
  );
}

// ── Type primitives ──────────────────────────────────────────
function T({ as = 'span', children, kind = 'body', color, style = {}, ...rest }) {
  const Tag = as;
  const base = {
    display: 'inline',
    color: color || 'inherit',
  };
  const variants = {
    'display':    { fontFamily: 'var(--serif)', fontSize: 56, lineHeight: 1.05, fontWeight: 400, letterSpacing: '-0.025em', fontStyle: 'italic' },
    'h1':         { fontFamily: 'var(--sans)', fontSize: 32, lineHeight: 1.18, fontWeight: 600, letterSpacing: '-0.022em' },
    'h2':         { fontFamily: 'var(--sans)', fontSize: 22, lineHeight: 1.25, fontWeight: 600, letterSpacing: '-0.018em' },
    'h3':         { fontFamily: 'var(--sans)', fontSize: 16, lineHeight: 1.35, fontWeight: 600, letterSpacing: '-0.012em' },
    'h4':         { fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.4, fontWeight: 600, letterSpacing: '-0.005em' },
    'body':       { fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.5, fontWeight: 400 },
    'body-sm':    { fontFamily: 'var(--sans)', fontSize: 13, lineHeight: 1.5, fontWeight: 400 },
    'body-strong':{ fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.5, fontWeight: 500 },
    'small':      { fontFamily: 'var(--sans)', fontSize: 12, lineHeight: 1.45, fontWeight: 400 },
    'caption':    { fontFamily: 'var(--sans)', fontSize: 11, lineHeight: 1.4, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', color: color || 'var(--ink-3)' },
    'mono':       { fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.5, fontWeight: 400, fontFeatureSettings: '"zero","ss01"' },
    'mono-sm':    { fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.4, fontWeight: 400, fontFeatureSettings: '"zero","ss01"' },
    'mono-md':    { fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.5, fontWeight: 400 },
    'serif-display': { fontFamily: 'var(--serif)', fontSize: 36, lineHeight: 1.1, fontWeight: 400, letterSpacing: '-0.02em', fontStyle: 'italic' },
    'serif-h':    { fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.2, fontWeight: 400, fontStyle: 'italic' },
  };
  return <Tag {...rest} style={{ ...base, ...variants[kind], ...style }}>{children}</Tag>;
}

// ── Icons (a small Lucide-style set we need) ─────────────────
const I_STROKE = 1.5;
function _Icon({ size = 16, children, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={I_STROKE} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', flexShrink: 0, ...style }}>
      {children}
    </svg>
  );
}
const Icon = {
  Search:   ({ size, style }) => <_Icon size={size} style={style}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></_Icon>,
  Plus:     ({ size, style }) => <_Icon size={size} style={style}><path d="M12 5v14M5 12h14"/></_Icon>,
  Check:    ({ size, style }) => <_Icon size={size} style={style}><path d="M5 12.5l4.2 4.2L19 7"/></_Icon>,
  X:        ({ size, style }) => <_Icon size={size} style={style}><path d="M6 6l12 12M18 6L6 18"/></_Icon>,
  Chevron:  ({ size, dir = 'down', style }) => {
    const r = { down: 0, up: 180, left: 90, right: 270 }[dir];
    return <_Icon size={size} style={{ transform: `rotate(${r}deg)`, ...style }}><path d="M6 9l6 6 6-6"/></_Icon>;
  },
  Arrow:    ({ size, dir = 'right', style }) => {
    const r = { right: 0, down: 90, left: 180, up: 270 }[dir];
    return <_Icon size={size} style={{ transform: `rotate(${r}deg)`, ...style }}><path d="M5 12h14M13 6l6 6-6 6"/></_Icon>;
  },
  Dot:      ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="12" r="3" fill="currentColor"/></_Icon>,
  Circle:   ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="12" r="8"/></_Icon>,
  Pulse:    ({ size, style }) => <_Icon size={size} style={style}><path d="M3 12h4l2-7 4 14 2-7h6"/></_Icon>,
  Alert:    ({ size, style }) => <_Icon size={size} style={style}><path d="M12 4l10 17H2L12 4z"/><path d="M12 10v5M12 18.5v.1"/></_Icon>,
  Clock:    ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></_Icon>,
  GitBranch:({ size, style }) => <_Icon size={size} style={style}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M8 9c4 0 8 1 8 8"/></_Icon>,
  GitPR:    ({ size, style }) => <_Icon size={size} style={style}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 8a4 4 0 0 0-4-4h-3M11 1l-3 3 3 3"/></_Icon>,
  Repo:     ({ size, style }) => <_Icon size={size} style={style}><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5z"/><path d="M4 17h15M9 3v14"/></_Icon>,
  Inbox:    ({ size, style }) => <_Icon size={size} style={style}><path d="M3 13l4-9h10l4 9v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/><path d="M3 13h5l1 2h6l1-2h5"/></_Icon>,
  Settings: ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></_Icon>,
  Filter:   ({ size, style }) => <_Icon size={size} style={style}><path d="M3 5h18l-7 9v6l-4-2v-4L3 5z"/></_Icon>,
  Refresh:  ({ size, style }) => <_Icon size={size} style={style}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></_Icon>,
  ExternalLink:({size, style}) => <_Icon size={size} style={style}><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></_Icon>,
  More:     ({ size, style }) => <_Icon size={size} style={style}><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></_Icon>,
  User:     ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></_Icon>,
  Bot:      ({ size, style }) => <_Icon size={size} style={style}><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M12 2v4"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M9 17h6"/></_Icon>,
  Sparkle:  ({ size, style }) => <_Icon size={size} style={style}><path d="M12 3l1.6 5L19 9.5l-5.4 1.5L12 16l-1.6-5L5 9.5 10.4 8 12 3z"/></_Icon>,
  Sun:      ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></_Icon>,
  Moon:     ({ size, style }) => <_Icon size={size} style={style}><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/></_Icon>,
  Anchor:   ({ size, style }) => <_Icon size={size} style={style}><circle cx="12" cy="5" r="2"/><path d="M12 7v15M5 17a7 7 0 0 0 14 0M3 17h4M17 17h4M8 12h8"/></_Icon>,
  Slack:    ({ size, style }) => <_Icon size={size} style={style}><rect x="3" y="9" width="6" height="2" rx="1"/><rect x="9" y="3" width="2" height="6" rx="1"/><rect x="15" y="13" width="6" height="2" rx="1"/><rect x="13" y="15" width="2" height="6" rx="1"/></_Icon>,
};

// ── Tone definitions ─────────────────────────────────────────
const TONES = {
  neutral: { fg: 'var(--ink-2)',     bg: 'var(--surface-2)', line: 'var(--line-2)', dot: 'var(--ink-3)' },
  accent:  { fg: 'var(--accent-ink)', bg: 'var(--accent-soft)', line: 'var(--accent-line)', dot: 'var(--accent)' },
  good:    { fg: 'var(--good-ink)',   bg: 'var(--good-soft)', line: 'var(--good-line)', dot: 'var(--good)' },
  warn:    { fg: 'var(--warn-ink)',   bg: 'var(--warn-soft)', line: 'var(--warn-line)', dot: 'var(--warn)' },
  danger:  { fg: 'var(--danger-ink)', bg: 'var(--danger-soft)', line: 'var(--danger-line)', dot: 'var(--danger)' },
};

// ── Button ───────────────────────────────────────────────────
function Button({ children, variant = 'secondary', size = 'md', leading, trailing, kbd, fullWidth, style = {}, onClick, type }) {
  const sizes = {
    sm: { h: 26, px: 9, fs: 12, gap: 5 },
    md: { h: 32, px: 12, fs: 13, gap: 6 },
    lg: { h: 38, px: 16, fs: 14, gap: 7 },
  }[size];

  const variants = {
    primary:   { bg: 'var(--ink)',     fg: 'var(--paper)',  border: 'var(--ink)', hover: 'var(--ink-2)' },
    secondary: { bg: 'var(--surface)', fg: 'var(--ink)',    border: 'var(--line-2)', hover: 'var(--surface-2)' },
    ghost:     { bg: 'transparent',    fg: 'var(--ink-2)',  border: 'transparent', hover: 'var(--surface-2)' },
    accent:    { bg: 'var(--accent)',  fg: '#fff',          border: 'var(--accent)', hover: 'var(--accent-hover)' },
    danger:    { bg: 'transparent',    fg: 'var(--danger-ink)', border: 'var(--danger-line)', hover: 'var(--danger-soft)' },
  }[variant];

  return (
    <button onClick={onClick} type={type || 'button'} style={{
      display: 'inline-flex', alignItems: 'center', gap: sizes.gap,
      height: sizes.h, padding: `0 ${sizes.px}px`, fontSize: sizes.fs, fontWeight: 500,
      fontFamily: 'var(--sans)', letterSpacing: '-0.005em',
      background: variants.bg, color: variants.fg,
      border: `1px solid ${variants.border}`, borderRadius: 'var(--r-sm)',
      cursor: 'pointer', whiteSpace: 'nowrap',
      width: fullWidth ? '100%' : undefined,
      transition: 'background 80ms',
      ...style,
    }}>
      {leading}
      {children}
      {trailing}
      {kbd && <Kbd size={size === 'sm' ? 10 : 11}>{kbd}</Kbd>}
    </button>
  );
}

// ── Kbd ──────────────────────────────────────────────────────
function Kbd({ children, size = 11, style = {} }) {
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: size, fontWeight: 500,
      padding: '1px 5px', borderRadius: 3,
      background: 'var(--surface-2)', color: 'var(--ink-3)',
      border: '1px solid var(--line)',
      lineHeight: 1.4,
      ...style,
    }}>{children}</span>
  );
}

// ── Badge / Pill ─────────────────────────────────────────────
function Badge({ children, tone = 'neutral', variant = 'soft', size = 'md', dot, style = {} }) {
  const t = TONES[tone];
  const sizes = {
    sm: { h: 18, px: 6, fs: 10, gap: 4 },
    md: { h: 22, px: 8, fs: 11, gap: 5 },
    lg: { h: 26, px: 10, fs: 12, gap: 6 },
  }[size];
  const styles = {
    soft:    { bg: t.bg, fg: t.fg, border: 'transparent' },
    outline: { bg: 'transparent', fg: t.fg, border: t.line },
    solid:   { bg: t.dot, fg: '#fff', border: t.dot },
  }[variant];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: sizes.gap,
      height: sizes.h, padding: `0 ${sizes.px}px`,
      fontFamily: 'var(--sans)', fontSize: sizes.fs, fontWeight: 500,
      letterSpacing: '0.01em',
      background: styles.bg, color: styles.fg,
      border: `1px solid ${styles.border}`,
      borderRadius: 999,
      ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot, flexShrink: 0 }} />}
      {children}
    </span>
  );
}

// ── Status dot (pulse-able) ──────────────────────────────────
function StatusDot({ tone = 'good', pulse = false, size = 8, style = {} }) {
  const t = TONES[tone];
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: size, height: size, ...style }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%', background: t.dot,
      }} />
      {pulse && (
        <span style={{
          position: 'absolute', inset: -3, borderRadius: '50%',
          background: t.dot, opacity: 0.25, animation: 'hf-pulse 1.8s ease-in-out infinite',
        }} />
      )}
    </span>
  );
}

// ── Chip ─────────────────────────────────────────────────────
function Chip({ children, tone = 'neutral', leading, trailing, onRemove, interactive, selected, style = {} }) {
  const t = TONES[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      height: 22, padding: '0 8px',
      fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
      color: selected ? t.fg : 'var(--ink-2)',
      background: selected ? t.bg : 'var(--surface)',
      border: `1px solid ${selected ? t.line : 'var(--line-2)'}`,
      borderRadius: 'var(--r-sm)',
      cursor: interactive ? 'pointer' : 'default',
      ...style,
    }}>
      {leading}
      {children}
      {trailing}
      {onRemove && <Icon.X size={11} style={{ color: 'var(--ink-3)' }} />}
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────
function Card({ children, padding = 16, style = {}, raised = false, accent = false }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${accent ? 'var(--accent-line)' : 'var(--line)'}`,
      borderRadius: 'var(--r-lg)',
      padding,
      boxShadow: raised ? 'var(--shadow-md)' : 'none',
      ...style,
    }}>{children}</div>
  );
}

// ── Avatar / initials ────────────────────────────────────────
function Avatar({ name = '?', size = 24, tone = 'neutral', style = {} }) {
  const initial = (name || '?').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
  const t = TONES[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: '50%',
      background: t.bg, color: t.fg,
      fontFamily: 'var(--sans)', fontSize: Math.round(size * 0.42), fontWeight: 600,
      border: `1px solid ${t.line}`,
      ...style,
    }}>{initial}</span>
  );
}

// ── Budget meter ─────────────────────────────────────────────
function BudgetMeter({ used, total, tone, style = {} }) {
  const t = TONES[tone || (used >= total ? 'danger' : used >= total - 1 ? 'warn' : 'neutral')];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span style={{ display: 'inline-flex', gap: 2 }}>
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} style={{
            width: 6, height: 10,
            background: i < used ? t.dot : 'var(--surface-2)',
            border: `1px solid ${i < used ? t.dot : 'var(--line-2)'}`,
            borderRadius: 1.5,
          }} />
        ))}
      </span>
      <span className="mono tnum" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{used}/{total}</span>
    </span>
  );
}

// ── Input ────────────────────────────────────────────────────
function Input({ value, placeholder, leading, trailing, size = 'md', invalid, style = {} }) {
  const sizes = { sm: 28, md: 32, lg: 38 }[size];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: sizes, padding: '0 10px',
      background: 'var(--surface)',
      border: `1px solid ${invalid ? 'var(--danger-line)' : 'var(--line-2)'}`,
      borderRadius: 'var(--r-sm)',
      ...style,
    }}>
      {leading && <span style={{ color: 'var(--ink-3)', display: 'inline-flex' }}>{leading}</span>}
      <span style={{
        fontFamily: 'var(--sans)', fontSize: 13, color: value ? 'var(--ink)' : 'var(--ink-3)',
        flex: 1,
      }}>{value || placeholder}</span>
      {trailing}
    </span>
  );
}

// ── Toggle ───────────────────────────────────────────────────
function Toggle({ checked, label, tone = 'accent', style = {} }) {
  const t = TONES[tone];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...style }}>
      <span style={{
        position: 'relative', width: 28, height: 16,
        background: checked ? t.dot : 'var(--line-2)',
        borderRadius: 999, transition: 'background 120ms',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 14 : 2,
          width: 12, height: 12, borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.15)', transition: 'left 120ms',
        }} />
      </span>
      {label && <T kind="body-sm">{label}</T>}
    </span>
  );
}

// ── Segmented control ────────────────────────────────────────
function Segmented({ value, options, onChange, style = {} }) {
  return (
    <span style={{
      display: 'inline-flex',
      background: 'var(--surface-2)',
      border: '1px solid var(--line-2)',
      borderRadius: 'var(--r-sm)',
      padding: 2, gap: 2,
      ...style,
    }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <span key={o.value} onClick={() => onChange?.(o.value)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 10px',
            fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
            color: active ? 'var(--ink)' : 'var(--ink-3)',
            background: active ? 'var(--surface)' : 'transparent',
            border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
            borderRadius: 'var(--r-xs)',
            cursor: 'pointer',
          }}>{o.leading}{o.label}</span>
        );
      })}
    </span>
  );
}

// ── Divider ──────────────────────────────────────────────────
function Divider({ vertical, dashed, style = {} }) {
  return (
    <div style={{
      flexShrink: 0,
      width: vertical ? 1 : '100%',
      height: vertical ? '100%' : 1,
      background: dashed ? 'transparent' : 'var(--line)',
      borderLeft: dashed && vertical ? '1px dashed var(--line-2)' : undefined,
      borderTop: dashed && !vertical ? '1px dashed var(--line-2)' : undefined,
      ...style,
    }} />
  );
}

// ── HStack / VStack helpers ──────────────────────────────────
function HStack({ gap = 8, align = 'center', justify, wrap, children, style = {}, ...rest }) {
  return (
    <div style={{
      display: 'flex', alignItems: align, gap,
      justifyContent: justify, flexWrap: wrap ? 'wrap' : 'nowrap',
      ...style,
    }} {...rest}>{children}</div>
  );
}
function VStack({ gap = 8, align = 'stretch', children, style = {}, ...rest }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap, alignItems: align,
      ...style,
    }} {...rest}>{children}</div>
  );
}

// ── Pulse animation ──────────────────────────────────────────
function HFGlobalStyles() {
  return (
    <style>{`
      @keyframes hf-pulse {
        0%, 100% { transform: scale(1); opacity: 0.3; }
        50% { transform: scale(1.6); opacity: 0; }
      }
      .hf button:hover { filter: brightness(0.98); }
      [data-mode="dark"] .hf button:hover { filter: brightness(1.08); }
      .hf [data-row]:hover { background: var(--surface-2); }
      .hf .hairline { background: var(--line); }
    `}</style>
  );
}

Object.assign(window, {
  QuayMark, QuayWordmark, T, Icon, Badge, Chip, Card, Avatar,
  Button, Kbd, StatusDot, BudgetMeter, Input, Toggle, Segmented, Divider,
  HStack, VStack, HFGlobalStyles, HF_TONES: TONES,
});
