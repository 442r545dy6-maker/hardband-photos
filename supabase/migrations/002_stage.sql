-- =====================================================================
-- Hardband Photos — migration 002: photo stage (Before / After hardband)
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once.
-- It only ADDS a column: no data is changed or deleted.
-- =====================================================================
--  stage = 'pre'  -> photo taken during inspection, BEFORE hardbanding
--  stage = 'post' -> photo taken AFTER hardbanding
--  stage = null   -> photo saved before this existed; the app treats it as 'post'
--
-- Access: the existing table-level grants (select, insert, update to authenticated) and the
-- Row Level Security policies from setup.sql cover every column, including this new one,
-- so nothing else needs to change. anon still has no access; still no DELETE.
-- Older copies of the app that don't know about "stage" simply don't send it, and an upsert
-- only updates the columns it sends, so they never erase a stage set by a newer phone.

alter table public.photos add column if not exists stage text;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'photos_stage_check' and conrelid = 'public.photos'::regclass) then
    alter table public.photos add constraint photos_stage_check check (stage is null or stage in ('pre', 'post'));
  end if;
end $$;

-- Make the new column visible to the app's API right away.
notify pgrst, 'reload schema';

-- Quick check (shows up under Results): photos by stage (existing photos show as null = After).
select coalesce(stage, 'null (= post)') as stage, count(*) from public.photos group by 1 order by 1;
