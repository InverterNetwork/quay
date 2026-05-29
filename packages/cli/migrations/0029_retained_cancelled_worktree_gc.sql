-- Tracks retained cancelled worktrees that have been garbage-collected by tick.

ALTER TABLE tasks ADD COLUMN worktree_cleaned_at TEXT;

CREATE INDEX tasks_retained_cancelled_worktree_gc_idx
  ON tasks(state, cancel_keep_worktree, worktree_cleaned_at, cancel_requested_at, updated_at);
