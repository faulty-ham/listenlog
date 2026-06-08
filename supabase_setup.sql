-- Run this in your Supabase SQL Editor (Database → SQL Editor → New query)

-- Table: one row per user, stores their full library as JSON
create table if not exists listenlog_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  albums     jsonb not null default '[]',
  originals  jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Row Level Security: users can only see and modify their own row
alter table listenlog_data enable row level security;

drop policy if exists "Users manage own data" on listenlog_data;
create policy "Users manage own data" on listenlog_data
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
