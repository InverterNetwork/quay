import { useMemo, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Input } from '../components/Input';
import { HStack } from '../components/Stack';
import { Toggle } from '../components/Toggle';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { TagNamespace } from '../store/data';
import type { ChangeEntry, TagNamespaceInput, TagsReplaceChange } from '../store/dirty';
import { Field } from './Field';

interface TagNamespaceEditorProps {
  scope: 'deployment' | 'repo';
  repoId?: string;
  baseline: TagNamespace[];
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
  emptyText: string;
  inherited?: TagNamespace[];
}

export function TagNamespaceEditor({
  scope,
  repoId,
  baseline,
  changes,
  onChange,
  emptyText,
  inherited = [],
}: TagNamespaceEditorProps) {
  const [newName, setNewName] = useState('');
  const [newValues, setNewValues] = useState('');
  const changeId = tagChangeId(scope, repoId);
  const pending = changes.find((entry) => entry.id === changeId);
  const base = useMemo(() => normalizeNamespaces(baseline), [baseline]);
  const current = useMemo(
    () => {
      if (pending?.change.type === 'tags.replace') {
        return normalizeNamespaces(pending.change.tag_namespaces);
      }
      return base;
    },
    [base, pending],
  );
  const dirty = pending !== undefined;

  function commit(nextRaw: TagNamespaceInput[]) {
    const next = normalizeNamespaces(nextRaw);
    const change: TagsReplaceChange =
      scope === 'repo'
        ? { type: 'tags.replace', scope, repo_id: repoId, tag_namespaces: next }
        : { type: 'tags.replace', scope, tag_namespaces: next };
    onChange({
      id: changeId,
      scope: scope === 'repo' ? repoId ?? 'repo' : 'global',
      label: scope === 'repo' ? `${repoId} tag namespaces` : 'deployment tag namespaces',
      before: formatNamespaces(base),
      after: formatNamespaces(next),
      change,
    });
  }

  function updateNamespace(name: string, patch: Partial<TagNamespaceInput>) {
    commit(current.map((namespace) => (namespace.name === name ? { ...namespace, ...patch } : namespace)));
  }

  function removeNamespace(name: string) {
    commit(current.filter((namespace) => namespace.name !== name));
  }

  function addNamespace() {
    const name = newName.trim();
    if (name === '' || current.some((namespace) => namespace.name === name)) return;
    commit([
      ...current,
      { name, required: false, values: parseValues(name, newValues) },
    ]);
    setNewName('');
    setNewValues('');
  }

  return (
    <Card padding={18} style={dirty ? { borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' } : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {current.map((namespace) => (
          <div key={namespace.name}>
            <HStack gap={8} style={{ marginBottom: 8 }}>
              <T kind="mono" style={{ fontWeight: 500 }}>
                {namespace.name}
              </T>
              {namespace.required && (
                <Badge tone="danger" size="sm">
                  REQUIRED
                </Badge>
              )}
              <span style={{ flex: 1 }} />
              <Toggle
                checked={namespace.required}
                label="required"
                onChange={(required) => updateNamespace(namespace.name, { required })}
              />
              <Button
                variant="ghost"
                size="sm"
                leading={<Icon.X size={12} />}
                onClick={() => removeNamespace(namespace.name)}
              >
                Remove
              </Button>
            </HStack>
            <Field
              fullRow
              label="VALUES"
              value={namespace.values.map((value) => `${namespace.name}-${value}`).join(', ')}
              source={scope === 'repo' ? 'repo-only' : 'global-only'}
              dirty={dirty}
              editable
              onCommit={(next) => updateNamespace(namespace.name, {
                values: parseValues(namespace.name, next),
              })}
            />
          </div>
        ))}

        {current.length === 0 && (
          <T kind="body-sm" color="var(--ink-3)">
            {emptyText}
          </T>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(140px, 0.35fr) minmax(200px, 1fr) auto',
            gap: 8,
            alignItems: 'center',
            paddingTop: 4,
          }}
        >
          <Input
            inputSize="sm"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="namespace"
          />
          <Input
            inputSize="sm"
            value={newValues}
            onChange={(event) => setNewValues(event.target.value)}
            placeholder="values, comma separated"
          />
          <Button
            variant="secondary"
            size="sm"
            leading={<Icon.Plus size={12} />}
            onClick={addNamespace}
            disabled={newName.trim() === ''}
          >
            Add
          </Button>
        </div>

        {inherited.length > 0 && (
          <div style={{ opacity: 0.72, display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
            <HStack gap={8}>
              <Icon.Arrow size={11} dir="up" style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">
                inherited from deployment
              </T>
            </HStack>
            {inherited.map((namespace) => (
              <HStack key={namespace.name} gap={5} wrap>
                <T kind="mono-sm" color="var(--ink-3)" style={{ marginRight: 3 }}>
                  {namespace.name}
                </T>
                {namespace.values.map((value) => (
                  <Chip key={value}>
                    {namespace.name}-{value}
                  </Chip>
                ))}
              </HStack>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function tagChangeId(scope: 'deployment' | 'repo', repoId?: string): string {
  return scope === 'repo' ? `tags:repo:${repoId}` : 'tags:deployment';
}

function normalizeNamespaces(namespaces: readonly TagNamespaceInput[] | readonly TagNamespace[]): TagNamespaceInput[] {
  return [...namespaces]
    .map((namespace) => ({
      name: namespace.name.trim(),
      required: namespace.required,
      values: [...new Set(namespace.values.map((value) => value.trim()).filter(Boolean))].sort(),
    }))
    .filter((namespace) => namespace.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseValues(namespace: string, raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.startsWith(`${namespace}-`) ? part.slice(namespace.length + 1) : part),
    ),
  ].sort();
}

function formatNamespaces(namespaces: readonly TagNamespaceInput[]): string {
  if (namespaces.length === 0) return 'none';
  return normalizeNamespaces(namespaces)
    .map((namespace) => {
      const required = namespace.required ? ' required' : '';
      const values = namespace.values.length === 0
        ? 'no values'
        : namespace.values.map((value) => `${namespace.name}-${value}`).join(', ');
      return `${namespace.name}${required}: ${values}`;
    })
    .join(' · ');
}
