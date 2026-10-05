-- =====================================================================
-- Hardband Photos — shared team library (Supabase)
-- Paste this whole file into the Supabase SQL Editor and click Run.
-- Safe to run more than once: it never drops tables or deletes data.
-- =====================================================================
--
-- Design notes
--  * One shared team login. Row Level Security lets ONLY signed-in users
--    (Postgres role "authenticated") read / add / change rows. Visitors who
--    only have the public (publishable/anon) key see nothing.
--  * Nothing is hard-deleted: the app never sends DELETE; a delete in the app
--    sets deleted_at (a "tombstone"). The authenticated role is not even
--    granted DELETE, and there are no DELETE policies (tables or storage).
--  * updated_at is stamped by the server (trigger) on every write and is what
--    phones use to ask "what changed since I last looked?".
--  * client_updated_at is the phone's edit time (ms since 1970). The trigger
--    ignores a write that is OLDER than what the server already has
--    (last-write-wins), so a phone that was offline for a week can't clobber
--    newer edits made by someone else.
--  * ids are text and come from the app (so photos taken offline keep their id).
--    The three starter entries use the same fixed ids the app seeds on every
--    phone (c_eog, r_six, s_45r3_450duo), so they line up automatically.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.customers (
  id                text primary key,
  name              text not null default '',
  merged_into       text,              -- set when this entry was merged into another one
  client_updated_at bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  updated_by        uuid,              -- auth user id (the shared team login)
  updated_by_name   text               -- optional "your name" typed on the phone
);

create table if not exists public.rigs (
  id                text primary key,
  name              text not null default '',
  notes             text not null default '',
  merged_into       text,
  client_updated_at bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  updated_by        uuid,
  updated_by_name   text
);

create table if not exists public.pipe_specs (
  id                text primary key,
  description       text not null default '',
  merged_into       text,
  client_updated_at bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  updated_by        uuid,
  updated_by_name   text
);

create table if not exists public.photos (
  id                text primary key,
  customer_id       text not null default '',
  rig_id            text not null default '',
  pipe_spec_id      text not null default '',
  serial_number     text not null default '',
  pipe_end          text not null default '',   -- 'Box' | 'Pin' | ''  (app field "end")
  band_number       text not null default '',   -- '1' | '2' | '3' | 'All' | ''
  notes             text not null default '',
  taken_at          timestamptz,                -- app field "createdAt" (when the photo was taken)
  date_source       text,                       -- exif | file | capture | manual
  added_at          timestamptz,                -- when it was saved in the app
  width             integer,
  height            integer,
  orig_name         text,
  image_path        text,                       -- e.g. photos/<id>.jpg in bucket "hardband"
  thumb_path        text,                       -- e.g. thumbs/<id>.jpg
  client_updated_at bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  updated_by        uuid,
  updated_by_name   text
);

-- ---------- migration 002 + 007: photo stage (Before / repair mids / After) ----------
-- 'pre' = Before hardband, 'repair'/'plasma'/'inlay' = Repair mid-stages, 'preheat' = Preheat temp photo, 'post' = After hardband,
-- null = older photo (app treats as 'post'). Same as 002_stage.sql + 007_repair_stages.sql.
alter table public.photos add column if not exists stage text;
alter table public.photos drop constraint if exists photos_stage_check;
alter table public.photos add constraint photos_stage_check
  check (stage is null or stage in ('pre', 'repair', 'plasma', 'inlay', 'post', 'preheat'));

-- ---------- migration 003: operator (who did the work) ----------
-- 'Name Number', e.g. 'Dusty 104'; null = no operator. Same as supabase/migrations/003_operator.sql.
alter table public.photos add column if not exists operator text;
create index if not exists photos_operator_idx on public.photos (operator);

-- ---------- migration 004: reject log (rejected wires per operator) ----------
-- Same as supabase/migrations/004_rejects.sql. One row per rejected wire; operator 'Name Number' (null = unassigned).
create table if not exists public.rejects (
  id                text primary key,
  operator          text,
  rejected_at       timestamptz not null default now(),
  rig_id            text not null default '',
  rig_name          text,
  serial_number     text not null default '',
  note              text not null default '',
  client_updated_at bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  created_by        uuid default auth.uid(),
  created_by_name   text,
  updated_by        uuid,
  updated_by_name   text
);
create index if not exists rejects_updated_at_idx  on public.rejects (updated_at, id);
create index if not exists rejects_operator_idx    on public.rejects (operator);
create index if not exists rejects_rejected_at_idx on public.rejects (rejected_at);

-- ---------- migration 005: work order # on rejects ----------
-- Optional "Work order #" from the Log rejected wire sheet; null = none. Same as supabase/migrations/005_reject_work_order.sql.
alter table public.rejects add column if not exists work_order text;

-- ---------- migration 006: work order # on photos ----------
-- Work order # from the Start inspection sheet; null = none (older photos). Same as supabase/migrations/006_photo_work_order.sql.
alter table public.photos add column if not exists work_order text;

