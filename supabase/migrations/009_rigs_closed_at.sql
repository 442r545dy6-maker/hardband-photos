-- Hardband Photos migration 009: Complete job (a job = a rig folder)
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once. It only adds one column.
-- rigs.closed_at = when the job was marked complete (null = open job). Reopen sets it back to null.
-- The existing rigs grants and row level security (team can change: update to authenticated) cover the new column.
-- Phones keep completed jobs until this is run, then upload them by themselves within a few minutes.
--
-- iPhone one-liner (no quote characters):
-- alter table public.rigs add column if not exists closed_at timestamptz;

alter table public.rigs add column if not exists closed_at timestamptz;
