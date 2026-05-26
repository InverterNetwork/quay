-- Per-event observability: free-form JSON column carrying the *why*
-- behind a transition that the (event_type, from_state, to_state)
-- triple alone can't express. Keeps the events row compact while
-- avoiding column proliferation across event types ("which kind of
-- no_progress?", "what was checked for spawn_window_no_evidence?",
-- "what intent triggered kill_intent_set?").
--
-- v1 is a TEXT column holding JSON by convention; the schema is
-- per-event-type and not enforced. NULL on rows that pre-date this
-- slice and on event-types this slice doesn't populate. Future
-- tickets layer typed accessors on top.

ALTER TABLE events ADD COLUMN event_data TEXT;
