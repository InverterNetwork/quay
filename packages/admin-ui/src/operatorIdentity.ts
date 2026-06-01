import type { QuayAdminViewer } from './api/quayAdmin';

export interface OperatorIdentity {
  label: string;
  avatarName: string;
  displayName: string | null;
  slackUserId: string | null;
}

export function resolveOperatorIdentity(viewer?: QuayAdminViewer | null): OperatorIdentity {
  const displayName = clean(viewer?.display_name);
  const label = clean(viewer?.label) ?? displayName ?? 'You';

  return {
    label,
    avatarName: label,
    displayName,
    slackUserId: clean(viewer?.slack_user_id),
  };
}

function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
