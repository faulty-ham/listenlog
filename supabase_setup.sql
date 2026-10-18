-- ListenLog — Supabase setup / migration for the `albums` table.
-- Run in Supabase → SQL Editor → New query. Safe to re-run: every statement
-- is idempotent, and it never deletes data.
--
-- (This file used to describe an old `listenlog_data` table that the app no
-- longer uses. The bookmarks table lives in bookmarks_setup.sql.)

-- 1. Table (no-op if it already exists)
create table if not exists public.albums (
  id              text primary key,                 -- client-generated id
  user_id         uuid not null references auth.users(id) on delete cascade,
  artist          text not null default '',
  album           text not null default '',
  date            text,                             -- 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'
  rating          numeric,                          -- 0.5 – 5
  notes           text,
  art_url         text,
  art_fallback    text,
  mbid            text,
  release_type    text,
  want_to_listen  boolean not null default false,
  hard_to_find    boolean not null default false,
  in_plex_library boolean not null default false,
  unmatched       boolean not null default false,
  added           bigint,                           -- ms timestamp
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz                       -- soft delete
);

-- 2. Row Level Security: each account can only read/write its own rows
alter table public.albums enable row level security;
drop policy if exists "Users manage own albums" on public.albums;
create policy "Users manage own albums" on public.albums
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. Server-side updated_at. The app syncs incrementally by updated_at; if each
--    device stamps its own clock, a device whose clock is behind can write rows
--    that other devices never fetch. The database clock is the single source.
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists albums_set_updated_at on public.albums;
create trigger albums_set_updated_at
  before insert or update on public.albums
  for each row execute function public.set_updated_at();

do $$ begin
  if to_regclass('public.bookmarks') is not null then
    drop trigger if exists bookmarks_set_updated_at on public.bookmarks;
    create trigger bookmarks_set_updated_at
      before insert or update on public.bookmarks
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 4. Indexes for the app's two sync queries
create index if not exists albums_user_updated_idx on public.albums (user_id, updated_at);
create index if not exists albums_user_live_idx    on public.albums (user_id, id) where deleted_at is null;

-- 5. Check: every policy on albums should compare auth.uid() to user_id.
--    If you see any other policy listed here, review or drop it.
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'albums';
