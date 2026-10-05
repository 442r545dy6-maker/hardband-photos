-- =====================================================================
-- Hardband Photos — migration 007: repair mid-stages + preheat on photos.stage
-- Paste into the Supabase SQL Editor and click Run. Safe to run more than once.
-- It only widens the check constraint: no data is changed or deleted.
-- =====================================================================
--  stage = 'pre'     -> Before hardband (inspection)
--  stage = 'repair'  -> Repair                                          [Repair only]
--  stage = 'plasma'  -> Plasma cut                                      [Repair only]
--  stage = 'inlay'   -> Inlay                                           [Repair only]
--  stage = 'post'    -> After hardband
--  stage = 'preheat' -> Preheat temp photo (temporary stand-in for Bluetooth thermocouple)
--  stage = null      -> older photo; the app treats it as 'post'
--
-- Every hardbanded joint: Before → After → Preheat.
-- Repair joints: Before → Repair → Plasma cut → Inlay → After → Preheat.
--
-- iPhone one-liner (ASCII single quotes only — smart quotes break SQL):

-- alter table public.photos drop constraint if exists photos_stage_check; alter table public.photos add constraint photos_stage_check check (stage is null or stage in ('pre', 'repair', 'plasma', 'inlay', 'post', 'preheat')); notify pgrst, 'reload schema';

alter table public.photos drop constraint if exists photos_stage_check;
alter table public.photos add constraint photos_stage_check
  check (stage is null or stage in ('pre', 'repair', 'plasma', 'inlay', 'post', 'preheat'));

notify pgrst, 'reload schema';

select coalesce(stage, 'null (= post)') as stage, count(*) from public.photos group by 1 order by 1;
