import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type {
  IdentityDiscovery,
  IdentityMapping,
} from '../store/data';
import type { ChangeEntry, IdentityMappingInput, IdentityMappingsReplaceChange } from '../store/dirty';

interface IdentityMappingEditorProps {
  baseline: IdentityMapping[];
  discovery: IdentityDiscovery;
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
}

interface DraftMapping {
  slackUserId: string;
  slackDisplayName: string;
  slackHandle: string;
  slackEmail: string;
  githubLogin: string;
}

const EMPTY_DRAFT: DraftMapping = {
  slackUserId: '',
  slackDisplayName: '',
  slackHandle: '',
  slackEmail: '',
  githubLogin: '',
};

export function IdentityMappingEditor({
  baseline,
  changes,
  onChange,
}: IdentityMappingEditorProps) {
  const [draft, setDraft] = useState<DraftMapping>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);

  const changeId = 'identity_mappings:deployment';
  const pending = changes.find((entry) => entry.id === changeId);
  const base = useMemo(() => normalizeMappings(baseline.map(toInput)), [baseline]);
  const current = useMemo(
    () => {
      if (pending?.change.type === 'identity_mappings.replace') {
        return normalizeMappings(pending.change.mappings);
      }
      return base;
    },
    [base, pending],
  );
  const dirty = pending !== undefined;
  const showComposer = adding || current.length === 0;

  function commit(nextRaw: IdentityMappingInput[]) {
    const next = normalizeMappings(nextRaw);
    const change: IdentityMappingsReplaceChange = {
      type: 'identity_mappings.replace',
      mappings: next,
    };
    onChange({
      id: changeId,
      scope: 'global',
      label: 'identity mappings',
      before: formatMappings(base),
      after: formatMappings(next),
      change,
    });
  }

  function updateMapping(slackUserId: string, patch: Partial<IdentityMappingInput>) {
    const next = current.map((mapping) =>
      mapping.slack_user_id === slackUserId ? { ...mapping, ...patch } : mapping
    );
    commit(next);
  }

  function removeMapping(slackUserId: string) {
    commit(current.filter((mapping) => mapping.slack_user_id !== slackUserId));
  }

  function startMapping() {
    setDraft(EMPTY_DRAFT);
    setAdding(true);
  }

  function addDraft() {
    const next = draftToInput(draft);
    if (next === null) return;
    if (current.some((mapping) => mapping.slack_user_id === next.slack_user_id)) return;
    commit([...current, next]);
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  }

  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 544, width: '100%' }}>
      <Card
        padding={0}
        style={dirty ? { borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' } : undefined}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 12,
            alignItems: 'center',
            padding: '12px 14px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <T kind="mono-sm" color="var(--ink-3)">
            [[adapters.identity_map]] - {current.length} row{current.length === 1 ? '' : 's'} - keyed on slack_id
          </T>
          <Button
            variant="secondary"
            size="sm"
            leading={<Icon.Plus size={12} />}
            onClick={startMapping}
          >
            Add mapping
          </Button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <div
            style={{
              minWidth: 520,
              display: 'grid',
              gridTemplateColumns: 'minmax(190px, 1fr) minmax(190px, 1fr) 54px',
            }}
          >
            <TableHeader>Slack user ID</TableHeader>
            <TableHeader>GitHub handle</TableHeader>
            <TableHeader />

            {current.map((mapping) => (
              <MappingRow
                key={mapping.slack_user_id}
                mapping={mapping}
                onUpdate={updateMapping}
                onRemove={removeMapping}
              />
            ))}
          </div>
        </div>

        {current.length === 0 && (
          <div style={{ padding: 14 }}>
            <T kind="body-sm" color="var(--ink-3)">
              No Slack to GitHub mappings are configured.
            </T>
          </div>
        )}
      </Card>

      {showComposer && (
        <Card padding={14}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(150px, 0.8fr) minmax(150px, 0.8fr) minmax(150px, 1fr) auto',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Input
              inputSize="sm"
              value={draft.slackDisplayName}
              placeholder="Slack name"
              onChange={(event) => setDraft({ ...draft, slackDisplayName: event.currentTarget.value })}
            />
            <Input
              inputSize="sm"
              value={draft.slackUserId}
              placeholder="Slack user ID"
              onChange={(event) => setDraft({ ...draft, slackUserId: event.currentTarget.value })}
            />
            <Input
              inputSize="sm"
              value={draft.githubLogin}
              placeholder="GitHub handle"
              leading={<Icon.GitPR size={13} />}
              onChange={(event) => setDraft({ ...draft, githubLogin: event.currentTarget.value })}
            />
            <HStack gap={6}>
              <Button
                variant="accent"
                size="sm"
                leading={<Icon.Plus size={12} />}
                onClick={addDraft}
                disabled={draftToInput(draft) === null}
              >
                Add
              </Button>
              {adding && current.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(EMPTY_DRAFT);
                    setAdding(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </HStack>
          </div>
        </Card>
      )}
    </div>
  );
}

function MappingRow({
  mapping,
  onUpdate,
  onRemove,
}: {
  mapping: IdentityMappingInput;
  onUpdate: (slackUserId: string, patch: Partial<IdentityMappingInput>) => void;
  onRemove: (slackUserId: string) => void;
}) {
  const status = mapping.status ?? 'mapped';

  return (
    <>
      <TableCell>
        <Input
          key={`${mapping.slack_user_id}:id`}
          inputSize="sm"
          defaultValue={mapping.slack_user_id}
          leading={<Icon.Slack size={13} />}
          title={mapping.slack_display_name}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (next !== '') onUpdate(mapping.slack_user_id, { slack_user_id: next });
          }}
          shellStyle={{ width: '100%' }}
          style={{ fontFamily: 'var(--mono)' }}
        />
      </TableCell>
      <TableCell>
        <Input
          key={`${mapping.slack_user_id}:github:${mapping.github_login}`}
          inputSize="sm"
          defaultValue={mapping.github_login}
          leading={<Icon.GitPR size={13} />}
          invalid={status === 'conflict'}
          title={status}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim().replace(/^@/, '');
            if (next !== '') onUpdate(mapping.slack_user_id, { github_login: next, status: 'mapped' });
          }}
          shellStyle={{ width: '100%' }}
          style={{ fontFamily: 'var(--mono)' }}
        />
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="sm"
          leading={<Icon.X size={12} />}
          onClick={() => onRemove(mapping.slack_user_id)}
          title="Remove mapping"
        />
      </TableCell>
    </>
  );
}