-- ---------- indexes (phones pull "changed since" by updated_at) ----------
create index if not exists customers_updated_at_idx  on public.customers  (updated_at, id);
create index if not exists rigs_updated_at_idx       on public.rigs       (updated_at, id);
create index if not exists pipe_specs_updated_at_idx on public.pipe_specs (updated_at, id);
create index if not exists photos_updated_at_idx     on public.photos     (updated_at, id);
create index if not exists photos_rig_idx            on public.photos     (rig_id);
create index if not exists photos_customer_idx       on public.photos     (customer_id);
create index if not exists photos_serial_idx         on public.photos     (serial_number);
create index if not exists photos_taken_at_idx       on public.photos     (taken_at);

-- ---------- updated_at / last-write-wins trigger ----------
create or replace function public.hb_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    -- Last-write-wins: skip a write whose edit time is older than what we have.
    if coalesce(new.client_updated_at, 0) < coalesce(old.client_updated_at, 0) then
      return null;
    end if;
    new.created_at := old.created_at;          -- never rewrite history
  end if;
  new.updated_at := clock_timestamp();         -- server time; drives "changed since" sync
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['customers', 'rigs', 'pipe_specs', 'photos', 'rejects'] loop
    execute format('drop trigger if exists hb_before_write on public.%I', t);
    execute format('create trigger hb_before_write before insert or update on public.%I
                    for each row execute function public.hb_before_write()', t);
  end loop;
end $$;

-- A metadata edit from a phone that never had the image file must not blank out the stored file paths.
create or replace function public.hb_photos_keep_paths()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.image_path := coalesce(new.image_path, old.image_path);
  new.thumb_path := coalesce(new.thumb_path, old.thumb_path);
  return new;
end;
$$;
drop trigger if exists hb_photos_keep_paths on public.photos;
create trigger hb_photos_keep_paths before update on public.photos
  for each row execute function public.hb_photos_keep_paths();   -- runs after hb_before_write (alphabetical)

-- Rejects: keep who first logged it, whatever later edits send.
create or replace function public.hb_rejects_keep_creator()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_by := old.created_by;
  new.created_by_name := coalesce(old.created_by_name, new.created_by_name);
  return new;
end;
$$;
drop trigger if exists hb_rejects_keep_creator on public.rejects;
create trigger hb_rejects_keep_creator before update on public.rejects
  for each row execute function public.hb_rejects_keep_creator();

-- ---------- grants + Row Level Security (signed-in team only) ----------
do $$
declare t text;
begin
  foreach t in array array['customers', 'rigs', 'pipe_specs', 'photos', 'rejects'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke delete, truncate on table public.%I from authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);

    execute format('drop policy if exists "team can read" on public.%I', t);
    execute format('drop policy if exists "team can add" on public.%I', t);
    execute format('drop policy if exists "team can change" on public.%I', t);
    execute format('create policy "team can read" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "team can add" on public.%I for insert to authenticated with check (true)', t);
    execute format('create policy "team can change" on public.%I for update to authenticated using (true) with check (true)', t);
    -- No delete policy on purpose.
  end loop;
end $$;

-- ---------- private storage bucket for photos + thumbnails ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hardband', 'hardband', false, 20971520, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false;

drop policy if exists "hardband team can read"   on storage.objects;
drop policy if exists "hardband team can upload" on storage.objects;
drop policy if exists "hardband team can update" on storage.objects;
create policy "hardband team can read"   on storage.objects for select to authenticated using (bucket_id = 'hardband');
create policy "hardband team can upload" on storage.objects for insert to authenticated with check (bucket_id = 'hardband');
-- update is needed so a retried upload (upsert) of the same file succeeds
create policy "hardband team can update" on storage.objects for update to authenticated
  using (bucket_id = 'hardband') with check (bucket_id = 'hardband');
-- No delete policy on purpose.

-- ---------- starter entries (same fixed ids the app seeds on each phone) ----------
insert into public.customers (id, name, client_updated_at)
values ('c_eog', 'EOG', 0)
on conflict (id) do nothing;

insert into public.rigs (id, name, notes, client_updated_at)
values ('r_six', 'Six', 'Possibly H&P 246 — confirm and rename', 0)
on conflict (id) do nothing;

insert into public.pipe_specs (id, description, client_updated_at)
values ('s_45r3_450duo', '4-1/2" Range 3, 450 Duo', 0)
on conflict (id) do nothing;

-- Make new/changed columns visible to the app's API right away.
notify pgrst, 'reload schema';

-- Quick check (shows up under Results):
select 'customers' as table_name, count(*) from public.customers
union all select 'rigs', count(*) from public.rigs
union all select 'pipe_specs', count(*) from public.pipe_specs
union all select 'photos', count(*) from public.photos
union all select 'rejects', count(*) from public.rejects;
