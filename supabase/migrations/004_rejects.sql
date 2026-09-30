-- =====================================================================
-- Hardband Photos — migration 004: REJECT LOG (rejected wires per operator)
--                   + migration 003 (photos.operator) included, so this ONE file is all you need to run.
-- Paste this whole file into the Supabase SQL Editor and click Run. Safe to run more than once.
-- It only ADDS things (a column, a table, indexes, access rules): no data is changed or deleted.
-- =====================================================================
--  public.rejects: one row per rejected wire, logged from the app's home screen (⛔ Log rejected wire).
--    operator     'Name Number', e.g. 'Dusty 104' (the app counts rejects per operator by the NUMBER;
--                 null = unassigned)
--    rejected_at  when it was logged (the phone's clock; the app shows it in the phone's local time)
--    rig_id / rig_name / serial_number / note   optional extras (blank when skipped)
--    deleted_at   set when someone deletes a mistaken reject in the app (soft delete, like photos)
--    created_by   the signed-in team login (set by the server); created_by_name = "your name" typed on that phone
--
-- Access is the same as the photos table: ONLY the signed-in team (role "authenticated") can read / add / change
-- rows; visitors with just the public key see nothing; nobody can hard-delete (no DELETE grant or policy).
-- Phones that logged rejects before this was run keep them and upload them automatically afterwards.

-- ---------- 003: operator on photos (same as supabase/migrations/003_operator.sql) ----------
alter table public.photos add column if not exists operator text;
create index if not exists photos_operator_idx on public.photos (operator);

-- ---------- 004: the rejects table ----------
create table if not exists public.rejects (
  id                text primary key,                 -- made by the app (so rejects logged offline keep their id)
  operator          text,
  rejected_at       timestamptz not null default now(),
  rig_id            text not null default '',
  rig_name          text,
  serial_number     text not null default '',
  note              text not null default '',
  client_updated_at bigint not null default 0,        -- the phone's edit time (last write wins)
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

-- Same server-side rules as every other table (identical to setup.sql): server-stamped updated_at,
-- and an older edit never overwrites a newer one.
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

drop trigger if exists hb_before_write on public.rejects;
create trigger hb_before_write before insert or update on public.rejects
  for each row execute function public.hb_before_write();

-- Keep who first logged it, whatever later edits send.
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

-- ---------- access: signed-in team only (same as photos in setup.sql) ----------
alter table public.rejects enable row level security;
revoke all on table public.rejects from anon;
revoke delete, truncate on table public.rejects from authenticated;
grant select, insert, update on table public.rejects to authenticated;

drop policy if exists "team can read"   on public.rejects;
drop policy if exists "team can add"    on public.rejects;
drop policy if exists "team can change" on public.rejects;
create policy "team can read"   on public.rejects for select to authenticated using (true);
create policy "team can add"    on public.rejects for insert to authenticated with check (true);
create policy "team can change" on public.rejects for update to authenticated using (true) with check (true);
-- No delete policy on purpose.

-- Make the new column and table visible to the app's API right away.
notify pgrst, 'reload schema';

-- Quick check (shows up under Results): rejects per operator (0 rows right after the first run is normal),
-- and a count of photos that already have an operator (proves the 003 column exists).
select coalesce(operator, 'Unassigned') as operator, count(*) as rejects, max(rejected_at) as last_reject
from public.rejects where deleted_at is null group by 1
union all
select '(photos with an operator)', count(*), null from public.photos where operator is not null
order by 1;