function TableHeader({ children }: { children?: ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--line-2)',
        color: 'var(--ink-2)',
        fontFamily: 'var(--sans)',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

function TableCell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--line)',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  );
}

function toInput(mapping: IdentityMapping): IdentityMappingInput {
  return {
    slack_user_id: mapping.slackUserId,
    slack_display_name: mapping.slackDisplayName,
    slack_handle: mapping.slackHandle,
    slack_email: mapping.slackEmail,
    github_login: mapping.githubLogin,
    status: mapping.status,
    source: mapping.source,
  };
}

function draftToInput(draft: DraftMapping): IdentityMappingInput | null {
  const slackUserId = draft.slackUserId.trim();
  const slackDisplayName = draft.slackDisplayName.trim();
  const githubLogin = draft.githubLogin.trim().replace(/^@/, '');
  if (slackUserId === '' || slackDisplayName === '' || githubLogin === '') return null;
  return {
    slack_user_id: slackUserId,
    slack_display_name: slackDisplayName,
    slack_handle: nullable(draft.slackHandle),
    slack_email: nullable(draft.slackEmail),
    github_login: githubLogin,
    status: 'mapped',
    source: 'manual',
  };
}

function normalizeMappings(mappings: readonly IdentityMappingInput[]): IdentityMappingInput[] {
  return [...mappings]
    .map((mapping) => ({
      slack_user_id: mapping.slack_user_id.trim(),
      slack_display_name: mapping.slack_display_name.trim(),
      slack_handle: nullable(mapping.slack_handle ?? null),
      slack_email: nullable(mapping.slack_email ?? null),
      github_login: mapping.github_login.trim().replace(/^@/, ''),
      status: mapping.status ?? 'mapped',
      source: mapping.source ?? 'manual',
    }))
    .filter((mapping) => mapping.slack_user_id !== '' && mapping.slack_display_name !== '' && mapping.github_login !== '')
    .sort((a, b) => a.slack_user_id.localeCompare(b.slack_user_id));
}

function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatMappings(mappings: readonly IdentityMappingInput[]): string {
  if (mappings.length === 0) return 'none';
  return normalizeMappings(mappings)
    .map((mapping) => `${mapping.slack_user_id}:${mapping.github_login}:${mapping.status ?? 'mapped'}`)
    .join(' - ');
}
