import { T } from '../components/Typography';

export interface TocItem {
  id: string;
  label: string;
}

interface TocProps {
  items: TocItem[];
  active: string;
  onSelect?: (id: string) => void;
}

export function Toc({ items, active, onSelect }: TocProps) {
  return (
    <nav
      aria-label="On this page"
      style={{
        width: 184,
        flexShrink: 0,
        position: 'sticky',
        top: 24,
        alignSelf: 'flex-start',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 16,
        borderLeft: '1px solid var(--line)',
      }}
    >
      <T kind="caption" color="var(--ink-3)" style={{ marginBottom: 10 }}>
        ON THIS PAGE
      </T>
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          onClick={(e) => {
            if (onSelect) {
              e.preventDefault();
              onSelect(it.id);
            }
            document.getElementById(it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          style={{
            padding: '5px 0',
            cursor: 'pointer',
            borderLeft: it.id === active ? '2px solid var(--accent)' : '2px solid transparent',
            paddingLeft: 10,
            marginLeft: -12,
            display: 'block',
          }}
        >
          <T
            kind="body-sm"
            style={{
              fontWeight: it.id === active ? 600 : 400,
              color: it.id === active ? 'var(--ink)' : 'var(--ink-3)',
            }}
          >
            {it.label}
          </T>
        </a>
      ))}
    </nav>
  );
}
