-- =====================================================================
-- Hardband Photos — migration 005: WORK ORDER # on the reject log
-- Paste this whole file into the Supabase SQL Editor and click Run. Safe to run more than once.
-- It only ADDS one column: no data is changed or deleted.
-- Needs the rejects table from 004_rejects.sql (run that one first if you haven't yet).
-- =====================================================================
--  public.rejects.work_order   optional "Work order #" typed under "Add details" in the app's
--                              ⛔ Log rejected wire sheet (null = none entered, and for older rejects)
--
-- Access: the existing table-level grants on public.rejects (select, insert, update to authenticated; nothing for
-- anon) and its Row Level Security policies from 004_rejects.sql / setup.sql cover every column, including this new
-- one, so nothing else needs to change. Older copies of the app don't send "work_order", and an upsert only updates
-- the columns it sends, so they never erase a work order saved by a newer phone. Phones that saved a work order
-- before this was run keep it and upload it by themselves afterwards.

alter table public.rejects add column if not exists work_order text;

-- Make the new column visible to the app's API right away.
notify pgrst, 'reload schema';
