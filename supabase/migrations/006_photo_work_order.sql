-- Hardband Photos migration 006: work order number on photos (entered on the Start inspection sheet)
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once. It only adds one column.
-- Customer, rig and pipe size already have columns on photos (customer_id, rig_id, pipe_spec_id).
-- The existing photos grants and row level security cover the new column. Nothing else needs to change.
-- Phones keep the work order until this is run, then upload it by themselves within a few minutes.
alter table public.photos add column if not exists work_order text;
