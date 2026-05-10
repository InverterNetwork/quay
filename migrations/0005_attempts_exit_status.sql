-- Per-attempt observability: capture the OS-level termination of the
-- worker pane alongside the existing `exit_kind` classification.
--
-- `exit_code` is the normal-exit status (0–255) when the process exited
-- without a signal. `exit_signal` is the canonical SIG<name> when a signal
-- terminated the process. Exactly one is non-NULL on a captured exit; both
-- stay NULL on rows that pre-date this slice, on attempts whose substrate
-- spawn never produced a real process (`exit_kind = 'spawn_failed'`), and
-- on attempts where the wrapper shell was killed before it could record
-- the inner agent's `$?` (tick's wall-clock kill, cancel finalizer kill).
--
-- Together with `exit_kind` (quay's classification), these answer "what did
-- the OS observe?" — silent SIGKILL (OOM), SIGPIPE (closed stdout), normal
-- exit 0, etc. — without re-deriving from session-log heuristics.

ALTER TABLE attempts ADD COLUMN exit_code INTEGER;
ALTER TABLE attempts ADD COLUMN exit_signal TEXT;
