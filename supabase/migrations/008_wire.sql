-- Hardband Photos migration 008: hardband wire on photos (Wire field on the Start new job sheet and photo form)
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once. It only adds one column.
-- photos.wire = the wire used on the job, e.g. 'Duraband NC', 'Arnco 300XT' or a custom name (null = none picked).
-- The existing photos grants and row level security cover the new column. Nothing else needs to change.
-- Phones keep the wire until this is run, then upload it by themselves within a few minutes.
--
-- iPhone one-liner (ASCII single quotes only):
-- alter table public.photos add column if not exists wire text; notify pgrst, 'reload schema';

alter table public.photos add column if not exists wire text;

notify pgrst, 'reload schema';
