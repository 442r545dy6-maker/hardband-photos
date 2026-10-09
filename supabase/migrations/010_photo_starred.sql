-- Hardband Photos migration 010: photo stars
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once. It only adds one column.
-- photos.starred = true when someone starred the photo (null = not starred). Unstar sets it back to null.
-- The existing photos grants and row level security cover the new column.
-- Phones keep stars until this is run, then upload them by themselves within a few minutes.
--
-- iPhone one-liner (no quote characters):
-- alter table public.photos add column if not exists starred boolean;

alter table public.photos add column if not exists starred boolean;
