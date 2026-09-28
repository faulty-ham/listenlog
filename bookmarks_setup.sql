-- Run this once in Supabase (Database → SQL Editor → New query) to enable
-- the Bookmarks feature. Safe to re-run — every statement is idempotent.

create table if not exists bookmarks (
  id         text primary key,               -- client-generated id, same style as albums.id
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  album_ids  jsonb not null default '[]'::jsonb,  -- array of album id strings
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bookmarks enable row level security;

drop policy if exists "Users manage own bookmarks" on bookmarks;
create policy "Users manage own bookmarks" on bookmarks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
