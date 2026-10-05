-- ============================================================
-- 001_init_profiles.sql
--  · uuid-ossp + pgcrypto extensions
--  · updated_at trigger (reused by all later tables)
--  · profiles (mirror of auth.users + user-editable fields)
--  · user_preferences
--  · RLS + policies on both
-- ============================================================

create extension if not exists "uuid-ossp" with schema public;
create extension if not exists pgcrypto with schema public;

-- ------------------------------------------------------------
-- updated_at trigger fn
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  name           text null,
  display_name   text null,
  avatar_url     text null,
  role           text not null default 'user' check (role in ('user','creator','admin')),
  timezone       text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_self" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_insert_self" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- auto-create profile row on auth.users.insert
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, display_name, avatar_url, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'name',
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce((new.raw_user_meta_data ->> 'role')::text, 'user')::text
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- user_preferences
-- ------------------------------------------------------------
create table if not exists public.user_preferences (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  email_notifications  boolean not null default true,
  marketing_emails     boolean not null default false,
  weekly_digest        boolean not null default true,
  ai_provider_pref     text null check (ai_provider_pref in ('stub','openai','anthropic','gemini') or ai_provider_pref is null),
  default_difficulty   text not null default 'Mixed' check (default_difficulty in ('Easy','Medium','Hard','Mixed')),
  ui_theme             text not null default 'earth' check (ui_theme in ('earth','ocean','sunset','forest','lavender')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

create policy "user_prefs_own" on public.user_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_user_prefs_updated_at on public.user_preferences;
create trigger trg_user_prefs_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

-- Seed default preferences for a profile right when profile is created
create or replace function public.seed_user_preferences()
returns trigger
language plpgsql
as $$
begin
  insert into public.user_preferences (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_profile_seed_prefs on public.profiles;
create trigger trg_profile_seed_prefs
after insert on public.profiles
for each row execute function public.seed_user_preferences();
