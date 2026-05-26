import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { Kbd } from './Kbd';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  kbd?: string;
  fullWidth?: boolean;
  style?: CSSProperties;
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  leading,
  trailing,
  kbd,
  fullWidth,
  type = 'button',
  className,
  style,
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    styles[size],
    styles[variant],
    fullWidth ? styles.fullWidth : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...rest} type={type} className={cls} style={style}>
      {leading}
      {children}
      {trailing}
      {kbd && <Kbd size={size === 'sm' ? 10 : 11}>{kbd}</Kbd>}
    </button>
  );
}
