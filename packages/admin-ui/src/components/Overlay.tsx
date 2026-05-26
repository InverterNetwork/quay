import { useEffect, type ReactNode } from 'react';

interface OverlayProps {
  intensity?: number;
  onDismiss?: () => void;
  dismissOnBackdrop?: boolean;
  ariaLabel?: string;
  align?: 'right' | 'center';
  topOffset?: number;
  children: ReactNode;
}

export function Overlay({
  intensity = 0.42,
  onDismiss,
  dismissOnBackdrop = true,
  ariaLabel,
  align = 'center',
  topOffset = 0,
  children,
}: OverlayProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && onDismiss) {
        e.stopPropagation();
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="presentation"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        animation: 'cv2-fade-in 120ms ease-out',
      }}
    >
      <div
        onClick={() => {
          if (dismissOnBackdrop) onDismiss?.();
        }}
        style={{
          position: 'absolute',
          inset: 0,
          background: `rgba(14, 14, 12, ${intensity})`,
          backdropFilter: 'blur(1.5px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          justifyContent: align === 'right' ? 'flex-end' : 'center',
          alignItems: align === 'right' ? 'stretch' : 'flex-start',
          paddingTop: align === 'center' ? topOffset : 0,
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}
