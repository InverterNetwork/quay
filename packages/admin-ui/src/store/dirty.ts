import { useCallback, useState } from 'react';

export interface TagNamespaceInput {
  name: string;
  required: boolean;
  values: string[];
}

export interface RepoUpdateChange {
  type: 'repo.update';
  repo_id: string;
  patch: Partial<{
    repo_url: string;
    base_branch: string;
    package_manager: string;
    install_cmd: string;
    test_cmd: string | null;
    ci_workflow_name: string | null;
    contribution_guide_path: string | null;
    agent_worker: string | null;
    agent_reviewer: string | null;
    model_worker: string | null;
    model_reviewer: string | null;
  }>;
}

export interface TagsReplaceChange {
  type: 'tags.replace';
  scope: 'deployment' | 'repo';
  repo_id?: string;
  tag_namespaces: TagNamespaceInput[];
}

export type AdminChange = RepoUpdateChange | TagsReplaceChange;

export interface ChangeEntry {
  id: string;
  scope: string;
  label: string;
  before: string;
  after: string;
  change: AdminChange;
}

export interface ChangeStoreApi {
  changes: ChangeEntry[];
  set: (entry: ChangeEntry) => void;
  clear: (id?: string) => void;
  discardAll: () => void;
  isDirty: (id: string) => boolean;
  get: (id: string) => ChangeEntry | undefined;
}

export function useChangeStore(initial: ChangeEntry[] = []): ChangeStoreApi {
  const [changes, setChanges] = useState<ChangeEntry[]>(initial);

  const set = useCallback((entry: ChangeEntry) => {
    setChanges((prev) => {
      const idx = prev.findIndex((c) => c.id === entry.id);
      if (entry.after === entry.before) {
        return idx >= 0 ? prev.filter((_, i) => i !== idx) : prev;
      }
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, []);

  const clear = useCallback((id?: string) => {
    setChanges((prev) => (id ? prev.filter((c) => c.id !== id) : []));
  }, []);

  const discardAll = useCallback(() => setChanges([]), []);

  const isDirty = useCallback((id: string) => changes.some((c) => c.id === id), [changes]);

  const get = useCallback(
    (id: string) => changes.find((c) => c.id === id),
    [changes],
  );

  return { changes, set, clear, discardAll, isDirty, get };
}
