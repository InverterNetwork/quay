import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';

export type FieldSource = 'override' | 'inherits' | 'repo-only' | 'global-only';
export type FieldVisualState = 'default' | 'focused' | 'dirty' | 'error' | 'disabled';

export interface FieldProps {
  label: string;
  value: string | null;
  source?: FieldSource;
  inheritedValue?: string;
  dirty?: boolean;
  state?: FieldVisualState;
  error?: string;
  mono?: boolean;
  fullRow?: boolean;
  hint?: string;
  suffix?: ReactNode;
  editable?: boolean;
  onCommit?: (next: string) => void;
  onCancel?: () => void;
  helper?: string;
  /** When true, render a derived/computed value with dashed border */
  computed?: boolean;
}

export function Field({
  label,
  value,
  source,
  inheritedValue,
  dirty,
  state,
  error,
  mono = true,
  fullRow,
  hint,
  suffix,
  editable,
  onCommit,
  onCancel,
  helper,
  computed,
}: FieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setDraftValue(value ?? '');
  }, [value, isEditing]);

  const focused = state === 'focused' || isEditing;
  const isError = state === 'error' || Boolean(error);
  const disabled = state === 'disabled' || computed;

  const borderColor = isError
    ? 'var(--danger)'
    : focused
      ? 'var(--accent)'
      : dirty
        ? 'var(--warn-line)'
        : computed
          ? 'var(--line-2)'
          : 'var(--line)';
  const borderStyle: CSSProperties['borderStyle'] = computed ? 'dashed' : 'solid';
  const bg = dirty
    ? 'var(--warn-soft)'
    : computed
      ? 'var(--paper-2)'
      : 'var(--surface)';
  const haloShadow = focused
    ? `0 0 0 3px ${isError ? 'var(--danger-soft)' : 'var(--accent-soft)'}`
    : 'none';

  function startEdit() {
    if (editable && !disabled) setIsEditing(true);
  }

  function commit() {
    setIsEditing(false);
    onCommit?.(draftValue);
  }

  function cancel() {
    setIsEditing(false);
    setDraftValue(value ?? '');
    onCancel?.();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        gridColumn: fullRow ? '1 / -1' : 'auto',
      }}
    >
      <HStack gap={6}>
        <T kind="caption" color="var(--ink-3)">
          {label}
        </T>
        {hint && (
          <T kind="mono-sm" color="var(--ink-4)">
            · {hint}
          </T>
        )}
      </HStack>
      <div
        onClick={startEdit}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          minHeight: 32,
          background: bg,
          border: `${focused ? 1.5 : 1}px ${borderStyle} ${borderColor}`,
          borderRadius: 'var(--r-sm)',
          boxShadow: haloShadow,
          position: 'relative',
          cursor: editable && !disabled ? 'text' : 'default',
          opacity: disabled ? 0.85 : 1,
        }}
      >
        {dirty && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -1,
              top: -1,
              bottom: -1,
              width: 2,
              background: 'var(--warn)',
              borderTopLeftRadius: 2,
              borderBottomLeftRadius: 2,
            }}
          />
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            style={{
              fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
              fontSize: mono ? 12 : 13,
              color: 'var(--ink)',
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 0,
              outline: 'none',
              padding: 0,
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
              fontSize: mono ? 12 : 13,
              color: computed
                ? 'var(--ink-3)'
                : value
                  ? 'var(--ink)'
                  : 'var(--ink-4)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontStyle: value ? (computed ? 'italic' : 'normal') : 'italic',
            }}
          >
            {value || '— not set —'}
          </span>
        )}
        {suffix}
      </div>
      {(error || helper) && (
        <HStack gap={5}>
          {error && (
            <>
              <Icon.Alert size={11} style={{ color: 'var(--danger)' }} />
              <T kind="mono-sm" color="var(--danger-ink)">
                {error}
              </T>
            </>
          )}
          {!error && helper && (
            <T kind="mono-sm" color="var(--ink-3)">
              {helper}
            </T>
          )}
        </HStack>
      )}
      {source && !error && !helper && (
        <HStack gap={5}>
          {source === 'override' && (
            <>
              <Icon.Arrow size={10} dir="up" style={{ color: 'var(--accent)' }} />
              <T kind="mono-sm" color="var(--accent-ink)">
                overrides global
              </T>
              {inheritedValue && (
                <T kind="mono-sm" color="var(--ink-4)">
                  · was {inheritedValue}
                </T>
              )}
            </>
          )}
          {source === 'inherits' && (
            <>
              <Icon.Arrow size={10} dir="up" style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">
                inherits global
              </T>
              {inheritedValue && (
                <T kind="mono-sm" color="var(--ink-4)">
                  · {inheritedValue}
                </T>
              )}
            </>
          )}
          {source === 'repo-only' && (
            <>
              <Icon.Dot size={9} style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">
                repo-only
              </T>
            </>
          )}
          {source === 'global-only' && (
            <>
              <Icon.Dot size={9} style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">
                global-only
              </T>
            </>
          )}
        </HStack>
      )}
    </div>
  );
}
