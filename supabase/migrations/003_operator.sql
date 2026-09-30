-- =====================================================================
-- Hardband Photos — migration 003: operator (who did the work)
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once.
-- It only ADDS a column: no data is changed or deleted.
-- =====================================================================
--  operator = 'Name Number', e.g. 'Dusty 104' (the number tells two people with the same name apart;
--             the app treats the same number as the same operator)
--  operator = null -> photo saved before this existed, or no operator picked ("No operator" in the app)
--
-- It is part of the common photo record, so future record types (e.g. welding) inherit it.
-- Access: the existing table-level grants (select, insert, update to authenticated) and the Row Level Security
-- policies from setup.sql cover every column, including this new one, so nothing else needs to change.
-- Older copies of the app don't send "operator", and an upsert only updates the columns it sends, so they never
-- erase an operator set by a newer phone. Phones that saved an operator before this was run upload it afterwards.

alter table public.photos add column if not exists operator text;

create index if not exists photos_operator_idx on public.photos (operator);

-- Make the new column visible to the app's API right away.
notify pgrst, 'reload schema';

-- Quick check (shows up under Results): photos by operator (existing photos show as null = No operator).
select coalesce(operator, 'null (= No operator)') as operator, count(*) from public.photos group by 1 order by 1;
