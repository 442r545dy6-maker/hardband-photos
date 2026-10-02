-- Hardband Photos migration 005: work order number on the reject log
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once. It only adds one column.
-- Needs the rejects table from 004_rejects.sql (run that one first if you have not yet).
-- rejects.work_order = the optional Work order # typed under Add details in the Log rejected wire sheet (null = none).
-- The existing rejects grants and row level security cover the new column. Nothing else needs to change.
-- Phones keep a work order saved before this was run and upload it by themselves afterwards.
alter table public.rejects add column if not exists work_order text;
