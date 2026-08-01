-- ReelLipi initial schema.
-- Users only ever touch their own rows; the worker uses the service role, which
-- bypasses RLS entirely.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'creator', 'pro', 'studio')),
  reels_used_this_period int not null default 0,
  period_start timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- projects
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text,
  status text not null default 'uploaded'
    check (status in ('uploaded','transcribing','styling','ready_to_render','rendering','done','failed')),
  source_path text,
  audio_path text,
  output_path text,
  lang_mode text not null default 'translit'
    check (lang_mode in ('translit','codemix','transcribe','translate','verbatim')),
  language_code text default 'unknown',
  style_preset text default 'karaoke_bold',
  duration_seconds numeric,
  -- Set when Sarvam gave no usable word timings and timing was derived by
  -- distribution. Surfaced in the UI so the user knows karaoke is approximate.
  timing_approximate boolean not null default true,
  ig_caption text,
  hashtags text[],
  error text,
  progress int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists projects_user_created_idx on projects (user_id, created_at desc);
create index if not exists projects_expires_idx on projects (expires_at) where expires_at is not null;

-- ---------------------------------------------------------------- cues
create table if not exists cues (
  id bigserial primary key,
  project_id uuid not null references projects on delete cascade,
  idx int not null,
  start_s numeric not null,
  end_s numeric not null,
  text text not null,
  -- [{w,start,end}] driving the karaoke highlight.
  words jsonb,
  highlight text[],
  unique (project_id, idx)
);
create index if not exists cues_project_idx on cues (project_id, idx);

-- ---------------------------------------------------------------- subscriptions
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  razorpay_subscription_id text unique,
  plan text,
  status text,
  current_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on subscriptions (user_id);

-- ---------------------------------------------------------------- triggers
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch on projects;
create trigger projects_touch before update on projects
  for each row execute function touch_updated_at();

drop trigger if exists subscriptions_touch on subscriptions;
create trigger subscriptions_touch before update on subscriptions
  for each row execute function touch_updated_at();

-- A profile must exist for quota checks the moment a user signs up.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- RLS
alter table profiles enable row level security;
alter table projects enable row level security;
alter table cues enable row level security;
alter table subscriptions enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own projects" on projects;
create policy "own projects" on projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cues are reachable only through a project the caller owns.
drop policy if exists "own cues" on cues;
create policy "own cues" on cues
  for all using (
    exists (select 1 from projects p where p.id = cues.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from projects p where p.id = cues.project_id and p.user_id = auth.uid())
  );

-- Subscriptions are written by the Razorpay webhook (service role) only.
drop policy if exists "read own subscriptions" on subscriptions;
create policy "read own subscriptions" on subscriptions
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public)
values ('raw', 'raw', false), ('out', 'out', false)
on conflict (id) do nothing;

-- Objects are namespaced as {user_id}/{project_id}.{ext}, so the first path
-- segment is the ownership check.
drop policy if exists "own raw objects" on storage.objects;
create policy "own raw objects" on storage.objects
  for all using (bucket_id = 'raw' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'raw' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "read own output objects" on storage.objects;
create policy "read own output objects" on storage.objects
  for select using (bucket_id = 'out' and (storage.foldername(name))[1] = auth.uid()::text);
